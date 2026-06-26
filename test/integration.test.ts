import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadCachedCookies, validateCookies } from "../src/auth.js";
import { OverleafClient } from "../src/client.js";
import { Config } from "../src/config.js";
import { sleep } from "../src/util.js";

const config = Config.fromEnv();
const cookies = loadCachedCookies(config);
const hasSession = cookies !== null && (await validateCookies(config, cookies));

const TEST_PROJECT = process.env.OVERLEAF_TEST_PROJECT || "6a3d5db5d05194a82760d74b";
const SCRATCH = "claudeleaf_vitest.tex";
const BASELINE = "Line zero\nLine one\nLine two\n";

async function waitFor(predicate: () => Promise<boolean>, timeout = 15000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(300);
  }
  return predicate();
}

describe.skipIf(!hasSession)("integration", () => {
  let client: OverleafClient;
  let project: string;

  beforeAll(async () => {
    client = new OverleafClient(config);
    const projects = await client.listProjects();
    const ids = new Set(projects.map((p) => p.id));
    if (ids.has(TEST_PROJECT)) {
      project = TEST_PROJECT;
    } else {
      const writable = projects.find(
        (p) => (p.accessLevel === "owner" || p.accessLevel === "readAndWrite") && !p.archived && !p.trashed,
      );
      if (!writable) throw new Error("no writable project available");
      project = writable.id;
    }
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

  beforeEach(async () => {
    await client.setText(project, SCRATCH, BASELINE);
  });

  // -- account / projects --
  it("lists projects", async () => {
    const projects = await client.listProjects();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects[0]).toHaveProperty("id");
    expect(projects[0]).toHaveProperty("accessLevel");
  });

  it("resolves a project by name", async () => {
    const name = (await client.projectInfo(project)).name;
    expect((await client.project(name)).id).toBe(project);
  });

  // -- read / navigate --
  it("project info", async () => {
    const info = await client.projectInfo(project);
    expect(info.name).toBeTruthy();
    expect(info.id).toBe(project);
  });

  it("lists documents", async () => {
    const docs = await client.listDocuments(project);
    expect(docs.some((d) => d.type === "doc")).toBe(true);
    expect(docs.every((d) => d.type === "doc")).toBe(true);
  });

  it("reads main.tex", async () => {
    expect(await client.readDocument(project, "main.tex")).toContain("\\documentclass");
  });

  // -- editing --
  it("append persists", async () => {
    await client.append(project, SCRATCH, "APPENDED-XYZ\n");
    expect(await client.readDocument(project, SCRATCH)).toContain("APPENDED-XYZ");
    await client.resync(project, SCRATCH);
    expect(await client.readDocument(project, SCRATCH)).toContain("APPENDED-XYZ");
  });

  it("insert at offset", async () => {
    await client.insertAt(project, SCRATCH, 0, ">>");
    expect((await client.readDocument(project, SCRATCH)).startsWith(">>Line zero")).toBe(true);
  });

  it("insert at line/column", async () => {
    await client.insert(project, SCRATCH, 1, 0, "X");
    expect((await client.getLines(project, SCRATCH))[1]).toBe("XLine one");
  });

  it("replace text (all)", async () => {
    expect(await client.replaceText(project, SCRATCH, "Line", "Row")).toBe(3);
    const text = await client.readDocument(project, SCRATCH);
    expect(text).toContain("Row zero");
    expect(text).not.toContain("Line");
  });

  it("replace range", async () => {
    await client.replaceRange(project, SCRATCH, 0, 4, "Word");
    expect((await client.readDocument(project, SCRATCH)).startsWith("Word zero")).toBe(true);
  });

  it("delete range", async () => {
    await client.deleteRange(project, SCRATCH, 0, 5);
    expect((await client.readDocument(project, SCRATCH)).startsWith("zero")).toBe(true);
  });

  it("delete lines", async () => {
    await client.deleteLines(project, SCRATCH, 0, 0);
    expect((await client.getLines(project, SCRATCH))[0]).toBe("Line one");
  });

  it("set text", async () => {
    await client.setText(project, SCRATCH, "totally new\ncontent\n");
    await client.resync(project, SCRATCH);
    expect(await client.readDocument(project, SCRATCH)).toBe("totally new\ncontent\n");
  });

  it("search", async () => {
    const hits = await client.search(project, SCRATCH, "Line");
    expect(hits.length).toBe(3);
    expect(hits[0].line).toBe(0);
  });

  it("version increments", async () => {
    const v0 = await client.documentVersion(project, SCRATCH);
    await client.append(project, SCRATCH, "x");
    expect(await client.documentVersion(project, SCRATCH)).toBe(v0 + 1);
  });

  it("BMP unicode round-trips", async () => {
    const content = "café résumé\nNaïve Schrödinger\n中文测试\nα + β = γ — ok\n";
    await client.setText(project, SCRATCH, content);
    await client.resync(project, SCRATCH);
    expect(await client.readDocument(project, SCRATCH)).toBe(content);
  });

  it("edit position with a multi-byte char", async () => {
    await client.setText(project, SCRATCH, "AéB");
    await client.insertAt(project, SCRATCH, 2, "X"); // codepoint offset 2 = after 'é'
    await client.resync(project, SCRATCH);
    expect(await client.readDocument(project, SCRATCH)).toBe("AéXB");
    await client.replaceText(project, SCRATCH, "é", "e");
    await client.resync(project, SCRATCH);
    expect(await client.readDocument(project, SCRATCH)).toBe("AeXB");
  });

  // -- presence & structure --
  it("connected users", async () => {
    expect(Array.isArray(await client.getConnectedUsers(project))).toBe(true);
  });

  it("create and delete a document", async () => {
    const name = "claudeleaf_tmp_create.tex";
    const existing = (await client.listDocuments(project)).map((d) => d.path);
    if (existing.includes(name)) await client.deleteDocument(project, name);
    await client.createDocument(project, name);
    expect((await client.listDocuments(project)).some((d) => d.path === name)).toBe(true);
    await client.append(project, name, "temp\n");
    expect(await client.readDocument(project, name)).toContain("temp");
    await client.deleteDocument(project, name);
    expect((await client.listDocuments(project)).some((d) => d.path === name)).toBe(false);
  });

  // -- reliability --
  it("reconnect is transparent", async () => {
    await client.readDocument(project, SCRATCH); // ensure the doc is open
    const session = await client.project(project);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rt.socket?.terminate(); // forcefully drop the socket
    await sleep(1500);
    await client.append(project, SCRATCH, "AFTER-RECONNECT\n"); // should transparently recover
    await client.resync(project, SCRATCH);
    expect(await client.readDocument(project, SCRATCH)).toContain("AFTER-RECONNECT");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).rt.isConnected).toBe(true);
  });

  it("remote op is received", async () => {
    await client.setText(project, SCRATCH, "shared baseline\n");
    await client.readDocument(project, SCRATCH); // open + subscribe
    const other = new OverleafClient(config);
    try {
      await other.append(project, SCRATCH, "FROM-OTHER-CLIENT\n");
      const seen = await waitFor(
        async () => (await client.readDocument(project, SCRATCH)).includes("FROM-OTHER-CLIENT"),
        15000,
      );
      expect(seen).toBe(true);
    } finally {
      other.close();
    }
  });

  // -- compile --
  it("compiles and returns status, log and output files", async () => {
    const r = await client.compile(project);
    expect(typeof r.status).toBe("string");
    expect(r.outputFiles.length).toBeGreaterThan(0);
    expect(r.log.length).toBeGreaterThan(0);
    expect(r.outputFiles.some((f) => f.path === "output.pdf")).toBe(true);
    expect(r.pdfUrl).toContain("output.pdf");
  });

  it("surfaces LaTeX errors with line numbers (break + restore main.tex)", async () => {
    const original = await client.readDocument(project, "main.tex");
    const broken = "\\documentclass{article}\n\\begin{document}\nok\n\\undefinedcommandhere\n\\end{document}\n";
    try {
      await client.setText(project, "main.tex", broken);
      const r = await client.compile(project);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => /Undefined control sequence/i.test(e.message))).toBe(true);
      expect(r.errors.some((e) => e.line === 4)).toBe(true);
    } finally {
      await client.setText(project, "main.tex", original);
    }
  });
});
