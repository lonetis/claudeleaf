import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadCachedCookies, validateCookies } from "../src/auth.js";
import { OverleafClient } from "../src/client.js";
import { Config } from "../src/config.js";

const config = Config.fromEnv();
const cookies = loadCachedCookies(config);
const hasSession = cookies !== null && (await validateCookies(config, cookies));

const TEST_PROJECT = process.env.OVERLEAF_TEST_PROJECT || "6a3d5db5d05194a82760d74b";
const SCRATCH = "claudeleaf_mcp_vitest.tex";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function toolText(res: { content: unknown }): string {
  const content = res.content as { type: string; text?: string }[];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe.skipIf(!hasSession)("mcp e2e", () => {
  let client: OverleafClient;
  let project: string;

  beforeAll(async () => {
    client = new OverleafClient(config);
    const projects = await client.listProjects();
    project = projects.some((p) => p.id === TEST_PROJECT)
      ? TEST_PROJECT
      : projects.find((p) => p.accessLevel === "owner" || p.accessLevel === "readAndWrite")!.id;
    const existing = (await client.listDocuments(project)).map((d) => d.path);
    if (existing.includes(SCRATCH)) await client.deleteDocument(project, SCRATCH);
    await client.createDocument(project, SCRATCH);
  });

  afterAll(async () => {
    try {
      await client.deleteDocument(project, SCRATCH);
    } catch {
      /* best effort */
    }
    client?.close();
  });

  it("drives the server over stdio like Claude does", async () => {
    // Launch the server exactly as it is deployed (via tsx for tests / node dist in prod).
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(repoRoot, "src", "cli.ts"), "mcp"],
      env: process.env as Record<string, string>,
      cwd: repoRoot,
    });
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await mcp.connect(transport);
    try {
      const tools = await mcp.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      expect(names.has("overleaf_list_projects")).toBe(true);
      expect(names.has("overleaf_read_document")).toBe(true);
      expect(names.has("overleaf_append_text")).toBe(true);
      expect(names.has("overleaf_compile")).toBe(true);

      const listed = await mcp.callTool({ name: "overleaf_list_projects", arguments: {} });
      expect(toolText(listed as { content: unknown })).toContain(project);

      await mcp.callTool({
        name: "overleaf_append_text",
        arguments: { project, path: SCRATCH, text: "MCP-E2E-MARKER\n" },
      });
      const readBack = await mcp.callTool({
        name: "overleaf_read_document",
        arguments: { project, path: SCRATCH },
      });
      expect(toolText(readBack as { content: unknown })).toContain("MCP-E2E-MARKER");

      const compiled = await mcp.callTool({ name: "overleaf_compile", arguments: { project } });
      const compileText = toolText(compiled as { content: unknown });
      expect(compileText).toContain('"status"');
      expect(JSON.parse(compileText)).toHaveProperty("success");
    } finally {
      await mcp.close();
    }
  });
});
