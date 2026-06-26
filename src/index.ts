/**
 * Claudeleaf - bring Claude (and any agent) into Overleaf.
 *
 *     import { OverleafClient } from "claudeleaf";
 *     const client = new OverleafClient();          // uses the cached session
 *     for (const p of await client.listProjects()) console.log(p.id, p.name);
 *     await client.append("My Paper", "main.tex", "% added by an agent\n");
 *
 * Run `claudeleaf login` once to sign in (a browser opens for manual login).
 */

export { OverleafClient } from "./client.js";
export { ProjectSession } from "./session.js";
export { Config, parseProjectId } from "./config.js";
export { Document } from "./document.js";
export { parseLatexLog, splitByLevel } from "./logParser.js";
export {
  ClaudeleafError,
  ConfigError,
  AuthError,
  ConnectionError,
  NotTransmittedError,
  ProtocolError,
  TimeoutError,
  ProjectNotFoundError,
  DocumentNotFoundError,
  EditError,
  EditConflictError,
} from "./errors.js";
export type {
  Cookies,
  Entity,
  ProjectSummary,
  ProjectInfo,
  ConnectedUser,
  OutputFile,
  LogLevel,
  LogEntry,
  CompileOptions,
  CompileResult,
} from "./types.js";

export const version = "0.1.0";
