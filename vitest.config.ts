import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run files sequentially: live tests share one Overleaf account/project.
    fileParallelism: false,
  },
});
