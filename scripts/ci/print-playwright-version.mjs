import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/exec.mjs";

/**
 * Prints `version=<locked @playwright/test version>` in `GITHUB_OUTPUT` format.
 *
 * The value comes from the committed lockfile rather than from an installed
 * `node_modules` tree, so the Playwright browser cache key is resolved *before* the
 * install step and always matches the version `npm ci` is about to install.
 */

const LOCKFILE = path.join(REPO_ROOT, "package-lock.json");
const PACKAGE_KEY = "node_modules/@playwright/test";

function resolveLockedPlaywrightVersion() {
  const lockfile = JSON.parse(readFileSync(LOCKFILE, "utf8"));
  const entry = lockfile?.packages?.[PACKAGE_KEY];
  const version = entry?.version;
  if (typeof version !== "string" || version === "") {
    throw new Error(
      `Could not resolve a locked version for "${PACKAGE_KEY}" in package-lock.json. ` +
        "Refusing to emit an unpinned Playwright cache key.",
    );
  }
  return version;
}

try {
  process.stdout.write(`version=${resolveLockedPlaywrightVersion()}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
