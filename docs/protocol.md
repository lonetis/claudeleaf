# Overleaf realtime protocol (reverse-engineered)

This documents the wire protocol claudeleaf speaks, with real captured frames, so the
implementation can be understood, debugged, and extended. It targets Overleaf.com; a
self-hosted instance using the same `real-time` service behaves the same.

## 1. Authentication

`GET /login` serves a form with invisible reCAPTCHA (sitekey
`6LebiTwUAAAAAMuPyjA4pDA4jxPxPe2K9_ndL74Q`), and accounts may use SSO/2FA. Claudeleaf does
**not** automate credentials: `claudeleaf login` opens a real browser (Playwright, system
Chrome preferred, persistent profile) and waits for the user to sign in by hand; success
is detected when the dashboard exposes a non-empty `ol-user_id` meta. It then extracts and
caches:

- `overleaf_session2` — the session cookie (the only credential the realtime layer needs),
- `deviceHistory` — marks the device as known.

Everything afterward is pure HTTP/WebSocket using the cached cookie.

## 1b. Listing projects

The account's projects come from the dashboard JSON API. Scrape `ol-csrfToken` from
`GET /project`, then `POST /api/project` (with `X-CSRF-Token`) returns
`{totalSize, projects:[{id, name, accessLevel, archived, trashed, lastUpdated, owner, …}]}`.
This is account-level — no project id required.

## 2. Socket.IO 0.9 handshake

```
GET /socket.io/1/?projectId=<projectId>&esh=1&ssp=1&t=<unix_ms>
Cookie: overleaf_session2=...
```

Response body (text):

```
0Juj6WIo8pHUQUnqgslM:60:60:websocket,xhr-polling
└──────── sid ──────┘ hb close transports
```

The response also sets `GCLB=<value>` — a Google load-balancer **affinity cookie**. It
**must** be sent on the subsequent WebSocket, otherwise the session lives on a different
backend and the server immediately errors `7:::1+0` and closes. Claudeleaf keeps the
handshake response`s `Set-Cookie` so the GCLB value is forwarded.

## 3. WebSocket

```
wss://www.overleaf.com/socket.io/1/websocket/<sid>?projectId=<projectId>&esh=1&ssp=1
Cookie: overleaf_session2=...; GCLB=...
Origin: https://www.overleaf.com
```

### Frame format

`<type>:<id>:<endpoint>:<data>` — the endpoint is always empty for Overleaf.

| type | meaning | notes |
| --- | --- | --- |
| `0` | disconnect | server is closing the socket → reconnect |
| `1` | connect | first frame after connecting |
| `2` | heartbeat | reply with `2::` |
| `5` | event | `5:<id>+::<json>` requests an ack; `5:::<json>` does not |
| `6` | ack | `6:::<id>+<json>` (or `6:::<id>` with no payload) |
| `7` | error | e.g. `7:::1+0` = not handshaken |
| `8` | noop | |

## 4. Session lifecycle (captured)

```
recv 1::                                          # connected
recv 5:::{"name":"joinProjectResponse","args":[{"publicId":"P.knM…","project":{
          "_id":"…","name":"Claude","rootDoc_id":"…","rootFolder":[{ "docs":[…],
          "fileRefs":[…],"folders":[…] }],"owner":{…},"members":[…]},
          "permissionsLevel":"readAndWrite"}]}
send 5:1+::{"name":"clientTracking.getConnectedUsers"}
send 5:2+::{"name":"joinDoc","args":["<docId>",{"encodeRanges":true}]}
recv 6:::2+[null,["\\documentclass{article}", … <lines> …], 1]   # [err, lines, version]
send 5:::{"name":"clientTracking.updatePosition","args":[{"row":0,"column":0,"doc_id":"<docId>"}]}
send 5:3+::{"name":"applyOtUpdate","args":["<docId>",{"doc":"<docId>",
          "op":[{"p":498,"i":"REVPROBE_HELLO "}],"v":0}]}
recv 6:::3                                          # ack (received)
recv 5:::{"name":"otUpdateApplied","args":[{"v":0,"doc":"<docId>"}]}   # applied (our confirmation)
```

`joinProjectResponse` is sent automatically because `projectId` is in the query string.
The project tree is at `args[0].project`.

## 5. ShareJS operations

The document is its lines joined with `\n`. An **op** is a list of components applied
left-to-right; each component's `p` is an offset into the text produced by the previous
components.

- Insert: `{"p": offset, "i": "text"}`
- Delete: `{"p": offset, "d": "text"}` — the deleted text must match exactly.
- Replace = delete then insert at the same offset, in one op.

`applyOtUpdate` carries `{"doc", "op", "v"}` (`v` = the version it is based on). After it
applies, the version is `v+1`.

**Encoding.** Op `p` values are **codepoint offsets** of the real text (e.g. inserting
after `é` in "AéB" uses `p=2`). The server stores real text, but the transport mangles
non-ASCII bytes, so: op text goes on the wire as raw UTF-8 (`JSON.stringify` keeps it literal, like the
browser), and text coming back (joinDoc lines, remote op text) is a *byte-view* — each
UTF-8 byte appears as one Latin-1 code unit — decoded with `Buffer.from(s,'latin1').toString('utf8')`.
Positions pass through unchanged. All BMP text (accents, CJK, Greek, symbols) round-trips;
non-BMP/astral characters (emoji) are corrupted by Overleaf's own storage and are not
supported.

### Confirmation vs. remote (captured with two clients)

When **we** edit, the server sends us an **op-less** confirmation:

```
recv 5:::{"name":"otUpdateApplied","args":[{"v":1,"doc":"<docId>"}]}
```

Every **other** connected client receives the **op-ful** form, which they apply locally:

```
recv 5:::{"name":"otUpdateApplied","args":[{"doc":"<docId>",
          "op":[{"p":7088,"i":"\nFROM-OTHER\n"}],"v":1,
          "meta":{"source":"P.…","user_id":"…","ts":…}}]}
```

Claudeleaf uses the op-less form as proof an edit applied, and applies the op-ful form to
its mirror (resyncing on a version gap).

## 6. The hash (and why we omit it)

Overleaf optionally accepts a `hash` on `applyOtUpdate`. It is a **git-blob SHA-1**:
`sha1("blob " + byte_length + "\0" + content)` (implemented in `ot.gitBlobHash`,
matched exactly against real client frames). The server's verification is brittle: a
mismatch yields `otUpdateError "Invalid hash"` **and disconnects** the client:

```
recv 5:::{"name":"otUpdateError","args":["Invalid hash",{…}]}
recv 0::
```

The field is optional, so Claudeleaf omits it — verified that inserts and deletes apply
cleanly with no hash and no disconnect. This trades a fragile, fatal check for robustness.

## 7. Keepalive & presence

- Heartbeat: reply to any `2…` frame with `2::`; also send `2::` periodically.
- `serverPing` event → reply `clientPong` echoing the args:
  `recv 5:::{"name":"serverPing","args":[0,<ts>,"websocket","<id>"]}`.
- `clientTracking.updatePosition {row,column,doc_id}` advertises the cursor.
- `clientTracking.getConnectedUsers` (ack) lists collaborators.

## 8. Disconnect & reconnect

`0::` (or a transport error) means the socket is gone. Claudeleaf re-runs the handshake
(refreshing the session if it has expired) and reconnects. Crucially, a fresh connection
has re-joined the **project** but **not the documents** — each doc must be `joinDoc`-ed
again before it will receive remote ops or accept edits. Right after a reconnect, an
eager `joinDoc` can be rejected with `{"message":"joinLeaveEpoch mismatch"}` while the
server cleans up the old connection, so claudeleaf retries `joinDoc` with a short backoff.

## 9. Project-tree mutations (HTTP, not realtime)

These need the session cookie and the `ol-csrfToken` (scraped from the project HTML page,
sent as `X-CSRF-Token`):

```
POST   /project/<id>/doc      {name, parent_folder_id}      -> {_id, …}
POST   /project/<id>/folder   {name, parent_folder_id}
DELETE /project/<id>/doc|file|folder/<entityId>
POST   /project/<id>/doc|file|folder/<entityId>/rename  {name}
```

The mutation is broadcast back over the realtime socket as `reciveNewDoc`,
`removeEntity`, `reciveEntityRename`, etc.; Claudeleaf updates its local tree from those
(and directly from REST responses for its own mutations).

## 10. Compiling (HTTP, not realtime)

Also CSRF + cookie. Compile is a plain HTTP request; the result references output files on a
specific compile server.

```
POST /project/<id>/compile?auto_compile=true
     {rootDoc_id, draft, check:"silent", incrementalCompilesEnabled, stopOnFirstError}
  -> {status, outputFiles:[{path,type,build,url}], clsiServerId, compileGroup, …}
```

- `status` is `success` / `failure` / `timedout` / `error` / …  **Caveat: LaTeX recovers from
  most errors and still produces a PDF, so `status` is usually `success` even when the source
  has errors.** The errors live in the log, not the status.
- `rootDoc_id` is effectively ignored — Overleaf compiles the project's configured root — so
  send `null`.
- Each `outputFiles[].url` is server-relative and **must** have `?clsiserverid=<clsiServerId>`
  appended (sticky routing to the server that holds this build); without it the fetch 404s.
  `GET <baseUrl><url>?clsiserverid=<id>` with the cookie returns the file. `output.log` is the
  pdfTeX log; `output.pdf` is the PDF.

The log is parsed (`src/logParser.ts`) the way Overleaf's editor does: errors are `! …`
blocks with a following `l.<n> <source>` line, warnings are `LaTeX/Package/Class … Warning:`
(with `on input line <n>`), and bad boxes are `Overfull/Underfull`. Files are attributed
best-effort from the log's `(filename … )` nesting.
