import { describe, it, expect } from "vitest";

import { sameOriginUrl } from "../src/rest.js";

describe("sameOriginUrl", () => {
  const base = "https://www.overleaf.com";
  it("resolves server-relative paths, keeping the query", () => {
    expect(sameOriginUrl(base, "/project/abc/output/output.log?clsiserverid=x")).toBe(
      "https://www.overleaf.com/project/abc/output/output.log?clsiserverid=x",
    );
  });
  it("keeps a self-hosted base path", () => {
    expect(sameOriginUrl("https://tex.example.org/overleaf", "/project")).toBe("https://tex.example.org/overleaf/project");
  });
  it("refuses paths that would leave the Overleaf host", () => {
    for (const bad of ["@evil.example/x", "//evil.example/x", "https://evil.example/x", "evil", ""]) {
      expect(() => sameOriginUrl(base, bad)).toThrow(/refusing/);
    }
  });
});
