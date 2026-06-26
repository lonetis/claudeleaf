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
import { RestClient } from "./rest.js";
import type {
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

interface PendingEdit {
  deferred: Deferred<number | undefined>;
  baseVersion: number;
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
  async insertAt(path: string, offset: number, text: string): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const pos = clamp(offset, d.length);
      return { op: [ot.insert(pos, text)], cursor: pos + text.length };
    });
  }

  async insert(path: string, line: number, column: number, text: string): Promise<Document> {
    if (line < 0 || column < 0) {
      throw new EditError(`line and column must be non-negative (got ${line}:${column})`);
    }
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const pos = d.rowcolToOffset(line, column);
      return { op: [ot.insert(pos, text)], cursor: pos + text.length };
    });
  }

  async append(path: string, text: string): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      let addition = text;
      if (d.text && !d.text.endsWith("\n") && !addition.startsWith("\n")) addition = "\n" + addition;
      return { op: [ot.insert(d.length, addition)], cursor: d.length + addition.length };
    });
  }

  async deleteRange(path: string, start: number, end: number): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const [s, e] = validateRange(d, start, end);
      if (s === e) return { op: [], cursor: s };
      return { op: [ot.del(s, d.text.slice(s, e))], cursor: s };
    });
  }

  async replaceRange(path: string, start: number, end: number, text: string): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => {
      const [s, e] = validateRange(d, start, end);
      const op: ot.Op = [];
      if (e > s) op.push(ot.del(s, d.text.slice(s, e)));
      if (text) op.push(ot.insert(s, text));
      return { op, cursor: s + text.length };
    });
  }

  async replaceText(path: string, oldStr: string, newStr: string, count = 0): Promise<number> {
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
    });
    return replaced;
  }

  async setText(path: string, newText: string): Promise<Document> {
    const doc = await this.openDoc(path);
    return this.submit(doc, (d) => ({ op: ot.diffToOp(d.text, newText), cursor: newText.length }));
  }

  async deleteLines(path: string, startLine: number, endLine: number): Promise<Document> {
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
    });
  }

  async resync(path: string): Promise<Document> {
    const doc = await this.openDoc(path);
    await this.mutex(doc.id).runExclusive(() => this.joinDoc(doc));
    return doc;
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

  private async joinDoc(doc: Document, attempts = 5): Promise<void> {
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
      return;
    }
    throw lastError ?? new ClaudeleafError(`joinDoc failed for ${doc.path}`);
  }

  private submit(doc: Document, build: OpBuilder): Promise<Document> {
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
        const pending: PendingEdit = { deferred: new Deferred(), baseVersion: version };
        this.pending.set(doc.id, pending);
        try {
          await this.rt.emit(
            "applyOtUpdate",
            [doc.id, { doc: doc.id, op, v: version }],
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

function joinPath(folder: string | undefined, name: string): string {
  if (!folder || folder === "/" || folder === "") return name;
  return folder.trim().replace(/^\/+|\/+$/g, "") + "/" + name;
}
