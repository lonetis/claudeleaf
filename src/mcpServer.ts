/**
 * MCP server exposing Overleaf to Claude.
 *
 * A thin wrapper over {@link OverleafClient}. One account-scoped client is shared across
 * calls; every project/document tool takes a `project` (id or name), so one server works
 * across all of the account's projects. Sign in first with `claudeleaf login` - the tools
 * reuse that cached session (they will not pop a browser).
 *
 * Positions: `line`/`column` are 0-based; `offset`/`start`/`end` are character offsets.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { OverleafClient } from "./client.js";
import { Config } from "./config.js";

let client: OverleafClient | null = null;

function getClient(): OverleafClient {
  if (!client) client = new OverleafClient(Config.fromEnv());
  return client;
}

function result(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

/** Shared schema fragment: submit the edit as a review-mode tracked change (suggestion). */
const trackChanges = z
  .boolean()
  .optional()
  .describe(
    "Submit as a tracked change (review-mode suggestion) instead of a direct edit, for a " +
      "human to accept or reject. Inserts become tracked insertions; deletions keep the removed " +
      "text struck through. Requires track changes to be available on the project (premium).",
  );

export function createServer(): McpServer {
  const server = new McpServer({ name: "claudeleaf", version: "0.3.0" });

  server.registerTool(
    "overleaf_list_projects",
    {
      description: "List every Overleaf project the signed-in account can access (id, name, access).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => result(await getClient().listProjects()),
  );

  server.registerTool(
    "overleaf_project_info",
    {
      description: "Get metadata about a project (name, owner, members, compiler). `project` is an id or name.",
      inputSchema: { project: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => result(await getClient().projectInfo(project)),
  );

  server.registerTool(
    "overleaf_list_documents",
    {
      description: "List the documents in a project. Set includeFiles=true to also list binary files.",
      inputSchema: { project: z.string(), includeFiles: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, includeFiles }) =>
      result(await getClient().listDocuments(project, includeFiles ?? false)),
  );

  server.registerTool(
    "overleaf_read_document",
    {
      description: "Read the full text of a document, identified by its path (e.g. 'main.tex') or id.",
      inputSchema: { project: z.string(), path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, path }) => result(await getClient().readDocument(project, path)),
  );

  server.registerTool(
    "overleaf_search",
    {
      description: "Find every occurrence of a literal string in a document. Returns offset/line/column.",
      inputSchema: { project: z.string(), path: z.string(), query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, path, query }) => result(await getClient().search(project, path, query)),
  );

  server.registerTool(
    "overleaf_insert_text",
    {
      description: "Insert text at a 0-based line and column. Collaborators see the edit live.",
      inputSchema: { project: z.string(), path: z.string(), line: z.number().int(), column: z.number().int(), text: z.string(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ project, path, line, column, text, trackChanges }) => {
      const doc = await getClient().insert(project, path, line, column, text, { trackChanges });
      return result({ ok: true, path: doc.path, version: doc.version, length: doc.length });
    },
  );

  server.registerTool(
    "overleaf_append_text",
    {
      description: "Append text to the end of a document (a newline is added if needed).",
      inputSchema: { project: z.string(), path: z.string(), text: z.string(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ project, path, text, trackChanges }) => {
      const doc = await getClient().append(project, path, text, { trackChanges });
      return result({ ok: true, path: doc.path, version: doc.version, length: doc.length });
    },
  );

  server.registerTool(
    "overleaf_replace_text",
    {
      description: "Replace literal occurrences of `old` with `new`. count=0 replaces all.",
      inputSchema: { project: z.string(), path: z.string(), old: z.string(), new: z.string(), count: z.number().int().optional(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path, old, new: newStr, count, trackChanges }) => {
      const n = await getClient().replaceText(project, path, old, newStr, count ?? 0, { trackChanges });
      return result({ ok: true, path, replaced: n });
    },
  );

  server.registerTool(
    "overleaf_replace_range",
    {
      description: "Replace the text between character offsets [start, end) with `text`.",
      inputSchema: { project: z.string(), path: z.string(), start: z.number().int(), end: z.number().int(), text: z.string(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path, start, end, text, trackChanges }) => {
      const doc = await getClient().replaceRange(project, path, start, end, text, { trackChanges });
      return result({ ok: true, path: doc.path, version: doc.version, length: doc.length });
    },
  );

  server.registerTool(
    "overleaf_delete_range",
    {
      description: "Delete the text between character offsets [start, end).",
      inputSchema: { project: z.string(), path: z.string(), start: z.number().int(), end: z.number().int(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path, start, end, trackChanges }) => {
      const doc = await getClient().deleteRange(project, path, start, end, { trackChanges });
      return result({ ok: true, path: doc.path, version: doc.version, length: doc.length });
    },
  );

  server.registerTool(
    "overleaf_delete_lines",
    {
      description: "Delete 0-based lines startLine..endLine (inclusive).",
      inputSchema: { project: z.string(), path: z.string(), startLine: z.number().int(), endLine: z.number().int(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path, startLine, endLine, trackChanges }) => {
      const doc = await getClient().deleteLines(project, path, startLine, endLine, { trackChanges });
      return result({ ok: true, path: doc.path, version: doc.version, length: doc.length });
    },
  );

  server.registerTool(
    "overleaf_set_document",
    {
      description: "Replace a document's entire contents with `content` (sent as a minimal diff).",
      inputSchema: { project: z.string(), path: z.string(), content: z.string(), trackChanges },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path, content, trackChanges }) => {
      const doc = await getClient().setText(project, path, content, { trackChanges });
      return result({ ok: true, path: doc.path, version: doc.version, length: doc.length });
    },
  );

  server.registerTool(
    "overleaf_create_document",
    {
      description: "Create a new document. `folder` is a folder path, or omit for the project root.",
      inputSchema: { project: z.string(), name: z.string(), folder: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ project, name, folder }) => {
      const res = await getClient().createDocument(project, name, folder);
      return result({ ok: true, name, id: res._id });
    },
  );

  server.registerTool(
    "overleaf_upload_file",
    {
      description:
        "Upload an image/figure (png, jpg, gif, svg, pdf, eps; max 50 MB) so LaTeX can \\includegraphics it. " +
        "Give `path` (a local file path) or `base64` + `name`. `folder` defaults to the project root. " +
        "A same-named file in the folder is replaced.",
      inputSchema: {
        project: z.string(),
        path: z.string().optional(),
        base64: z.string().optional(),
        name: z.string().optional(),
        folder: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path, base64, name, folder }) => {
      if (!path === !base64) throw new Error("provide exactly one of `path` or `base64`");
      const source = path ?? Buffer.from(base64 as string, "base64");
      const res = await getClient().uploadFile(project, source, folder, name);
      return result({ ok: true, path: res.path, id: res._id });
    },
  );

  server.registerTool(
    "overleaf_delete_document",
    {
      description: "Delete a document or file from a project.",
      inputSchema: { project: z.string(), path: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ project, path }) => {
      await getClient().deleteDocument(project, path);
      return result({ ok: true, deleted: path });
    },
  );

  server.registerTool(
    "overleaf_rename_document",
    {
      description: "Rename a document or file.",
      inputSchema: { project: z.string(), path: z.string(), newName: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ project, path, newName }) => {
      await getClient().renameDocument(project, path, newName);
      return result({ ok: true, path, newName });
    },
  );

  server.registerTool(
    "overleaf_connected_users",
    {
      description: "List users currently connected to a project (name, email, cursor position).",
      inputSchema: { project: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => result(await getClient().getConnectedUsers(project)),
  );

  server.registerTool(
    "overleaf_add_comment",
    {
      description:
        "Attach a comment to a span of text (like selecting text in the editor and commenting). " +
        "`start`/`end` are character offsets into the `\\n`-joined document — use overleaf_search " +
        "to find them. The commented text is not changed; the comment appears in Overleaf's review " +
        "panel, attributed to the signed-in user.",
      inputSchema: { project: z.string(), path: z.string(), start: z.number().int(), end: z.number().int(), message: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ project, path, start, end, message }) => {
      const c = await getClient().addComment(project, path, start, end, message);
      return result({ ok: true, threadId: c.threadId, commented: c.text, line: c.line, column: c.column });
    },
  );

  server.registerTool(
    "overleaf_list_comments",
    {
      description:
        "List the comments anchored in a document — each with its commented text span, position " +
        "(offset/line/column), resolved state, and thread of messages.",
      inputSchema: { project: z.string(), path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, path }) => result(await getClient().listComments(project, path)),
  );

  server.registerTool(
    "overleaf_compile",
    {
      description:
        "Recompile a project's LaTeX and return the status and parsed log. `errors`/`warnings` " +
        "list problems with file and line (line is 1-based, like the editor — subtract 1 for the " +
        "0-based insert/delete tools); they can be non-empty even when the compile succeeded " +
        "(LaTeX recovers). Set includeLog=true to also return the full raw output.log.",
      inputSchema: {
        project: z.string(),
        draft: z.boolean().optional(),
        stopOnFirstError: z.boolean().optional(),
        includeLog: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ project, draft, stopOnFirstError, includeLog }) => {
      const r = await getClient().compile(project, { draft, stopOnFirstError });
      return result({
        status: r.status,
        success: r.success,
        errors: r.errors,
        warnings: r.warnings,
        pdfUrl: r.pdfUrl,
        ...(includeLog ? { log: r.log } : {}),
      });
    },
  );

  return server;
}

/** Run the MCP server over stdio (the transport Claude Code expects). Resolves when the
 * client disconnects (stdin closes), so the process keeps serving until then. */
export async function run(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const prev = transport.onclose;
    transport.onclose = () => {
      prev?.();
      resolve();
    };
  });
}
