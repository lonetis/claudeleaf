/**
 * Overleaf REST endpoints: listing projects (account-level) and project-tree mutations
 * (create/delete/rename docs & folders). These need the session cookie plus the
 * `ol-csrfToken` scraped from a page. Transient 5xx responses are retried.
 */

import type { Config } from "./config.js";
import { cookieHeader, type SessionManager } from "./auth.js";
import { ClaudeleafError } from "./errors.js";
import type { ProjectSummary } from "./types.js";
import { sleep } from "./util.js";

const CSRF_RE = /name="ol-csrfToken"\s+content="([^"]+)"/;
type EntityType = "doc" | "file" | "folder";

/** List every project the signed-in account can access (via the dashboard JSON API). */
export async function listProjects(
  config: Config,
  sessions: SessionManager,
): Promise<ProjectSummary[]> {
  const ch = cookieHeader(await sessions.ensureValid());
  const timeout = () => AbortSignal.timeout(config.requestTimeout * 1000);
  const dash = await fetch(`${config.baseUrl}/project`, {
    headers: { Cookie: ch, "User-Agent": config.userAgent },
    signal: timeout(),
  });
  const m = CSRF_RE.exec(await dash.text());
  if (!m) throw new ClaudeleafError("could not load the project dashboard (session may be invalid)");
  const res = await fetch(`${config.baseUrl}/api/project`, {
    method: "POST",
    headers: {
      Cookie: ch,
      "User-Agent": config.userAgent,
      "X-CSRF-Token": m[1],
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
    signal: timeout(),
  });
  if (res.status !== 200) throw new ClaudeleafError(`listing projects failed (${res.status})`);
  const data = (await res.json()) as { projects?: RawProject[] };
  return (data.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    accessLevel: p.accessLevel,
    lastUpdated: p.lastUpdated,
    owner: p.owner?.email,
    archived: Boolean(p.archived),
    trashed: Boolean(p.trashed),
  }));
}

interface RawProject {
  id: string;
  name: string;
  accessLevel?: string;
  lastUpdated?: string;
  archived?: boolean;
  trashed?: boolean;
  owner?: { email?: string };
}

export class RestClient {
  private csrf: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionManager,
    private readonly projectId: string,
  ) {}

  private async cookieHdr(forceRefresh: boolean): Promise<string> {
    const cookies = forceRefresh ? await this.sessions.ensureValid() : this.sessions.cookies();
    return cookieHeader(cookies);
  }

  private async ensureCsrf(forceRefresh = false): Promise<string> {
    if (this.csrf && !forceRefresh) return this.csrf;
    const ch = await this.cookieHdr(forceRefresh);
    const res = await fetch(this.config.projectUrl(this.projectId), {
      headers: { Cookie: ch, "User-Agent": this.config.userAgent },
      signal: AbortSignal.timeout(this.config.requestTimeout * 1000),
    });
    const m = CSRF_RE.exec(await res.text());
    if (!m) {
      if (!forceRefresh) return this.ensureCsrf(true);
      throw new ClaudeleafError("could not obtain CSRF token (session may be invalid)");
    }
    this.csrf = m[1];
    return this.csrf;
  }

  private async request(
    method: "POST" | "DELETE",
    path: string,
    payload?: object,
    timeoutMs = this.config.requestTimeout * 1000,
  ): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;
    let last: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const refresh =
        attempt > 0 && last !== undefined && (last.status === 401 || last.status === 403);
      const ch = await this.cookieHdr(refresh);
      const headers: Record<string, string> = {
        Cookie: ch,
        "User-Agent": this.config.userAgent,
        Referer: this.config.projectUrl(this.projectId),
        "X-CSRF-Token": await this.ensureCsrf(refresh),
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
          signal: AbortSignal.timeout(timeoutMs), // a stalled socket aborts and retries
        });
      } catch (e) {
        if (attempt === 3) throw new ClaudeleafError(`${method} ${path} failed: ${String(e)}`);
        await sleep((attempt + 1) * 500);
        continue;
      }
      last = res;
      if (res.status === 200 || res.status === 204) {
        try {
          return await res.json();
        } catch {
          return {};
        }
      }
      if (res.status === 401 || res.status === 403) {
        this.csrf = null; // token/session stale; force a refresh and retry
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 3) {
        await sleep((attempt + 1) * 500); // transient; back off and retry
        continue;
      }
      break;
    }
    const body = last ? (await last.text()).slice(0, 200) : "";
    throw new ClaudeleafError(`${method} ${path} failed (${last?.status ?? "?"}): ${body}`);
  }

  createDoc(name: string, parentFolderId: string): Promise<{ _id?: string }> {
    return this.request("POST", `/project/${this.projectId}/doc`, {
      name,
      parent_folder_id: parentFolderId,
    }) as Promise<{ _id?: string }>;
  }

  createFolder(name: string, parentFolderId: string): Promise<{ _id?: string }> {
    return this.request("POST", `/project/${this.projectId}/folder`, {
      name,
      parent_folder_id: parentFolderId,
    }) as Promise<{ _id?: string }>;
  }

  async deleteEntity(entityId: string, type: EntityType): Promise<void> {
    await this.request("DELETE", `/project/${this.projectId}/${type}/${entityId}`);
  }

  async renameEntity(entityId: string, type: EntityType, name: string): Promise<void> {
    await this.request("POST", `/project/${this.projectId}/${type}/${entityId}/rename`, { name });
  }

  /** Trigger a LaTeX compile and return Overleaf's raw response (status + output files). */
  async compile(opts: { draft?: boolean; stopOnFirstError?: boolean }): Promise<RawCompileResponse> {
    return (await this.request(
      "POST",
      `/project/${this.projectId}/compile?auto_compile=true`,
      {
        rootDoc_id: null, // Overleaf compiles the project's configured root document
        draft: opts.draft ?? false,
        check: "silent",
        incrementalCompilesEnabled: true,
        stopOnFirstError: opts.stopOnFirstError ?? false,
      },
      this.config.compileTimeout * 1000, // compiling can take far longer than a normal request
    )) as RawCompileResponse;
  }

  /** GET an output file (e.g. the log) as text. `path` is server-relative, incl. query. */
  async fetchText(path: string): Promise<string> {
    const ch = await this.cookieHdr(false);
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      headers: {
        Cookie: ch,
        "User-Agent": this.config.userAgent,
        Referer: this.config.projectUrl(this.projectId),
      },
      signal: AbortSignal.timeout(this.config.requestTimeout * 1000),
    });
    if (!res.ok) throw new ClaudeleafError(`fetching ${path} failed (${res.status})`);
    return res.text();
  }
}

interface RawOutputFile {
  path: string;
  type?: string;
  build?: string;
  url: string;
}

export interface RawCompileResponse {
  status: string;
  outputFiles?: RawOutputFile[];
  clsiServerId?: string;
  compileGroup?: string;
  outputUrlPrefix?: string;
}
