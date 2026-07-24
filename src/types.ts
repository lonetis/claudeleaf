/** Shared types for the public API. */

export type Cookies = Record<string, string>;

export interface Entity {
  id: string;
  name: string;
  path: string;
  type: "doc" | "file";
  folderId?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  accessLevel?: string;
  lastUpdated?: string;
  owner?: string;
  archived: boolean;
  trashed: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  rootDocId?: string;
  compiler?: string;
  owner?: string;
  members: (string | undefined)[];
  publicAccessLevel?: string;
}

export interface ConnectedUser {
  user_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  cursorData?: { row: number; column: number; doc_id: string };
  [key: string]: unknown;
}

/** One message in a comment thread. */
export interface CommentMessage {
  content: string;
  /** Display name of the author, if known. */
  author?: string;
  email?: string;
  /** Epoch milliseconds when the message was posted. */
  timestamp?: number;
}

/** A comment anchored to a span of a document, with its thread of messages. */
export interface Comment {
  /** The comment thread id (Overleaf's `t`). */
  threadId: string;
  /** The commented-on text span. */
  text: string;
  /** Character offset of the span's start in the `\n`-joined document. */
  offset: number;
  /** 0-based line of the span's start. */
  line: number;
  /** 0-based column of the span's start. */
  column: number;
  /** Whether the thread has been resolved in Overleaf. */
  resolved: boolean;
  /** The thread's messages, oldest first. */
  messages: CommentMessage[];
}

/** A file produced by a compile (log, pdf, aux, ...). `url` is absolute and fetchable. */
export interface OutputFile {
  path: string;
  type: string;
  build: string;
  url: string;
}

export type LogLevel = "error" | "warning" | "typesetting";

/** One parsed entry from the LaTeX compile log. */
export interface LogEntry {
  level: LogLevel;
  message: string;
  file?: string;
  /**
   * 1-based LaTeX source line (as shown in the log and the Overleaf editor). NOTE: this is
   * 1-based, unlike the 0-based `line` of the edit/navigation methods — subtract 1 before
   * passing it to `insert`/`deleteLines`/etc.
   */
  line?: number;
  raw: string;
}

/** Options for a compile request. */
export interface CompileOptions {
  /** Draft mode — faster, skips some output (default false). */
  draft?: boolean;
  /** Abort at the first error instead of trying to recover (default false). */
  stopOnFirstError?: boolean;
}

/** The result of a compile: Overleaf's status plus the parsed log. */
export interface CompileResult {
  /** Raw Overleaf status: "success" | "failure" | "timedout" | "error" | ... */
  status: string;
  /** Whether Overleaf reported a successful compile (a PDF may still have LaTeX errors). */
  success: boolean;
  /** Parsed LaTeX errors (present even on a "success" status — LaTeX recovers). */
  errors: LogEntry[];
  /** Parsed LaTeX warnings. */
  warnings: LogEntry[];
  /** The raw `output.log` text (empty if it could not be fetched). */
  log: string;
  /** All output files (the PDF, logs, aux, ...). */
  outputFiles: OutputFile[];
  /** Convenience: the produced PDF's URL, if any. */
  pdfUrl?: string;
}
