import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Node's native TypeScript type-stripping becomes unflagged (no
 * `--experimental-strip-types` needed) starting in **Node 22.18.0** (see the
 * package README's "Node version requirement" section). This package's
 * `src/index.js` entry point re-exports `.ts` sources directly, so whether a
 * consumer can import `@tkl/raw-evidence-store` with a *plain*, unflagged
 * `node -e "import(...)"` is a version-dependent contract:
 *   - below 22.18.0, a plain unflagged import must fail -- the flag is
 *     required, and this package cannot pass it on a consuming process's
 *     behalf;
 *   - at/above 22.18.0, a plain unflagged import must succeed.
 *
 * This suite runs the real, version-appropriate half of that contract
 * against whichever Node binary is actually executing the tests, instead of
 * assuming one outcome or skipping the check when the local runtime (for
 * example Node 22.14, still below the 22.18.0 floor) cannot exercise the
 * other half -- so it can never falsely pass by checking the wrong branch or
 * checking nothing at all.
 */

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function parseNodeVersion(versionString: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versionString);
  if (!match) throw new Error(`Unrecognized Node version string: ${versionString}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(version: [number, number, number], floor: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== floor[index]) return version[index] > floor[index];
  }
  return true;
}

function runEntryImport(extraArgs: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      ...extraArgs,
      "-e",
      "import('@tkl/raw-evidence-store').then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })",
    ],
    { cwd: packageDirectory, encoding: "utf-8" },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

const UNFLAGGED_STRIPPING_FLOOR: [number, number, number] = [22, 18, 0];
const currentVersion = parseNodeVersion(process.version);
const supportsUnflaggedStripping = isAtLeast(currentVersion, UNFLAGGED_STRIPPING_FLOOR);

test(
  supportsUnflaggedStripping
    ? `a plain, unflagged import of the package entry point succeeds on Node ${process.version} (>=22.18.0)`
    : `a plain, unflagged import of the package entry point fails on Node ${process.version} (<22.18.0), ` +
      "requiring --experimental-strip-types",
  () => {
    const { status, stderr } = runEntryImport([]);
    if (supportsUnflaggedStripping) {
      assert.equal(
        status,
        0,
        `expected a plain unflagged import to succeed on Node ${process.version}, but it exited ` +
          `${status}: ${stderr}`,
      );
    } else {
      assert.notEqual(
        status,
        0,
        `expected a plain unflagged import to fail on Node ${process.version} (below the 22.18.0 ` +
          "unflagged-stripping floor), but it succeeded",
      );
      assert.match(stderr, /strip|type stripping|Unknown file extension|\.ts\b/i);
    }
  },
);

test(
  "--experimental-strip-types always makes the package entry point importable, " +
    "regardless of the unflagged-stripping floor",
  () => {
    const { status, stderr } = runEntryImport(["--experimental-strip-types"]);
    assert.equal(
      status,
      0,
      `expected the --experimental-strip-types import to succeed on Node ${process.version}, but it ` +
        `exited ${status}: ${stderr}`,
    );
  },
);
