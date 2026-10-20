/**
 * Per-project session: the realtime connection, project tree, and editing for one project.
 *
 * The account-level {@link OverleafClient} creates and caches one of these per project.
 *
 * Reliability model (single-threaded / event-driven):
 * - Edits are serialized per document with a {@link Mutex}; the op-builder closure is
 *   re-run against the freshly-synced text on each attempt, so an edit recovers across a
 *   reconnect.
 * - A fresh connection re-joins the *project* but not the docs, so each Document records
 *   the connection generation it was joined on and is re-joined before an edit/read.
 * - Edits are confirmed by the op-less `otUpdateApplied` echo (resolved in the event
 *   handler), not just sent - no silent loss. A not-transmitted frame is retried; an
 *   ambiguous mid-flight drop resyncs and raises rather than risk a duplicate.
 * - Remote ops and resyncs run through the same per-doc mutex (queued behind any
 *   in-flight edit).
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { SessionManager } from "./auth.js";
import type { Config } from "./config.js";
import { Document } from "./document.js";
import {
  ClaudeleafError,
  ConnectionError,
  DocumentNotFoundError,
  EditConflictError,
  EditError,
  NotTransmittedError,
} from "./errors.js";
import { parseLatexLog } from "./logParser.js";
import * as ot from "./ot.js";
import { RealtimeConnection } from "./realtime.js";
import { RestClient, type RawThread } from "./rest.js";
import type {
  Comment,
  CompileOptions,
  CompileResult,
  ConnectedUser,
  Entity,
  OutputFile,
  ProjectInfo,
} from "./types.js";
import { Deferred, Mutex, sleep } from "./util.js";

const TREE_EVENTS = new Set([
  "reciveNewDoc",
  "reciveNewFile",
  "reciveNewFolder",
  "removeEntity",
  "reciveEntityRename",
  "reciveEntityMove",
]);

type OpBuilder = (doc: Document) => { op: ot.Op; cursor: number | null };
type ConfirmResult = { status: "confirmed"; version?: number } | { status: "dropped" | "timeout" };

/**
 * Options common to every edit. `trackChanges` submits the edit as an Overleaf tracked
 * change (a review-mode suggestion) rather than a direct edit: inserts become tracked
 * insertions and deletes become tracked deletions (the removed text is kept, struck through,
 * until a human accepts or rejects it). Requires track changes to be available on the
 * project (a premium feature); the server records the change and attributes it to the
 * signed-in user.
 */
export interface EditOptions {
  trackChanges?: boolean;
}

interface PendingEdit {
  deferred: Deferred<number | undefined>;
  baseVersion: number;
}

/** A comment range as returned by `joinDoc {encodeRanges:true}`. */
interface RawCommentRange {
  id?: string;
  op?: { p?: number; c?: string; t?: string };
}

/** The ranges a `joinDoc {encodeRanges:true}` ack carries alongside the document. */
interface DocRanges {
  comments?: RawCommentRange[];
  changes?: unknown[];
}

export class ProjectSession {
  private readonly rt: RealtimeConnection;
  private readonly rest: RestClient;

  private project: Record<string, any> = {};
  private entities: Entity[] = [];
  private rootFolderId: string | null = null;

  private readonly docs = new Map<string, Document>();
  private readonly mutexes = new Map<string, Mutex>();
  private readonly pending = new Map<string, PendingEdit>();

  constructor(
    private readonly config: Config,
    sessions: SessionManager,
    private readonly projectId: string,
    private readonly nameHint?: string,
  ) {
    this.rt = new RealtimeConnection(config, (force) => sessions.cookies(force), projectId);
    this.rest = new RestClient(config, sessions, projectId);
  }

  // -- lifecycle --------------------------------------------------------
  async connect(): Promise<this> {
    this.rt.addHandler((name, args) => this.onEvent(name, args));
    this.rt.onReconnect = () => this.onReconnect();
    const project = await this.rt.connect();
    this.ingestProject(project);
    return this;
  }

  close(): void {
    this.rt.close();
  }

  // -- metadata ---------------------------------------------------------
  get id(): string {
    return this.projectId;
  }

  get projectName(): string {
    return (this.project.name as string) ?? this.nameHint ?? "";
  }

  get isAlive(): boolean {
    return !this.rt.isFatal;
  }

  projectInfo(): ProjectInfo {
    const p = this.project;
    const owner = (p.owner as Record<string, any>) ?? {};
    return {
      id: (p._id as string) ?? this.projectId,
      name: (p.name as string) ?? "",
      rootDocId: p.rootDoc_id as string | undefined,
      compiler: p.compiler as string | undefined,
      owner: owner.email as string | undefined,
      members: ((p.members as Record<string, any>[]) ?? []).map((m) => m.email),
      publicAccessLevel: p.publicAccesLevel as string | undefined,
    };
  }

  listDocuments(includeFiles = false): Entity[] {
    return this.entities
      .filter((e) => includeFiles || e.type === "doc")
      .map((e) => ({ id: e.id, path: e.path, name: e.name, type: e.type }));
  }

  // -- reading ----------------------------------------------------------
  async readDocument(path: string): Promise<string> {
    return (await this.openDoc(path)).text;
  }

  async getLines(path: string): Promise<string[]> {
    return (await this.openDoc(path)).lines;
  }

  async documentVersion(path: string): Promise<number> {
    return (await this.openDoc(path)).version;
  }

  async search(path: string, query: string): Promise<{ offset: number; line: number; column: number }[]> {
    if (!query) throw new EditError("'query' must be a non-empty string");
    const doc = await this.openDoc(path);
    const out: { offset: number; line: number; column: number }[] = [];
    let start = 0;
    for (;;) {
      const idx = doc.text.indexOf(query, start);
      if (idx === -1) break;
      const [line, column] = doc.offsetToRowcol(idx);
      out.push({ offset: idx, line, column });
      start = idx + Math.max(1, query.length);
    }
    return out;
  }

  // -- editing ----------------------------------------------------------
  async insertAt(path: string, offset: number, text: string, opts: EditOptions = {}): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const pos = clamp(offset, d.length);
      return { op: [ot.insert(pos, text)], cursor: pos + text.length };
    }, opts);
  }

  async insert(path: string, line: number, column: number, text: string, opts: EditOptions = {}): Promise<Document> {
    if (line < 0 || column < 0) {
      throw new EditError(`line and column must be non-negative (got ${line}:${column})`);
    }
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const pos = d.rowcolToOffset(line, column);
      return { op: [ot.insert(pos, text)], cursor: pos + text.length };
    }, opts);
  }

  async append(path: string, text: string, opts: EditOptions = {}): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      let addition = text;
      if (d.text && !d.text.endsWith("\n") && !addition.startsWith("\n")) addition = "\n" + addition;
      return { op: [ot.insert(d.length, addition)], cursor: d.length + addition.length };
    }, opts);
  }

  async deleteRange(path: string, start: number, end: number, opts: EditOptions = {}): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const [s, e] = validateRange(d, start, end);
      if (s === e) return { op: [], cursor: s };
      return { op: [ot.del(s, d.text.slice(s, e))], cursor: s };
    }, opts);
  }

  async replaceRange(path: string, start: number, end: number, text: string, opts: EditOptions = {}): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const [s, e] = validateRange(d, start, end);
      const op: ot.Op = [];
      if (e > s) op.push(ot.del(s, d.text.slice(s, e)));
      if (text) op.push(ot.insert(s, text));
      return { op, cursor: s + text.length };
    }, opts);
  }

  async replaceText(path: string, oldStr: string, newStr: string, count = 0, opts: EditOptions = {}): Promise<number> {
    if (!oldStr) throw new EditError("'old' must be a non-empty string");
    const doc = await this.openDoc(path);
    let replaced = 0;
    await this.submit(doc, (d) => {
      const positions: number[] = [];
      let start = 0;
      for (;;) {
        const idx = d.text.indexOf(oldStr, start);
        if (idx === -1) break;
        positions.push(idx);
        start = idx + oldStr.length;
        if (count && positions.length >= count) break;
      }
      replaced = positions.length;
      if (positions.length === 0) return { op: [], cursor: 0 };
      const op: ot.Op = [];
      for (const idx of [...positions].reverse()) {
        op.push(ot.del(idx, oldStr));
        if (newStr) op.push(ot.insert(idx, newStr));
      }
      return { op, cursor: positions[positions.length - 1] + newStr.length };
    }, opts);
    return replaced;
  }

  async setText(path: string, newText: string, opts: EditOptions = {}): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => ({ op: ot.diffToOp(d.text, newText), cursor: newText.length }), opts);
  }

  async deleteLines(path: string, startLine: number, endLine: number, opts: EditOptions = {}): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const lines = d.lines;
      if (startLine < 0 || startLine >= lines.length) {
        throw new EditError(`startLine ${startLine} out of range`);
      }
      const last = Math.min(endLine, lines.length - 1);
      let start = d.rowcolToOffset(startLine, 0);
      let end: number;
      if (last + 1 < lines.length) {
        end = d.rowcolToOffset(last + 1, 0);
      } else {
        end = d.length;
        if (start > 0) start -= 1; // swallow the preceding newline on the last line
      }
      if (start === end) return { op: [], cursor: start };
      return { op: [ot.del(start, d.text.slice(start, end))], cursor: start };
    }, opts);
  }

  async resync(path: string): Promise<Document> {
    const doc = await this.openDoc(path);
    await this.mutex(doc.id).runExclusive(() => this.joinDoc(doc));
    return doc;
  }

  // -- comments ---------------------------------------------------------
  /**
   * Attach a comment to the `[start, end)` span of a document. Sends a ShareJS comment op
   * (which marks the range without changing the text) and posts the first thread message via
   * the chat REST service. Returns the created {@link Comment}.
   */
  async addComment(path: string, start: number, end: number, message: string): Promise<Comment> {
    if (!message) throw new EditError("'message' must be a non-empty string");
    const doc = await this.openDoc(path);
    const [s, e] = validateRange(doc, start, end);
    if (s === e) throw new EditError("cannot comment on an empty range");
    const threadId = randomBytes(12).toString("hex");

    // Post the message *before* anchoring. Neither half is rollback-able (Overleaf exposes no
    // delete-thread route), so order by which orphan is harmless: a thread with no anchor is
    // invisible in the project, whereas an anchor with no message shows as an empty comment
    // stuck on the text forever.
    await this.rest.postThreadMessage(threadId, message);

    // A comment op is text-neutral, so it rides the normal submit path (version + confirmation)
    // and leaves the mirror unchanged; the closure re-slices the freshly-synced text on retry.
    let commented = "";
    let anchor = s;
    await this.submit(doc, (d) => {
      const [cs, ce] = validateRange(d, start, end);
      // Re-check on every attempt: a resync between attempts can shorten the document and
      // collapse the range, and a zero-length op would still be length 1 (so submit would
      // happily commit an anchor attached to nothing).
      if (cs === ce) throw new EditError("cannot comment on an empty range");
      commented = d.text.slice(cs, ce);
      anchor = cs;
      return { op: [ot.comment(cs, commented, threadId)], cursor: null };
    });

    // Report the offset actually sent (the closure may have re-run against resynced text).
    const [line, column] = doc.offsetToRowcol(anchor);
    return { threadId, text: commented, offset: anchor, line, column, resolved: false, messages: [{ content: message }] };
  }

  /** List the comments anchored in a document, each merged with its thread of messages. */
  async listComments(path: string): Promise<Comment[]> {
    const doc = await this.openDoc(path);
    // Go through joinDoc so a failed join raises instead of silently reading as "no comments",
    // and so the mirror the offsets are mapped against comes from this same join.
    const ranges = await this.mutex(doc.id).runExclusive(() => this.joinDoc(doc));
    const comments = ranges.comments ?? [];
    if (comments.length === 0) return [];
    // Deliberately not caught: a failed threads fetch would otherwise be indistinguishable
    // from every thread being empty and unresolved.
    const threads = await this.rest.getThreads();
    return comments.flatMap((cm) => {
      const threadId = cm.op?.t ?? cm.id;
      const offset = cm.op?.p;
      // A range we cannot interpret is skipped rather than reported at offset 0 with a blank
      // thread id, which would be indistinguishable from a real comment on the first character.
      if (!threadId || offset === undefined) return [];
      const [line, column] = doc.offsetToRowcol(offset);
      const thread = threads[threadId];
      const messages = (thread?.messages ?? []).map((m) => ({
        content: m.content ?? "", // REST JSON is real UTF-8, not the realtime byte-view
        author: m.user?.first_name,
        email: m.user?.email,
        timestamp: m.timestamp,
      }));
      return [{
        threadId,
        text: ot.decodeWireText(cm.op?.c ?? ""),
        offset,
        line,
        column,
        resolved: Boolean(thread?.resolved),
        messages,
      }];
    });
  }

  // -- presence & structure ---------------------------------------------
  async setCursor(path: string, line: number, column: number): Promise<void> {
    const doc = await this.openDoc(path);
    await this.rt.emit(
      "clientTracking.updatePosition",
      [{ row: line, column, doc_id: doc.id }],
      { wantAck: false },
    );
  }

  async getConnectedUsers(): Promise<ConnectedUser[]> {
    const result = await this.rt.emit("clientTracking.getConnectedUsers");
    const last = result[result.length - 1];
    return Array.isArray(last) ? (last as ConnectedUser[]) : [];
  }

  async createDocument(name: string, folder?: string): Promise<{ _id?: string }> {
    const folderId = this.folderId(folder);
    const result = await this.rest.createDoc(name, folderId);
    if (result._id) {
      this.entities.push({
        id: result._id,
        name,
        path: joinPath(folder, name),
        type: "doc",
        folderId,
      });
    }
    return result;
  }

  /**
   * Upload a binary file (e.g. an image for `\includegraphics`) into the project.
   * `source` is a local file path or a Buffer (then `name` is required). An existing file
   * with the same name in the folder is replaced.
   */
  async uploadFile(
    source: string | Uint8Array,
    folder?: string,
    name?: string,
  ): Promise<{ _id?: string; path: string }> {
    const unsupported = (file: string) =>
      new ClaudeleafError(
        `unsupported file type for ${file} (allowed: ${Object.keys(UPLOAD_TYPES).join(", ")})`,
      );
    let data: Uint8Array;
    let fileName = name;
    if (typeof source === "string") {
      // Check the local file's own extension too, not just the uploaded name: otherwise `name`
      // could relabel any readable file (e.g. a private key) as an image and upload it.
      if (!UPLOAD_TYPES[extname(source).toLowerCase()]) throw unsupported(source);
      data = await readFile(source);
      fileName ??= basename(source);
    } else {
      if (!fileName) throw new ClaudeleafError("a name is required when uploading raw bytes");
      data = source;
    }
    if (/[\\/]/.test(fileName)) throw new ClaudeleafError(`invalid file name: ${fileName}`);
    const mime = UPLOAD_TYPES[extname(fileName).toLowerCase()];
    if (!mime) throw unsupported(fileName);
    if (data.byteLength === 0) throw new ClaudeleafError(`${fileName} is empty`);
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      throw new ClaudeleafError(`${fileName} exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit`);
    }
    const folderId = this.folderId(folder);
    const result = await this.rest.uploadFile(fileName, folderId, data, mime);
    const path = joinPath(folder, fileName);
    this.entities = this.entities.filter((e) => !(e.path === path && e.type === "file"));
    if (result._id) {
      this.entities.push({ id: result._id, name: fileName, path, type: "file", folderId });
    }
    return { ...result, path };
  }

  async createFolder(name: string, folder?: string): Promise<{ _id?: string }> {
    return this.rest.createFolder(name, this.folderId(folder));
  }

  async deleteDocument(path: string): Promise<void> {
    const entity = this.resolve(path);
    await this.rest.deleteEntity(entity.id, entity.type);
    this.docs.delete(entity.id);
    this.entities = this.entities.filter((e) => e.id !== entity.id);
  }

  async renameDocument(path: string, newName: string): Promise<void> {
    const entity = this.resolve(path);
    await this.rest.renameEntity(entity.id, entity.type, newName);
    const parent = entity.path.includes("/") ? entity.path.replace(/\/[^/]*$/, "") : "";
    entity.name = newName;
    entity.path = parent ? `${parent}/${newName}` : newName;
  }

  // -- compile ----------------------------------------------------------
  /**
   * Recompile the project's root document and return the status plus the parsed log.
   * `errors`/`warnings` come from parsing `output.log` - they can be non-empty even when
   * `success` is true, because LaTeX recovers and still produces a PDF.
   */
  async compile(opts: CompileOptions = {}): Promise<CompileResult> {
    const raw = await this.rest.compile(opts);
    if (typeof raw.status !== "string") {
      // A 200 with a non-JSON body (e.g. a login page after a session-expiry redirect)
      // would otherwise look like a benign empty failure.
      throw new ClaudeleafError(
        "unexpected compile response (the session may have expired — run `claudeleaf login`)",
      );
    }
    const clsi = raw.clsiServerId ?? "";
    const withServer = (url: string): string =>
      `${this.config.baseUrl}${url}${url.includes("?") ? "&" : "?"}clsiserverid=${encodeURIComponent(clsi)}`;
    const outputFiles: OutputFile[] = (raw.outputFiles ?? []).map((f) => ({
      path: f.path,
      type: f.type ?? "",
      build: f.build ?? "",
      url: withServer(f.url),
    }));

    let log = "";
    const logFile = (raw.outputFiles ?? []).find((f) => f.path === "output.log");
    if (logFile) {
      try {
        log = await this.rest.fetchText(
          `${logFile.url}?clsiserverid=${encodeURIComponent(clsi)}`,
        );
      } catch {
        /* the log may be unavailable (e.g. nothing compiled); leave it empty */
      }
    }

    const entries = parseLatexLog(log);
    return {
      status: raw.status,
      success: raw.status === "success",
      errors: entries.filter((e) => e.level === "error"),
      warnings: entries.filter((e) => e.level === "warning"),
      log,
      outputFiles,
      pdfUrl: outputFiles.find((f) => f.path === "output.pdf")?.url,
    };
  }

  // -- internals: tree --------------------------------------------------
  private ingestProject(payload: Record<string, any>): void {
    const project = (payload.project as Record<string, any>) ?? payload;
    this.project = project;
    const entities: Entity[] = [];
    const root = (project.rootFolder as Record<string, any>[])?.[0];
    if (root) {
      this.rootFolderId = root._id as string;
      this.walkFolder(root, "", entities);
    }
    this.entities = entities;
  }

  private walkFolder(folder: Record<string, any>, prefix: string, out: Entity[]): void {
    for (const doc of (folder.docs as Record<string, any>[]) ?? []) {
      out.push({ id: doc._id, name: doc.name, path: prefix + doc.name, type: "doc", folderId: folder._id });
    }
    for (const ref of (folder.fileRefs as Record<string, any>[]) ?? []) {
      out.push({ id: ref._id, name: ref.name, path: prefix + ref.name, type: "file", folderId: folder._id });
    }
    for (const sub of (folder.folders as Record<string, any>[]) ?? []) {
      this.walkFolder(sub, prefix + sub.name + "/", out);
    }
  }

  private resolve(pathOrId: string): Entity {
    const ref = pathOrId.trim().replace(/^\/+/, "");
    for (const e of this.entities) if (e.path === ref || e.id === ref) return e;
    const matches = this.entities.filter((e) => e.name === ref);
    if (matches.length === 1) return matches[0];
    throw new DocumentNotFoundError(
      `no document or file matching ${pathOrId} ` +
        `(known: ${this.entities.map((e) => e.path).join(", ") || "none"})`,
    );
  }

  private folderId(folder?: string): string {
    if (!folder || folder === "/" || folder === "") {
      if (!this.rootFolderId) throw new ClaudeleafError("root folder id unknown");
      return this.rootFolderId;
    }
    const ref = folder.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    const root = (this.project.rootFolder as Record<string, any>[])?.[0] ?? {};
    const found = this.findFolder(root, "", ref);
    if (!found) throw new DocumentNotFoundError(`no folder matching ${folder}`);
    return found;
  }

  private findFolder(folder: Record<string, any>, prefix: string, ref: string): string | null {
    for (const sub of (folder.folders as Record<string, any>[]) ?? []) {
      const path = prefix + sub.name;
      if (path === ref || sub.name === ref) return sub._id;
      const nested = this.findFolder(sub, path + "/", ref);
      if (nested) return nested;
    }
    return null;
  }

  private folderPathById(folderId: string): string {
    if (folderId === this.rootFolderId) return "";
    const root = (this.project.rootFolder as Record<string, any>[])?.[0] ?? {};
    const walk = (folder: Record<string, any>, prefix: string): string | null => {
      for (const sub of (folder.folders as Record<string, any>[]) ?? []) {
        const path = (prefix ? prefix + "/" : "") + sub.name;
        if (sub._id === folderId) return path;
        const found = walk(sub, path);
        if (found !== null) return found;
      }
      return null;
    };
    return walk(root, "") ?? "";
  }

  // -- internals: editing -----------------------------------------------
  private mutex(docId: string): Mutex {
    let m = this.mutexes.get(docId);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(docId, m);
    }
    return m;
  }

  private async openDoc(path: string): Promise<Document> {
    const entity = this.resolve(path);
    if (entity.type !== "doc") {
      throw new EditError(`${entity.path} is a binary file, not an editable document`);
    }
    let doc = this.docs.get(entity.id);
    if (!doc) {
      return this.mutex(entity.id).runExclusive(async () => {
        let d = this.docs.get(entity.id);
        if (!d) {
          d = new Document(entity.id, entity.name, entity.path);
          this.docs.set(entity.id, d);
        }
        await this.ensureJoined(d);
        return d;
      });
    }
    if (!doc.loaded || doc.joinGeneration !== this.rt.generation) {
      const d = doc;
      await this.mutex(d.id).runExclusive(() => this.ensureJoined(d));
    }
    return doc;
  }

  private async ensureJoined(doc: Document): Promise<void> {
    if (!doc.loaded || doc.joinGeneration !== this.rt.generation) await this.joinDoc(doc);
  }

  /**
   * (Re)join a document, refresh its mirror, and return the ranges the server sent with it.
   * Every read of ranges goes through here so it inherits the error check and the backoff
   * that rides out a `joinLeaveEpoch mismatch`, and so the ranges and the mirror they are
   * interpreted against always come from the same join.
   */
  private async joinDoc(doc: Document, attempts = 5): Promise<DocRanges> {
    let lastError: Error | undefined;
    for (let i = 0; i < attempts; i++) {
      let result: unknown[];
      try {
        result = await this.rt.emit("joinDoc", [doc.id, { encodeRanges: true }], {
          timeout: this.config.requestTimeout,
        });
      } catch (e) {
        lastError = e as Error;
        await sleep(500 * (i + 1));
        continue;
      }
      // result = [error, lines, version, ...]
      if (!result || result[0] !== null) {
        lastError = new ClaudeleafError(
          `joinDoc failed for ${doc.path}: ${JSON.stringify(result?.[0] ?? "no response")}`,
        );
        await sleep(500 * (i + 1)); // ride out a transient joinLeaveEpoch mismatch
        continue;
      }
      const lines = (result[1] as string[]).map(ot.decodeWireText);
      doc.loadFromLines(lines, result[2] as number);
      doc.joinGeneration = this.rt.generation;
      // Ranges ride along in the join ack; its exact slot has moved between server versions,
      // so identify it by shape rather than index.
      return (
        result.find(
          (x): x is DocRanges =>
            !!x && typeof x === "object" && !Array.isArray(x) && ("comments" in x || "changes" in x),
        ) ?? {}
      );
    }
    throw lastError ?? new ClaudeleafError(`joinDoc failed for ${doc.path}`);
  }

  private submit(doc: Document, build: OpBuilder, opts: EditOptions = {}): Promise<Document> {
    return this.mutex(doc.id).runExclusive(async () => {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.ensureJoined(doc);
        const { op, cursor } = build(doc);
        if (op.length === 0) return doc;

        let newText: string;
        try {
          newText = ot.applyOp(doc.text, op);
        } catch (e) {
          lastError = e as Error;
          await this.joinDoc(doc); // mirror diverged; resync and rebuild
          continue;
        }

        const version = doc.version;
        // In track-changes mode, tag the update with a fresh id seed. The server records the
        // op's components as tracked changes (id = seed + a per-component counter) attributed
        // to the signed-in user, instead of applying it as a plain edit. The op wire format
        // and the resulting snapshot are unchanged, so the local mirror and confirmation
        // logic below stay correct.
        const update: Record<string, unknown> = { doc: doc.id, op, v: version };
        if (opts.trackChanges) update.meta = { tc: randomBytes(9).toString("hex") };
        const pending: PendingEdit = { deferred: new Deferred(), baseVersion: version };
        this.pending.set(doc.id, pending);
        try {
          await this.rt.emit(
            "applyOtUpdate",
            [doc.id, update],
            { timeout: this.config.requestTimeout, retryOnDrop: false },
          );
        } catch (e) {
          this.pending.delete(doc.id);
          if (e instanceof NotTransmittedError) {
            lastError = e; // never sent; reconnect, re-join, rebuild, retry
            await this.rt.waitUntilConnected().catch(() => undefined);
            continue;
          }
          await this.joinDoc(doc); // ambiguous; resync and surface
          throw new EditConflictError(
            `connection dropped while editing ${doc.path}; the document was resynced - ` +
              "please retry the edit",
          );
        }

        // The ack only means "received". Wait for the op-less otUpdateApplied that proves
        // the server actually applied our op (drop-aware).
        const result = await this.awaitConfirmation(pending.deferred);
        this.pending.delete(doc.id);
        if (result.status !== "confirmed") {
          await this.joinDoc(doc);
          throw new EditConflictError(
            `edit to ${doc.path} could not be confirmed (it may or may not have applied); ` +
              "the document was resynced - please re-check and retry",
          );
        }
        const confirmedVersion = result.version;
        if (confirmedVersion !== undefined && confirmedVersion !== version) {
          // A concurrent remote op landed before ours, so the local text is stale even
          // though our edit applied. Resync to the authoritative state.
          await this.joinDoc(doc);
          return doc;
        }
        doc.text = newText;
        doc.version = confirmedVersion !== undefined ? confirmedVersion + 1 : version + 1;
        void this.notifyCursor(doc, cursor);
        return doc;
      }
      throw new EditConflictError(
        `could not apply edit to ${doc.path} after retries: ${lastError}`,
      );
    });
  }

  private async awaitConfirmation(deferred: Deferred<number | undefined>): Promise<ConfirmResult> {
    const generation = this.rt.generation;
    const deadline = Date.now() + this.config.requestTimeout * 1000;
    for (;;) {
      if (deferred.settled) return { status: "confirmed", version: await deferred.promise };
      if (this.rt.generation !== generation || !this.rt.isConnected) return { status: "dropped" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "timeout" };
      await Promise.race([
        deferred.promise.then(
          () => undefined,
          () => undefined,
        ),
        sleep(Math.min(remaining, 250)),
      ]);
    }
  }

  private async notifyCursor(doc: Document, offset: number | null): Promise<void> {
    if (offset === null) return;
    const [row, column] = doc.offsetToRowcol(offset);
    try {
      await this.rt.emit(
        "clientTracking.updatePosition",
        [{ row, column, doc_id: doc.id }],
        { wantAck: false },
      );
    } catch {
      /* presence is best-effort */
    }
  }

  // -- internals: incoming events ---------------------------------------
  private onEvent(name: string, args: unknown[]): void {
    if (name === "otUpdateApplied") {
      const data = args[0] as Record<string, any> | undefined;
      if (!data || typeof data !== "object") return;
      if (data.op === undefined) {
        this.resolveConfirmation(data.doc as string | undefined, data.v as number | undefined);
        return;
      }
      const doc = this.docs.get(data.doc as string);
      if (doc) void this.mutex(doc.id).runExclusive(() => this.applyRemoteOp(doc, data));
      return;
    }
    if (name === "otUpdateError") {
      const data = args[0] as Record<string, any> | undefined;
      const docId = data?.doc_id as string | undefined;
      const doc = docId ? this.docs.get(docId) : undefined;
      if (doc) void this.mutex(doc.id).runExclusive(() => this.joinDoc(doc));
      return;
    }
    if (TREE_EVENTS.has(name)) this.applyTreeEvent(name, args);
  }

  private resolveConfirmation(docId: string | undefined, version: number | undefined): void {
    if (!docId) return;
    const pending = this.pending.get(docId);
    if (!pending) return;
    if (version !== undefined && version < pending.baseVersion) return; // stale prior edit
    pending.deferred.resolve(version);
  }

  private async applyRemoteOp(doc: Document, data: Record<string, any>): Promise<void> {
    const version = data.v as number | undefined;
    const op = (data.op as ot.Op) ?? [];
    if (version === undefined) return;
    if (version < doc.version) return; // already applied (or our own echo)
    if (version > doc.version) {
      await this.joinDoc(doc); // version gap -> resync
      return;
    }
    try {
      doc.applyOp(ot.decodeWireOp(op));
      doc.version = version + 1;
    } catch {
      await this.joinDoc(doc); // did not apply cleanly -> resync
    }
  }

  private applyTreeEvent(name: string, args: unknown[]): void {
    try {
      if (name === "reciveNewDoc" || name === "reciveNewFile") {
        const parentId = args[0] as string;
        const entity = args[1] as Record<string, any>;
        const type = name === "reciveNewDoc" ? "doc" : "file";
        const parentPath = this.folderPathById(parentId);
        this.entities.push({
          id: entity._id,
          name: entity.name,
          path: (parentPath ? parentPath + "/" : "") + entity.name,
          type,
          folderId: parentId,
        });
      } else if (name === "reciveNewFolder") {
        this.insertFolderIntoTree(args[0] as string, args[1] as Record<string, any>);
      } else if (name === "removeEntity") {
        const entityId = args[0] as string;
        this.entities = this.entities.filter((e) => e.id !== entityId);
        this.docs.delete(entityId);
      } else if (name === "reciveEntityRename") {
        const entityId = args[0] as string;
        const newName = args[1] as string;
        for (const e of this.entities) {
          if (e.id === entityId) {
            const parent = e.path.includes("/") ? e.path.replace(/\/[^/]*$/, "") : "";
            e.name = newName;
            e.path = parent ? `${parent}/${newName}` : newName;
          }
        }
      } else if (name === "reciveEntityMove") {
        const entityId = args[0] as string;
        const destFolderId = args[1] as string;
        const parentPath = this.folderPathById(destFolderId);
        for (const e of this.entities) {
          if (e.id === entityId) {
            e.folderId = destFolderId;
            e.path = (parentPath ? parentPath + "/" : "") + e.name;
          }
        }
      }
    } catch {
      /* unknown shape - ignore; existing docs keep working */
    }
  }

  private insertFolderIntoTree(parentId: string, folder: Record<string, any>): void {
    const node = { ...folder, folders: folder.folders ?? [], docs: folder.docs ?? [], fileRefs: folder.fileRefs ?? [] };
    const root = (this.project.rootFolder as Record<string, any>[])?.[0];
    if (!root) return;
    const walk = (f: Record<string, any>): boolean => {
      if (f._id === parentId) {
        (f.folders ??= []).push(node);
        return true;
      }
      return ((f.folders as Record<string, any>[]) ?? []).some(walk);
    };
    walk(root);
  }

  private async onReconnect(): Promise<void> {
    for (const doc of [...this.docs.values()]) {
      try {
        await this.mutex(doc.id).runExclusive(() => this.joinDoc(doc));
      } catch {
        /* will re-join lazily on next access */
      }
    }
  }
}

function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(value, length));
}

function validateRange(doc: Document, start: number, end: number): [number, number] {
  let s = clamp(start, doc.length);
  let e = clamp(end, doc.length);
  if (s > e) [s, e] = [e, s];
  return [s, e];
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".eps": "application/postscript",
};

function joinPath(folder: string | undefined, name: string): string {
  if (!folder || folder === "/" || folder === "") return name;
  return folder.trim().replace(/^\/+|\/+$/g, "") + "/" + name;
}
