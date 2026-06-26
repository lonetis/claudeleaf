/**
 * Account-scoped Overleaf SDK.
 *
 * {@link OverleafClient} is tied to an account, not a single project: it lists every
 * project the account can access and edits any of them through one instance. Each project
 * is backed by a lazily-created, cached {@link ProjectSession}.
 *
 *     const client = new OverleafClient();
 *     for (const p of await client.listProjects()) console.log(p.id, p.name);
 *     await client.append("My Paper", "main.tex", "\\section{New}\n");
 *
 * Run `claudeleaf login` once to sign in; the session is cached and reused.
 */

import { SessionManager } from "./auth.js";
import { Config, parseProjectId } from "./config.js";
import type { Document } from "./document.js";
import { ProjectNotFoundError } from "./errors.js";
import { listProjects as restListProjects } from "./rest.js";
import { ProjectSession } from "./session.js";
import type {
  CompileOptions,
  CompileResult,
  ConnectedUser,
  Cookies,
  Entity,
  ProjectInfo,
  ProjectSummary,
} from "./types.js";
import { Mutex } from "./util.js";

export class OverleafClient {
  private readonly config: Config;
  private readonly sessions: SessionManager;
  private readonly projects = new Map<string, ProjectSession>();
  private readonly connecting = new Map<string, Promise<ProjectSession>>();
  private readonly resolveGuard = new Mutex();
  private projectList: ProjectSummary[] | null = null;

  constructor(config?: Config) {
    this.config = config ?? Config.fromEnv();
    this.sessions = new SessionManager(this.config);
  }

  // -- account ----------------------------------------------------------
  /** Sign in interactively via a browser and cache the session. */
  login(): Promise<Cookies> {
    return this.sessions.login();
  }

  async isLoggedIn(): Promise<boolean> {
    try {
      await this.sessions.ensureValid();
      return true;
    } catch {
      return false;
    }
  }

  /** List every accessible project (cached; pass `refresh=false` to reuse the cache). */
  async listProjects(refresh = true): Promise<ProjectSummary[]> {
    if (refresh || this.projectList === null) {
      this.projectList = await restListProjects(this.config, this.sessions);
    }
    return this.projectList;
  }

  // -- project access ---------------------------------------------------
  /** Return the connected, cached session for a project, by id or name. */
  async project(project: string): Promise<ProjectSession> {
    // Resolve the id (may fetch the project list) under a brief guard to avoid duplicate
    // list fetches; the connect itself is per-id so unrelated projects don't block.
    const [id, name] = await this.resolveGuard.runExclusive(() => this.resolveProject(project));
    let session = this.projects.get(id);
    if (session && !session.isAlive) {
      try {
        session.close();
      } catch {
        /* ignore */
      }
      this.projects.delete(id);
      session = undefined;
    }
    if (session) return session;

    let pending = this.connecting.get(id);
    if (!pending) {
      pending = (async () => {
        try {
          const s = await new ProjectSession(this.config, this.sessions, id, name).connect();
          this.projects.set(id, s);
          return s;
        } finally {
          this.connecting.delete(id);
        }
      })();
      this.connecting.set(id, pending);
    }
    return pending;
  }

  private async resolveProject(project: string): Promise<[string, string | undefined]> {
    const id = parseProjectId(project);
    if (id) return [id, undefined];
    const ref = project.trim();
    const match = (list: ProjectSummary[]): ProjectSummary[] => {
      const exact = list.filter((p) => p.name === ref);
      return exact.length ? exact : list.filter((p) => (p.name ?? "").toLowerCase() === ref.toLowerCase());
    };
    const wasFresh = this.projectList === null;
    let list = await this.listProjects(wasFresh);
    let matches = match(list);
    if (matches.length === 0 && !wasFresh) {
      // The cached list may be stale (project created/renamed); refresh once and retry.
      list = await this.listProjects(true);
      matches = match(list);
    }
    if (matches.length === 0) {
      const names = list
        .map((p) => p.name)
        .sort()
        .join(", ");
      throw new ProjectNotFoundError(`no project named ${project} (available: ${names || "none"})`);
    }
    if (matches.length > 1) {
      throw new ProjectNotFoundError(
        `${project} is ambiguous - ${matches.length} projects share that name; use the project id`,
      );
    }
    return [matches[0].id, matches[0].name];
  }

  close(): void {
    for (const session of this.projects.values()) {
      try {
        session.close();
      } catch {
        /* ignore */
      }
    }
    this.projects.clear();
  }

  // -- metadata ---------------------------------------------------------
  async projectInfo(project: string): Promise<ProjectInfo> {
    return (await this.project(project)).projectInfo();
  }

  async listDocuments(project: string, includeFiles = false): Promise<Entity[]> {
    return (await this.project(project)).listDocuments(includeFiles);
  }

  // -- reading ----------------------------------------------------------
  async readDocument(project: string, path: string): Promise<string> {
    return (await this.project(project)).readDocument(path);
  }

  async getLines(project: string, path: string): Promise<string[]> {
    return (await this.project(project)).getLines(path);
  }

  async documentVersion(project: string, path: string): Promise<number> {
    return (await this.project(project)).documentVersion(path);
  }

  async search(project: string, path: string, query: string) {
    return (await this.project(project)).search(path, query);
  }

  // -- editing ----------------------------------------------------------
  async insertAt(project: string, path: string, offset: number, text: string): Promise<Document> {
    return (await this.project(project)).insertAt(path, offset, text);
  }

  async insert(project: string, path: string, line: number, column: number, text: string): Promise<Document> {
    return (await this.project(project)).insert(path, line, column, text);
  }

  async append(project: string, path: string, text: string): Promise<Document> {
    return (await this.project(project)).append(path, text);
  }

  async deleteRange(project: string, path: string, start: number, end: number): Promise<Document> {
    return (await this.project(project)).deleteRange(path, start, end);
  }

  async replaceRange(project: string, path: string, start: number, end: number, text: string): Promise<Document> {
    return (await this.project(project)).replaceRange(path, start, end, text);
  }

  async replaceText(project: string, path: string, oldStr: string, newStr: string, count = 0): Promise<number> {
    return (await this.project(project)).replaceText(path, oldStr, newStr, count);
  }

  async setText(project: string, path: string, newText: string): Promise<Document> {
    return (await this.project(project)).setText(path, newText);
  }

  async deleteLines(project: string, path: string, startLine: number, endLine: number): Promise<Document> {
    return (await this.project(project)).deleteLines(path, startLine, endLine);
  }

  async resync(project: string, path: string): Promise<Document> {
    return (await this.project(project)).resync(path);
  }

  // -- presence & structure ---------------------------------------------
  async setCursor(project: string, path: string, line: number, column: number): Promise<void> {
    await (await this.project(project)).setCursor(path, line, column);
  }

  async getConnectedUsers(project: string): Promise<ConnectedUser[]> {
    return (await this.project(project)).getConnectedUsers();
  }

  async createDocument(project: string, name: string, folder?: string): Promise<{ _id?: string }> {
    return (await this.project(project)).createDocument(name, folder);
  }

  async createFolder(project: string, name: string, folder?: string): Promise<{ _id?: string }> {
    return (await this.project(project)).createFolder(name, folder);
  }

  async deleteDocument(project: string, path: string): Promise<void> {
    await (await this.project(project)).deleteDocument(path);
  }

  async renameDocument(project: string, path: string, newName: string): Promise<void> {
    await (await this.project(project)).renameDocument(path, newName);
  }

  // -- compile ----------------------------------------------------------
  /** Recompile a project's root document and return the status plus the parsed log. */
  async compile(project: string, opts?: CompileOptions): Promise<CompileResult> {
    return (await this.project(project)).compile(opts);
  }
}
