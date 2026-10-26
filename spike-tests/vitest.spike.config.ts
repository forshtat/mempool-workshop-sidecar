import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import vitestConfig from "../vitest.base.config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Spike A test config. Isolated from the repo's own suites on purpose:
 * - only files under spike-tests/ are collected
 * - coverage is off (these are probes, not shipped tests)
 * - threads off / maxConcurrency 1, inherited from vitest.base.config
 *
 * `resolve.alias` below is the important part. Workspace source imports
 * `@skandha/<pkg>/lib/<path>`, which normally resolves to each package's built
 * `lib/` output - absent in this clone (nothing has been built, and building
 * would write outside spike-tests/). The aliases point those specifiers at the
 * packages' `src/` trees instead, so a probe can import real implementation
 * code with no build step and no edit to any package.
 *
 * Run with: bunx vitest run --config spike-tests/vitest.spike.config.ts
 */
const WORKSPACE_PACKAGES = [
  "types",
  "utils",
  "params",
  "db",
  "monitoring",
  "executor",
  "api",
  "node",
  "cli",
];

export default defineConfig({
  ...(vitestConfig as any),
  root,
  resolve: {
    alias: [
      // `@skandha/<pkg>/lib/x/y.js` -> `<root>/packages/<pkg>/src/x/y` (Vite adds .ts)
      {
        find: /^(@skandha\/[a-z-]+\/lib\/.*)\.js$/,
        replacement: "$1",
      },
      ...WORKSPACE_PACKAGES.map((pkg) => ({
        find: `@skandha/${pkg}/lib`,
        replacement: path.join(root, "packages", pkg, "src"),
      })),
      // direct src imports, e.g. `@skandha/types/src/contracts/FrameTx`
      ...WORKSPACE_PACKAGES.map((pkg) => ({
        find: `@skandha/${pkg}/src`,
        replacement: path.join(root, "packages", pkg, "src"),
      })),
    ],
  },
  test: {
    ...(vitestConfig as any).test,
    include: ["spike-tests/**/*.spike.test.ts"],
    coverage: { enabled: false } as any,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
