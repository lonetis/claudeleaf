import { describe, it, expect } from "vitest";

import { Config, parseProjectId } from "../src/config.js";
import { Document } from "../src/document.js";

describe("Document", () => {
  it("loads and views", () => {
    const doc = new Document("d1", "main.tex", "main.tex");
    doc.loadFromLines(["a", "bb", "ccc"], 4);
    expect(doc.text).toBe("a\nbb\nccc");
    expect(doc.version).toBe(4);
    expect(doc.loaded).toBe(true);
    expect(doc.lines).toEqual(["a", "bb", "ccc"]);
    expect(doc.length).toBe(8);
  });
  it("applies ops", () => {
    const doc = new Document("d1", "m", "m");
    doc.loadFromLines(["hello"], 0);
    doc.applyOp([{ p: 5, i: " world" }]);
    expect(doc.text).toBe("hello world");
  });
  it("position helpers", () => {
    const doc = new Document("d1", "m", "m");
    doc.loadFromLines(["abc", "de"], 0);
    expect(doc.rowcolToOffset(1, 0)).toBe(4);
    expect(doc.offsetToRowcol(4)).toEqual([1, 0]);
    expect(doc.lineStartOffset(1)).toBe(4);
  });
});

describe("parseProjectId", () => {
  it("from URL", () => {
    expect(parseProjectId("https://www.overleaf.com/project/6a3d5db5d05194a82760d74b")).toBe(
      "6a3d5db5d05194a82760d74b",
    );
  });
  it("from bare id (lowercased)", () => {
    expect(parseProjectId("6A3D5DB5D05194A82760D74B")).toBe("6a3d5db5d05194a82760d74b");
  });
  it("name returns null", () => {
    expect(parseProjectId("My Paper")).toBeNull();
  });
});

describe("Config", () => {
  it("defaults", () => {
    const cfg = new Config();
    expect(cfg.baseUrl).toBe("https://www.overleaf.com");
    expect(cfg.host).toBe("www.overleaf.com");
    expect(cfg.wsScheme).toBe("wss");
    expect(cfg.projectUrl("a".repeat(24))).toContain("/project/" + "a".repeat(24));
  });
  it("self-hosted base url", () => {
    const cfg = new Config({ baseUrl: "http://overleaf.local" });
    expect(cfg.baseUrl).toBe("http://overleaf.local");
    expect(cfg.wsScheme).toBe("ws");
    expect(cfg.host).toBe("overleaf.local");
  });
  it("cookie domain strips the port", () => {
    const cfg = new Config({ baseUrl: "https://overleaf.example.com:8443" });
    expect(cfg.host).toBe("overleaf.example.com:8443");
    expect(cfg.cookieDomain).toBe("overleaf.example.com");
  });
  it("normalizes a scheme-less base url", () => {
    const cfg = new Config({ baseUrl: "overleaf.example.com" });
    expect(cfg.baseUrl).toBe("https://overleaf.example.com");
    expect(cfg.cookieDomain).toBe("overleaf.example.com");
  });
  it("fromEnv needs no required vars", () => {
    const cfg = Config.fromEnv();
    expect(cfg.baseUrl).toBe(process.env.OVERLEAF_BASE_URL || "https://www.overleaf.com");
  });
});
