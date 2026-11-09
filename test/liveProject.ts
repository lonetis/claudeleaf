import { OverleafClient } from "../src/client.js";
import type { Config } from "../src/config.js";

const DEV_PROJECT = "6a3d5db5d05194a82760d74b";

/**
 * The project the live tests may write to: `OVERLEAF_TEST_PROJECT` (id or exact name), or the
 * maintainers' dev project. Returns its id, or null when the signed-in account cannot access it.
 *
 * Never falls back to some other writable project: the suites create and delete documents and
 * the compile test overwrites `main.tex` for a moment, so a fallback would run them against a
 * real paper of whoever happens to be signed in.
 */
export async function resolveTestProject(config: Config): Promise<string | null> {
  const wanted = process.env.OVERLEAF_TEST_PROJECT || DEV_PROJECT;
  const projects = await new OverleafClient(config).listProjects();
  const hit =
    projects.find((p) => p.id === wanted.toLowerCase()) ??
    projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    console.warn(
      `live tests skipped: test project ${JSON.stringify(wanted)} is not accessible to the ` +
        "signed-in account (set OVERLEAF_TEST_PROJECT to a throwaway project you own)",
    );
    return null;
  }
  return hit.id;
}
