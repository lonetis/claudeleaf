# API reference

Reference for the TypeScript SDK and the MCP tools. Conventions:

- **project** — referenced by its 24-char id or its (unique) name.
- **path** — a document within a project, by full path (`main.tex`, `chapters/intro.tex`),
  id, or unambiguous basename.
- **Offsets** are character (codepoint) indices into the document text (lines joined by `\n`).
- **line / column** are **0-based** for the edit/navigation methods. (Exception: compile-log
  line numbers in `CompileResult.errors`/`warnings` are **1-based**, matching the raw log and
  the Overleaf editor — subtract 1 before feeding one to `insert`/`deleteLines`/etc.)
- All client methods are **async** (return `Promise`). Most edits resolve once the server
  **confirms** the change, returning the updated `Document`. The exception is `replaceText`,
  which resolves with the number replaced (`number`).

## SDK — `OverleafClient` (account-scoped)

```ts
import { OverleafClient } from "claudeleaf";
const client = new OverleafClient(); // uses the cached session
```

### Account

| Method | Returns | Description |
| --- | --- | --- |
| `login()` | `Promise<Cookies>` | Sign in interactively via a browser; cache the session. |
| `isLoggedIn()` | `Promise<boolean>` | Whether a valid cached session exists. |
| `listProjects(refresh = true)` | `Promise<ProjectSummary[]>` | `{ id, name, accessLevel, lastUpdated, owner, archived, trashed }`. |
| `project(idOrName)` | `Promise<ProjectSession>` | The connected, cached session for a project. |

### Per-project operations (each takes `project` first)

Read / navigate: `projectInfo(project)`, `listDocuments(project, includeFiles?)`,
`readDocument(project, path)`, `getLines(project, path)`, `documentVersion(project, path)`,
`search(project, path, query)`.

Edit:

| Method | Description |
| --- | --- |
| `insertAt(project, path, offset, text)` | Insert at a character offset. |
| `insert(project, path, line, column, text)` | Insert at a 0-based line/column. |
| `append(project, path, text)` | Append to the end (adds a newline if needed). |
| `deleteRange(project, path, start, end)` | Delete `[start, end)`. |
| `replaceRange(project, path, start, end, text)` | Replace `[start, end)` with `text`. |
| `replaceText(project, path, old, new, count = 0)` | Replace literal occurrences (`0` = all). Returns the count. |
| `setText(project, path, newText)` | Replace the whole document (minimal diff). |
| `deleteLines(project, path, startLine, endLine)` | Delete 0-based lines, inclusive. |

Presence & structure: `setCursor(project, path, line, column)`,
`getConnectedUsers(project)`, `createDocument(project, name, folder?)`,
`createFolder(project, name, folder?)`, `deleteDocument(project, path)`,
`renameDocument(project, path, newName)`, `resync(project, path)`.

`ProjectSession` (from `client.project(...)`) exposes the same document methods **without**
the leading `project` argument.

### Compile

`compile(project, options?)` recompiles the project's root document and resolves with a
`CompileResult`:

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | Overleaf status: `success`, `failure`, `timedout`, `error`, … |
| `success` | `boolean` | `status === "success"` (a PDF can still have LaTeX errors). |
| `errors` | `LogEntry[]` | Parsed errors — each `{ message, file?, line?, raw }` (`line` is **1-based**). |
| `warnings` | `LogEntry[]` | Parsed warnings (same shape; `line` is 1-based). |
| `log` | `string` | The raw `output.log` (empty if unavailable). |
| `outputFiles` | `OutputFile[]` | All outputs `{ path, type, build, url }` (`url` is fetchable). |
| `pdfUrl` | `string?` | The produced PDF's URL, if any. |

`options`: `{ draft?: boolean; stopOnFirstError?: boolean }`. Errors are parsed from the log,
so they appear even when `success` is true (LaTeX recovers and still produces a PDF).

### Errors

All extend `ClaudeleafError`: `AuthError`, `ConnectionError` (and `NotTransmittedError`),
`ProtocolError`, `TimeoutError`, `ProjectNotFoundError`, `DocumentNotFoundError`, `EditError`,
`EditConflictError`, `ConfigError`. `EditConflictError` means an edit could not be confirmed
(e.g. a mid-edit disconnect); the document is re-synced — read it and retry.

## CLI

No configuration; run `claudeleaf login` once. (`claudeleaf` is the `bin`; or use
`node dist/cli.js` / `npm run claudeleaf -- …`.)

```
claudeleaf login                               sign in via browser, cache the session
claudeleaf doctor                              check the session, list projects
claudeleaf projects                            list all accessible projects
claudeleaf info <project>                      project metadata
claudeleaf ls <project> [--all]                list documents (--all includes files)
claudeleaf cat <project> <path>                print a document
claudeleaf append <project> <path> [text|-]    append text (- / omit reads stdin)
claudeleaf insert <project> <path> <line> <col> [text|-]
claudeleaf replace <project> <path> <old> <new> [--count N]
claudeleaf set <project> <path>                replace whole document with stdin
claudeleaf search <project> <path> <query>     find text
claudeleaf compile <project> [--draft] [--stop-on-first-error] [--log] [--warnings]
claudeleaf mcp                                 run the MCP server over stdio
```

`compile` prints the status and each error as `file:line: message`; add `--warnings` to also
list warnings and `--log` to dump the raw `output.log`. It exits non-zero when the compile
failed or the log contains errors.

## MCP tools

Exposed by `claudeleaf mcp`. One-to-one wrappers; edit tools return `{ ok, path, version,
length }` (or `{ replaced }` / `{ id }` where noted).

| Tool | Arguments |
| --- | --- |
| `overleaf_list_projects` | — |
| `overleaf_project_info` | `project` |
| `overleaf_list_documents` | `project, includeFiles?` |
| `overleaf_read_document` | `project, path` |
| `overleaf_search` | `project, path, query` |
| `overleaf_insert_text` | `project, path, line, column, text` |
| `overleaf_append_text` | `project, path, text` |
| `overleaf_replace_text` | `project, path, old, new, count?` |
| `overleaf_replace_range` | `project, path, start, end, text` |
| `overleaf_delete_range` | `project, path, start, end` |
| `overleaf_delete_lines` | `project, path, startLine, endLine` |
| `overleaf_set_document` | `project, path, content` |
| `overleaf_create_document` | `project, name, folder?` |
| `overleaf_delete_document` | `project, path` |
| `overleaf_rename_document` | `project, path, newName` |
| `overleaf_connected_users` | `project` |
| `overleaf_compile` | `project, draft?, stopOnFirstError?, includeLog?` |
