# Claudeleaf

Bring Claude (and any agent) into Overleaf. Claudeleaf is a reliable TypeScript bridge that drives the Overleaf web editor in real time — listing your projects, opening documents, reading them, and inserting/changing/deleting text — exactly as if a person were typing, so collaborators see the edits live. It ships as an SDK, a CLI, and an MCP server for Claude Code. One signed-in instance can work across **all** of your projects.

## Features

- **Real editing, not git.** Edits go through Overleaf's live collaboration channel (ShareJS over Socket.IO), so they appear instantly to everyone in the project, attributed to your user.
- **All your projects, one instance.** List every project you can access and edit any of them by id or name — no project configured up front.
- **Full document control** — list documents, read text, insert at a position or line/column, replace ranges or literal text, delete ranges or lines, replace a whole document, and create/delete/rename files.
- **Review mode (track changes).** Submit any edit as a tracked change (a suggestion) with `trackChanges` instead of a direct edit, so a human accepts or rejects it in Overleaf. Requires track changes on the project (a premium feature).
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

### Use it with Claude Code (MCP)

Register the MCP server (no clone needed), then ask Claude to work on any of your projects:

```bash
claude mcp add claudeleaf -- npx -y claudeleaf mcp
```

The tools reuse the session from `claudeleaf login` (they won't pop a browser). Claude can
`overleaf_list_projects`, then read, edit, and compile documents in any project by id or name.

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

- Claudeleaf edits the live document. Use Overleaf's history to review or revert changes.
- The cached session is a credential; it lives under `~/.claudeleaf` with restrictive permissions.
