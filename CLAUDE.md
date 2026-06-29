# CLAUDE.md

Internal documentation for **Claudeleaf** — the single source of truth for how the project
works. (User-facing docs live in `README.md`.)

## What this is

Claudeleaf bridges an Overleaf *account* to an API so Claude — or any agent/tool — can edit
any of the account's projects programmatically through Overleaf's *live* web-editing channel
(not git). Edits appear to collaborators in real time, attributed to the signed-in user. One
instance is account-scoped: it lists every accessible project and edits any of them (by id or
name); each project is backed by its own realtime connection.

TypeScript / Node, delivered as three layers over one core:

- a **TypeScript SDK** (`OverleafClient`, account-scoped; `ProjectSession`, per-project),
- a **CLI** (`claudeleaf`) — thin command wrapper,
- an **MCP server** — thin tool wrapper, for Claude Code.

## Tech stack

- Node.js 20+, TypeScript (ESM, `NodeNext`), built with `tsc` to `dist/`. npm for tooling.
- `ws` — the realtime WebSocket transport.
- global `fetch` (Node) — the Socket.IO handshake and the REST tree/projects endpoints.
- `playwright-core` — drives the user's *installed* Chrome/Edge for the one-time manual login
  (no browser download). Loaded lazily (dynamic `import` in `auth.browserLogin`) so the
  SDK/CLI/MCP stay lightweight — important for `npx`.
- `@modelcontextprotocol/sdk` + `zod` — the MCP server.
- `vitest` — unit + live integration tests. `tsx` — run TS directly (dev / MCP launch).

## Project structure (`src/`, flat)

```
src/
  index.ts        public API: OverleafClient, ProjectSession, Config, Document, errors
  config.ts       account-level Config (no project/credentials); env parsing
  errors.ts       error hierarchy (ClaudeleafError + subclasses)
  util.ts         async helpers: Mutex, Deferred, sleep, withTimeout
  protocol.ts     Socket.IO 0.9 frame encode/decode (pure)
  ot.ts           ShareJS ops, offset<->rowcol, diff, wire encoding, git-blob hash (pure)
  logParser.ts    parse pdfTeX/LaTeX output.log into errors/warnings/bad-boxes (pure)
  document.ts     Document: local mirror of one open doc (text + version + generation)
  types.ts        shared types (Entity, ProjectSummary, ProjectInfo, CompileResult, ...)
  realtime.ts     RealtimeConnection(projectId): WS transport, acks, heartbeat, reconnect
  auth.ts         SessionManager: manual browser login + session cookie cache
  rest.ts         listProjects() + RestClient(projectId) for tree CRUD + compile/output
  session.ts      ProjectSession: one project's realtime connection, tree, edits, compile
  client.ts       OverleafClient: account-scoped; listProjects + per-project delegation
  cli.ts          CLI (login, doctor, projects, doc ops, compile, mcp); the bin
  mcpServer.ts    MCP server exposing the SDK as tools (each takes a project)
test/             vitest unit (no network) + integration/mcp e2e (live, auto-skip)
```

## Architecture & data flow

```
Config (env, all optional) ──> OverleafClient (account)
                                  ├─ SessionManager ──(manual browser login, cached cookie)
                                  ├─ rest.listProjects()  ─ POST /api/project
                                  └─ ProjectSession(projectId)   one per project, cached
                                       ├─ RealtimeConnection(projectId)   Socket.IO 0.9 (ws)
                                       └─ RestClient(projectId)           tree CRUD (fetch)
OverleafClient ──> CLI  and  MCP server   (each op takes a project id/name)
```

- **OverleafClient** is account-scoped. It resolves a project (24-hex id, or unique name via
  `listProjects`), lazily creates and caches a `ProjectSession` per project, and delegates
  document operations to it. All methods are `async`. A session whose connection has
  permanently failed is rebuilt on next access.
- **ProjectSession** owns one project's realtime connection + tree + open documents and all
  editing logic. This is where the reliability/concurrency model lives.
- **SessionManager** returns the cached auth cookie (sync), or throws directing the user to
  `claudeleaf login` — it never automates credentials.

## Authentication (manual)

Overleaf's login is protected by reCAPTCHA (and may use SSO/2FA), so Claudeleaf does not
automate credentials. `claudeleaf login` (→ `SessionManager.login`) drives the user's
*installed* browser via `playwright-core` — `launchPersistentContext` with `channel: "chrome"`,
falling back to `"msedge"`, then any Playwright-managed Chromium, else a clear error. A real
headed browser is what passes Overleaf's invisible reCAPTCHA reliably; using the system browser
also means **no Playwright browser download** (so `npx claudeleaf` stays light). The user signs
in by hand; once `ol-user_id` appears it extracts the `overleaf_session2` cookie and caches it
(`~/.claudeleaf/session.json`, mode 0600). The lightweight fetch/WebSocket layers reuse the
cookie; the browser is only needed again when it expires.

## Listing projects

`rest.listProjects` scrapes the dashboard CSRF token then calls the dashboard JSON API
`POST /api/project`, returning `{id, name, accessLevel, lastUpdated, owner, archived,
trashed}` per project. Account-level — no project id needed.

## The Overleaf realtime protocol (reverse-engineered)

Overleaf.com uses legacy **Socket.IO 0.9** + **ShareJS** OT over one WebSocket. Verified
against live traffic:

**Handshake.** `GET /socket.io/1/?projectId=<id>&esh=1&ssp=1&t=<ms>` with the session cookie
returns `"<sid>:<heartbeat>:<close>:<transports>"`. Its `Set-Cookie: GCLB=…` is a
load-balancer affinity cookie that **must** be forwarded on the WebSocket, or the server
replies `7:::1+0` ("client not handshaken") and drops the connection.

**WebSocket.** `wss://<host>/socket.io/1/websocket/<sid>?projectId=<id>&esh=1&ssp=1` with
`Cookie: overleaf_session2=…; GCLB=…` and `Origin`. Frames are `<type>:<id>:<endpoint>:<data>`:
`1::` connect, `2::` heartbeat (echo it), `5:<id>+::<json>` event-wanting-ack, `5:::<json>`
event, `6:::<id>+<json>` ack, `7` error, `0::` disconnect, `8` noop.

**Joining.** Because `projectId` is in the query, the server auto-sends `joinProjectResponse`
whose `args[0].project` holds the folder tree (`rootFolder[0].{docs,fileRefs,folders}`).
`joinDoc` acks with `[null, <lines>, <version>, …]`.

**Editing.** `applyOtUpdate` with `args=["<docId>",{doc,op,v}]`. `op` is a list of ShareJS
components over the `\n`-joined text: insert `{p,i}`, delete `{p,d}`. The server acks
`6:::<id>`, then:
- **to us (originator):** an op-less `otUpdateApplied {v,doc}` — our *confirmation*;
- **to other clients:** an op-ful `otUpdateApplied {doc,op,v,meta}` to apply.
After an update the version is `v+1`.

**Hash.** Overleaf's optional ShareJS hash is git-blob SHA-1 (`ot.gitBlobHash`). We **omit
it**: the server treats it as optional, and a mismatch is fatal (`otUpdateError "Invalid
hash"` + disconnect), so omitting it is strictly more reliable.

**Character encoding (important).** ShareJS positions are **codepoint offsets** of the real
text (verified live: inserting after `é`, 1 codepoint, needs `p=2` in "AéB"). JavaScript
string indices are UTF-16 code units, which equal codepoints for BMP characters - and
Overleaf only preserves BMP text - so plain string indexing is correct. The server stores
real text but the transport mangles non-ASCII bytes, so Claudeleaf mirrors the browser: op
text is sent as raw UTF-8 (`JSON.stringify` keeps it literal and `ws` sends it as UTF-8);
incoming text (joinDoc lines, remote op text) arrives as a *byte-view* (each UTF-8 byte as a
Latin-1 code unit) and is decoded with `ot.decodeWireText`
(`Buffer.from(s,'latin1').toString('utf8')`). All BMP text round-trips (accents, CJK, Greek,
symbols); non-BMP/astral characters (emoji) are corrupted by Overleaf's own storage.

**Keepalive / presence.** Reply to `2::` with `2::`; reply to `serverPing` with `clientPong`
(echo args). `clientTracking.updatePosition` advertises the cursor;
`clientTracking.getConnectedUsers` lists collaborators.

**Tree mutations** (create/delete/rename) are HTTP: `POST /project/<id>/doc {name,
parent_folder_id}`, `DELETE /project/<id>/{doc|file|folder}/<id>`, `POST .../<type>/<id>
/rename` — all need the session cookie and the `ol-csrfToken` from the project HTML.

**Compiling** is HTTP (CSRF + cookie), not realtime. `POST /project/<id>/compile?auto_compile=true`
with body `{rootDoc_id, draft, check:"silent", incrementalCompilesEnabled, stopOnFirstError}`
→ `{status, outputFiles:[{path,type,build,url}], clsiServerId, ...}`. `status` is
`success`/`failure`/`timedout`/`error`/... — but note **LaTeX recovers and still emits a PDF
on most errors, so `status` is `success` even when the document has errors**; the errors must
be read from the log. `rootDoc_id` is effectively ignored (Overleaf compiles the project's
configured root), so we send `null`. Each output file's `url` is server-relative and needs
`?clsiserverid=<clsiServerId>` appended (sticky routing to the compile server that holds the
build) — without it the fetch 404s. `output.log` is the pdfTeX log; `output.pdf` is the PDF.
`logParser.ts` parses the log the way Overleaf's editor does: errors are `! ...` blocks (the
following `l.<n> <src>` pins the source line), warnings are `LaTeX/Package/Class ... Warning:`
(may wrap; `on input line <n>` gives the line), and bad boxes are `Overfull/Underfull`. Files
are attributed best-effort from the log's `(filename ... )` nesting. `ProjectSession.compile`
returns `{status, success, errors, warnings, log, outputFiles, pdfUrl}`.

## Reliability & concurrency model (in `ProjectSession`)

Node is single-threaded and event-driven, so the Python version's three threads
(reader/heartbeat/inbox-worker) collapse into the event loop. There are no locks on shared
state; instead:

- **Acks are Promises.** `emit` registers a `Deferred` keyed by message id; the `ws` `message`
  handler resolves it. Heartbeats are a `setInterval`.
- **Edits are serialized per document** with an async `Mutex`. The op-builder closure is
  re-run against the freshly-synced text on each attempt, so an edit recovers across a
  reconnect. Remote ops and resyncs run through the same per-doc mutex (queued behind any
  in-flight edit); confirmations are resolved directly in the event handler.
- **A fresh connection re-joins the project but not the docs.** Each Document records the
  connection generation it was joined on; an edit (or read) re-joins the doc if the
  generation changed. `joinDoc` is retried with backoff to ride out Overleaf's
  `joinLeaveEpoch mismatch` right after a reconnect.
- **Edits are confirmed, not just sent.** `submit` awaits the op-less `otUpdateApplied` (a
  `Deferred` resolved by the handler) before accepting the edit — no silent loss.
- **At-most-once on drops.** A frame never transmitted throws `NotTransmittedError` (safe to
  re-join + rebuild + resend). A frame that was sent but whose confirmation is lost/dropped is
  ambiguous: re-sync and throw `EditConflictError` rather than risk a duplicate.
- **Single-flight reconnect** prevents overlapping reconnect loops; `RealtimeConnection`
  re-runs the handshake (refreshing auth) and invokes `onReconnect` to re-join open docs.

## Design decisions

- **Protocol, not browser, at runtime.** Browser automation of CodeMirror is fragile and
  slow; the realtime protocol *is* the channel collaborators see. The browser is confined to
  the one-time manual login.
- **Account-scoped, project-per-operation.** A single instance lists and edits all projects.
- **Manual login, no stored credentials.** Sidesteps reCAPTCHA/SSO/2FA.
- **Zero required config.** Everything defaults; optional env vars only for advanced use.
- **Omit the ShareJS hash** (see above) — turns a fragile, fatal check into a non-issue.
- **MCP server stays minimal** — every tool is a one-line wrapper; the server stays alive
  until the client disconnects (stdin close), then exits. Each tool carries MCP
  `annotations`. `readOnlyHint` is `true` for the reads (`list_projects`, `project_info`,
  `list_documents`, `read_document`, `search`, `connected_users`, `compile`) and `false` for
  the writes. `compile` is read-only (it never mutates project content) but also
  `idempotentHint: false`, since each call kicks off a fresh build. The writes set
  `destructiveHint` explicitly (it would otherwise default to `true` whenever `readOnlyHint`
  is `false`): `true` for overwrite/remove tools (`replace_text`, `replace_range`,
  `delete_range`, `delete_lines`, `set_document`, `delete_document`), `false` for the purely
  additive ones (`insert_text`, `append_text`, `create_document`, and `rename_document` —
  which changes a name, losing no content).

## Configuration (optional environment variables)

No configuration is required. Overrides (mainly for self-hosted / tuning):

- `OVERLEAF_BASE_URL` — Overleaf instance base URL (default `https://www.overleaf.com`).
- `OVERLEAF_USER_AGENT` — User-Agent for the handshake/WebSocket.
- `CLAUDELEAF_HOME` — state dir (session + browser profile); default `~/.claudeleaf`.
- `CLAUDELEAF_SESSION_PATH`, `CLAUDELEAF_BROWSER_PROFILE` — override those paths.
- `CLAUDELEAF_LOGIN_TIMEOUT`, `CLAUDELEAF_CONNECT_TIMEOUT`, `CLAUDELEAF_REQUEST_TIMEOUT`,
  `CLAUDELEAF_COMPILE_TIMEOUT` (compiling can be slow; default 180), `CLAUDELEAF_HEARTBEAT_INTERVAL`
  — timeouts in seconds.
- `OVERLEAF_TEST_PROJECT` — project id/name the live tests operate on (default: the dev
  project).

## Public SDK surface

`OverleafClient` (account): `login()`, `isLoggedIn()`, `listProjects(refresh?)`,
`project(idOrName)` → `ProjectSession`. All document methods take a `project` (id or name) as
the first argument and are `async`: `projectInfo`, `listDocuments`, `readDocument`, `getLines`,
`documentVersion`, `search`, `insertAt`, `insert`, `append`, `deleteRange`, `replaceRange`,
`replaceText`, `setText`, `deleteLines`, `setCursor`, `getConnectedUsers`, `createDocument`,
`createFolder`, `deleteDocument`, `renameDocument`, `resync`, `compile`. `ProjectSession`
exposes the same methods without the leading `project` argument. Paths resolve by full path,
then id, then unique basename; `line`/`column` are 0-based and offsets are character indices
into the `\n`-joined text — **except** compile-log line numbers (`CompileResult.errors`/
`warnings[].line`), which are 1-based (LaTeX/editor convention). The MCP tools (`overleaf_*`,
each takes `project`) wrap the most common
operations — a curated subset of the SDK (e.g. `getLines`, `documentVersion`, `insertAt`,
`setCursor`, `createFolder`, `resync` have no dedicated tool); `overleaf_compile` triggers a
recompile and returns the status + parsed errors/warnings (and the raw log on request).

## Testing

`npm test` (vitest) runs **unit** tests (protocol/ot/document/config/edit-logic via a fake
realtime, the LaTeX-log parser, plus project resolution) with no network. **Integration** +
**MCP e2e** tests are in the same suite and auto-skip unless a cached session is valid (checked
at load time). To run them: `claudeleaf login` once, then `npm test` (override the target
project with `OVERLEAF_TEST_PROJECT`). They pick a writable project, operate on a dedicated
scratch document, and cover list-projects, project resolution by name, every edit op, BMP
unicode, create/delete, presence, transparent reconnect, remote-op propagation, compile (and
error detection by briefly breaking + restoring `main.tex`), and a full MCP-over-stdio round
trip. The MCP e2e test launches the server via `node --import tsx src/cli.ts mcp`.

## Publishing & CI

The package is distributed on npm so users can run it with `npx claudeleaf <cmd>` (and add the
MCP server with `npx -y claudeleaf mcp`) without cloning. What makes that work:

- `bin` → `dist/cli.js` (shebang preserved), `main`/`types`/`exports` → `dist/`, and
  `files: ["dist"]` so the published tarball ships only the compiled output. `prepublishOnly`
  runs `npm run build`, so `dist/` is always fresh on publish.
- `.github/workflows/publish.yml` — on push to `main` (or manual dispatch) it runs
  `npm ci && npm run build && npm test`, then publishes **only if `package.json`'s version is
  not already on the registry**. So a commit that bumps the version (`npm version patch`)
  releases it; any other commit is a no-op. Needs an `NPM_TOKEN` repo secret (an npm automation
  token with publish rights); `actions/setup-node` wires it in via `NODE_AUTH_TOKEN`.
- `.github/workflows/ci.yml` — typecheck + build + test on PRs and non-`main` pushes.
- In CI the live integration/MCP tests auto-skip (no cached session → no network), so `npm test`
  runs the unit suite only.

## Development notes

- `npm run build` compiles to `dist/` (the `bin` is `dist/cli.js`, shebang preserved).
  `npm run claudeleaf -- <args>` runs the CLI from source via `tsx`.
- Source uses NodeNext ESM, so intra-package imports carry `.js` extensions
  (`import { Config } from "./config.js"`) even though the files are `.ts`.
- The custom `ConnectionError`/`TimeoutError` in `errors.ts` are Claudeleaf classes (Node has
  no such globals); catch them via the package exports.
