import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { SessionManager } from "../src/auth.js";
import { Config } from "../src/config.js";
import { AuthError } from "../src/errors.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claudeleaf-"));
}

describe("SessionManager.cookies", () => {
  it("throws when there is no session (with or without forceRefresh)", () => {
    const sm = new SessionManager(new Config({ home: tmpHome() }));
    expect(() => sm.cookies()).toThrow(AuthError);
    expect(() => sm.cookies(true)).toThrow(AuthError);
  });

  it("returns the cached cookies even with forceRefresh (regression for realtime reconnect)", () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, "session.json"),
      JSON.stringify({ baseUrl: "https://www.overleaf.com", cookies: { overleaf_session2: "abc" } }),
    );
    const sm = new SessionManager(new Config({ home }));
    expect(sm.cookies()).toEqual({ overleaf_session2: "abc" });
    // forceRefresh must re-read disk and return the session, NOT throw.
    expect(sm.cookies(true)).toEqual({ overleaf_session2: "abc" });
  });
});
