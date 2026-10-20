# Claudeleaf

Bring Claude (and any agent) into Overleaf. Claudeleaf is a reliable TypeScript bridge that drives the Overleaf web editor in real time — listing your projects, opening documents, reading them, and inserting/changing/deleting text — exactly as if a person were typing, so collaborators see the edits live. It ships as an SDK, a CLI, and an MCP server for Claude Code. One signed-in instance can work across **all** of your projects.

## Features

- **Real editing, not git.** Edits go through Overleaf's live collaboration channel (ShareJS over Socket.IO), so they appear instantly to everyone in the project, attributed to your user.
- **All your projects, one instance.** List every project you can access and edit any of them by id or name — no project configured up front.
- **Full document control** — list documents, read text, insert at a position or line/column, replace ranges or literal text, delete ranges or lines, replace a whole document, create/delete/rename files, and **upload images** (e.g. a local W&B plot PNG) for `\includegraphics`: `claudeleaf upload <project> plot.png --folder figures` or the `overleaf_upload_file` MCP tool.
- **Review mode (track changes).** Submit any edit as a tracked change (a suggestion) with `trackChanges` instead of a direct edit, so a human accepts or rejects it in Overleaf. Requires track changes on the project (a premium feature).
- **Comments.** Anchor a comment to a span of text (like selecting text and commenting in the editor) and list a document's comments with their threads.
- **Compile & error logs** — trigger a LaTeX recompile and get back the status plus the parsed errors and warnings (with file and line), or the full raw log.
- **Reliable by design** — automatic reconnect with document re-join, per-document edit serialization, and server-confirmed edits (no silent loss).
- **Zero config, easy sign-in.** No credentials stored and nothing to configure: run `claudeleaf login` once, sign in by hand in the browser that opens (handles reCAPTCHA / SSO / 2FA), and the session is cached.
- **Three ways to use it** — a TypeScript SDK, a CLI, and an MCP server so Claude Code can work on your projects autonomously.
- **Self-hosting friendly** — point it at any Overleaf instance with one environment variable.

## Getting Started

You don't need to clone or install anything — just [Node.js](https://nodejs.org/) 20+ (which
provides `npx`). Sign in once, then run any command:

```bash
npx claudeleaf login       # opens your browser; sign in by hand (handles reCAPTCHA/SSO/2FA)
npx claudeleaf doctor      # checks the session and lists your projects
```

`login` drives your installed **Google Chrome** (or Microsoft Edge); no browser download is
needed. The session is cached under `~/.claudeleaf`, so every later command reuses it.

> **Recommended: sign in as a dedicated bot account.** Every edit is attributed to whoever is
> signed in, so create a separate Overleaf account for the agent, invite it into your project
> as a collaborator (**Share → Can edit**), and run `claudeleaf login` as that account. Then
> every change the bot makes shows up under the bot's name in Overleaf's history — transparent,
> easy to review or revert, and clearly distinct from your own edits.

> Tip: `npx claudeleaf@latest …` always fetches the newest release. To avoid the per-run
> fetch, install it once with `npm install -g claudeleaf` and then just run `claudeleaf …`.

### Use the CLI

Every document command takes a project (id or name) followed by the document path:

```bash
npx claudeleaf projects                               # list all your projects
npx claudeleaf ls "My Paper"                          # list documents
npx claudeleaf cat "My Paper" main.tex                # print a document
npx claudeleaf append "My Paper" main.tex "\\section{New}"
npx claudeleaf replace "My Paper" main.tex "foo" "bar"
npx claudeleaf search "My Paper" main.tex "\\section"
npx claudeleaf compile "My Paper"                     # recompile; print errors/warnings
npx claudeleaf compile "My Paper" --warnings --log    # also show warnings + the raw log
```

Suggest an edit instead of making it, and comment on a span of text:

```bash
# review mode: a tracked change for a human to accept or reject
npx claudeleaf replace "My Paper" main.tex "foo" "bar" --track-changes

# comment on the [start, end) character span (use `search` to find offsets)
npx claudeleaf search "My Paper" main.tex "Introduction"   # -> offset 772
npx claudeleaf comment "My Paper" main.tex 772 784 "Should this be shorter?"
npx claudeleaf comments "My Paper" main.tex                # list comments + threads
```

### Use it with Claude Code (MCP)

Register the MCP server (no clone needed), then ask Claude to work on any of your projects:

```bash
claude mcp add claudeleaf -- npx -y claudeleaf mcp
```

The tools reuse the session from `claudeleaf login` (they won't pop a browser). Claude can
`overleaf_list_projects`, then read, edit, and compile documents in any project by id or name.

It can also work in **review mode** rather than editing directly — the seven tools that write
document text (`insert_text`, `append_text`, `replace_text`, `replace_range`, `delete_range`,
`delete_lines`, `set_document`) take `trackChanges: true` to leave a tracked suggestion — and
comment on the text with `overleaf_add_comment` / `overleaf_list_comments`. For example:

> "Read main.tex, then suggest a tighter abstract as tracked changes and leave a comment on
> the title explaining why."

### Use the SDK

```bash
npm install claudeleaf
```

```ts
import { OverleafClient } from "claudeleaf";

const client = new OverleafClient(); // account-scoped; uses the cached session
for (const p of await client.listProjects()) {
  console.log(p.id, p.name);
}
await client.append("My Paper", "main.tex", "\n% added by an agent\n");
await client.replaceText("My Paper", "main.tex", "Your Paper", "Our Paper");

// review mode: submit as a tracked change for a human to accept or reject
await client.replaceText("My Paper", "main.tex", "utilise", "use", 0, { trackChanges: true });

// comment on a span of text, then read the document's comments back
await client.addComment("My Paper", "main.tex", 772, 784, "Should this be shorter?");
for (const c of await client.listComments("My Paper", "main.tex")) {
  console.log(c.line, c.text, c.messages.map((m) => m.content));
}

const compile = await client.compile("My Paper");
console.log(compile.status, compile.errors); // errors carry { message, file, line }
```

### Develop locally

```bash
git clone <this repo> && cd claudeleaf
npm install
npm run claudeleaf -- login   # run the CLI from source via tsx
npm test                      # unit tests (live tests auto-skip without a session)
npm run build                 # compile to dist/
```

## Notes

- Claudeleaf edits the live document. Use Overleaf's history to review or revert changes — or
  make the edit a suggestion in the first place with `--track-changes` / `trackChanges`.
- Track changes is an Overleaf **premium** feature. On a project without it the edit still
  applies, just as a normal edit rather than a suggestion. Comments work on any project.
- Comment threads can be created and listed, but not resolved or deleted — Overleaf does not
  expose those routes.
- The cached session is a credential; it lives under `~/.claudeleaf` with restrictive permissions.
