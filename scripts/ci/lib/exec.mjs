import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Shared process helpers for the QA-101 quality gate scripts.
 *
 * Every helper surfaces the real exit status. Nothing here converts a failure, a signal,
 * or a spawn error into a success-shaped result: a step that could not run is reported
 * as a failure, never as "skipped and therefore fine".
 */

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * Runs a command with inherited stdio and resolves with its real termination status.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ exitCode: number, signal: NodeJS.Signals | null, spawnError: Error | null }>}
 */
export function runInherited(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: false,
    });

    child.once("error", (error) => {
      resolve({ exitCode: 1, signal: null, spawnError: error });
    });

    child.once("close", (code, signal) => {
      if (signal !== null) {
        resolve({ exitCode: 1, signal, spawnError: null });
        return;
      }
      resolve({ exitCode: code ?? 1, signal: null, spawnError: null });
    });
  });
}

/**
 * Runs a command and captures its output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, maxBuffer?: number }} [options]
 * @returns {{ exitCode: number, signal: NodeJS.Signals | null, stdout: string, stderr: string, spawnError: Error | null }}
 */
export function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    shell: false,
  });

  if (result.error) {
    return {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: String(result.error.message ?? result.error),
      spawnError: result.error,
    };
  }

  return {
    exitCode: result.signal !== null ? 1 : (result.status ?? 1),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: null,
  };
}

/**
 * `npm` is a shell script on POSIX and a `.cmd` shim on Windows. Since Node 18.20/20.12
 * (CVE-2024-27980) `spawn`/`spawnSync` refuse to execute a `.cmd` file without a shell,
 * so on Windows the invocation is routed through `cmd.exe` explicitly instead of setting
 * `shell: true` globally - that would change how *every* argument of *every* command is
 * quoted, and therefore what the gate actually executes.
 *
 * Only fixed, space-free npm arguments are passed through here.
 *
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function npmInvocation(args) {
  for (const argument of args) {
    if (/[\s"&|<>^%]/.test(argument)) {
      throw new Error(`Refusing to pass an unquotable npm argument: ${JSON.stringify(argument)}`);
    }
  }
  if (process.platform === "win32") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
  }
  return { command: "npm", args };
}

/**
 * Parses a semantic version into comparable parts. Throws on anything that is not a
 * plain `major.minor.patch` triple with an optional prerelease/build suffix.
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    throw new Error(`Unsupported version string: ${JSON.stringify(version)}`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number} negative when `left` is older, 0 when equal, positive when newer.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Reads the minimum Node version from a `>=x.y.z` engines range. Returns `null` for any
 * other range shape rather than guessing a floor.
 *
 * @param {string | undefined} range
 * @returns {string | null}
 */
export function minimumFromEnginesRange(range) {
  if (typeof range !== "string") return null;
  const match = /^>=\s*v?(\d+\.\d+\.\d+)$/.exec(range.trim());
  return match ? match[1] : null;
}
