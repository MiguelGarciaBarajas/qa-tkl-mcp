import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  REPO_ROOT,
  compareVersions,
  minimumFromEnginesRange,
  npmInvocation,
  runInherited,
} from "./lib/exec.mjs";

/**
 * QA-101 local aggregate quality gate.
 *
 * Runs, in the same order and with the same commands as `.github/workflows/pr-quality-gate.yml`,
 * every check that guards a pull request:
 *
 *   lint -> typecheck -> build -> unit -> contract -> integration -> secret scan
 *        -> dependency audit -> end-to-end (real Chromium)
 *
 * Contract of this script:
 *
 * - Exit codes propagate. A step's real exit code (or the signal that killed it) is
 *   recorded and the gate exits non-zero if any step did not exit 0.
 * - There is no success-shaped fallback. A step that cannot start is a failure, not a
 *   skip. `--skip-e2e` is allowed for a fast inner loop but produces the verdict
 *   `INCOMPLETE` and exit code 2 - it can never print `PASSED`.
 * - The live smoke test (`npm run smoke:live`, LIVE-101) is opt-in via
 *   `--with-live-smoke`, is never run by CI, and never substitutes for another step.
 *   Passing it cannot make an otherwise failing gate green.
 * - The Node floor from `package.json` `engines.node` is enforced before anything runs.
 *   `--allow-node-floor-mismatch` downgrades that single precondition to a recorded
 *   warning, and the verdict then states the runtime was non-conforming.
 *
 * Usage:
 *   npm run gate
 *   npm run gate -- --skip-e2e
 *   npm run gate -- --keep-going
 *   npm run gate -- --with-live-smoke
 */

const USAGE = `Usage: node scripts/ci/quality-gate.mjs [options]

  --skip-e2e                    Skip the Chromium end-to-end step. Verdict becomes
                                INCOMPLETE (exit 2); never PASSED.
  --keep-going                  Run every remaining step after a failure instead of
                                stopping at the first one.
  --with-live-smoke             Additionally run the opt-in live-source smoke test.
                                Requires approved live credentials in the environment.
  --allow-node-floor-mismatch   Record a below-floor Node runtime as a warning instead
                                of failing the precondition.
  --help                        Print this message.
`;

/**
 * @param {string[]} argv
 */
function parseArguments(argv) {
  const options = {
    skipE2e: false,
    keepGoing: false,
    withLiveSmoke: false,
    allowNodeFloorMismatch: false,
    help: false,
  };

  for (const argument of argv) {
    switch (argument) {
      case "--skip-e2e":
        options.skipE2e = true;
        break;
      case "--keep-going":
        options.keepGoing = true;
        break;
      case "--with-live-smoke":
        options.withLiveSmoke = true;
        break;
      case "--allow-node-floor-mismatch":
        options.allowNodeFloorMismatch = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}\n\n${USAGE}`);
    }
  }

  return options;
}

/**
 * @returns {{ floor: string | null, current: string, satisfied: boolean }}
 */
function checkNodeFloor() {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const floor = minimumFromEnginesRange(manifest?.engines?.node);
  const current = process.versions.node;
  return {
    floor,
    current,
    satisfied: floor === null ? false : compareVersions(current, floor) >= 0,
  };
}

/** @returns {string} the Node version CI pins through `.nvmrc`. */
function readPinnedCiNodeVersion() {
  return readFileSync(path.join(REPO_ROOT, ".nvmrc"), "utf8").trim();
}

/**
 * @typedef {{ id: string, title: string, display: string, command: string, args: string[] }} Step
 */

/**
 * @param {string} id
 * @param {string} title
 * @param {string[]} args
 * @returns {Step}
 */
function npmStep(id, title, args) {
  const invocation = npmInvocation(args);
  return { id, title, display: `npm ${args.join(" ")}`, command: invocation.command, args: invocation.args };
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} scriptName
 * @returns {Step}
 */
function nodeStep(id, title, scriptName) {
  const scriptPath = path.join(REPO_ROOT, "scripts", "ci", scriptName);
  return {
    id,
    title,
    display: `node scripts/ci/${scriptName}`,
    command: process.execPath,
    args: [scriptPath],
  };
}

/**
 * @param {ReturnType<typeof parseArguments>} options
 * @returns {Step[]}
 */
function buildSteps(options) {
  /** @type {Step[]} */
  const steps = [
    npmStep("lint", "Lint", ["run", "lint"]),
    npmStep("typecheck", "Typecheck", ["run", "typecheck"]),
    npmStep("build", "Build", ["run", "build"]),
    npmStep("unit", "Unit tests", ["test"]),
    npmStep("contract", "Contract tests", ["run", "test:contract"]),
    npmStep("integration", "Integration tests", ["run", "test:integration"]),
    nodeStep("secret-scan", "Secret scan", "secret-scan.mjs"),
    nodeStep("dependency-audit", "Dependency audit policy", "dependency-audit.mjs"),
  ];

  if (!options.skipE2e) {
    steps.push(npmStep("e2e", "End-to-end tests (real Chromium)", ["run", "test:e2e"]));
  }

  if (options.withLiveSmoke) {
    steps.push(
      npmStep("live-smoke", "Live-source smoke test (opt-in, not part of CI)", [
        "run",
        "smoke:live",
      ]),
    );
  }

  return steps;
}

/**
 * @param {number} milliseconds
 * @returns {string}
 */
function formatDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${(seconds % 60).toFixed(0).padStart(2, "0")}s`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const node = checkNodeFloor();
  const pinnedCiVersion = readPinnedCiNodeVersion();

  process.stdout.write(
    "TKL quality gate (QA-101)\n" +
      `  repository:      ${REPO_ROOT}\n` +
      `  node (local):    v${node.current}\n` +
      `  node (engines):  ${node.floor === null ? "unreadable engines.node range" : `>=${node.floor}`}\n` +
      `  node (CI pin):   v${pinnedCiVersion} (.nvmrc)\n\n`,
  );

  /** @type {string[]} */
  const warnings = [];

  if (node.floor === null) {
    process.stderr.write(
      'Precondition FAILED: package.json engines.node is not a ">=x.y.z" range, so the ' +
        "gate cannot verify the runtime floor.\n",
    );
    return 1;
  }

  if (!node.satisfied) {
    const message =
      `this runtime is v${node.current}, below the repository floor >=${node.floor}; ` +
      `CI runs v${pinnedCiVersion}, so a local pass is weaker evidence than a CI pass`;
    if (!options.allowNodeFloorMismatch) {
      process.stderr.write(
        `Precondition FAILED: ${message}.\n` +
          "Install a conforming Node version, or re-run with --allow-node-floor-mismatch " +
          "to record the mismatch explicitly.\n",
      );
      return 1;
    }
    warnings.push(`node-floor: ${message}`);
    process.stdout.write(`WARNING  ${message}\n\n`);
  }

  const steps = buildSteps(options);
  /** @type {{ step: Step, exitCode: number, signal: string | null, durationMs: number, ran: boolean }[]} */
  const results = [];
  let firstFailureIndex = -1;

  for (const [index, step] of steps.entries()) {
    if (firstFailureIndex !== -1 && !options.keepGoing) {
      results.push({ step, exitCode: -1, signal: null, durationMs: 0, ran: false });
      continue;
    }

    process.stdout.write(`\n=== [${index + 1}/${steps.length}] ${step.title} ===\n$ ${step.display}\n`);
    const startedAt = Date.now();
    const outcome = await runInherited(step.command, step.args);
    const durationMs = Date.now() - startedAt;

    if (outcome.spawnError) {
      process.stderr.write(
        `Step "${step.id}" could not start: ${outcome.spawnError.message}\n` +
          "A step that cannot run is a gate failure, not a skip.\n",
      );
    }

    results.push({
      step,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      durationMs,
      ran: true,
    });

    if (outcome.exitCode !== 0 && firstFailureIndex === -1) {
      firstFailureIndex = index;
    }
  }

  process.stdout.write("\n=== Quality gate summary ===\n");
  for (const result of results) {
    if (!result.ran) {
      process.stdout.write(`  NOT RUN  ${result.step.id.padEnd(18)} (an earlier step failed)\n`);
      continue;
    }
    const status = result.exitCode === 0 ? "PASS" : "FAIL";
    const signal = result.signal ? ` signal=${result.signal}` : "";
    process.stdout.write(
      `  ${status.padEnd(8)} ${result.step.id.padEnd(18)} exit=${result.exitCode}${signal} ` +
        `${formatDuration(result.durationMs)}\n`,
    );
  }

  if (options.skipE2e) {
    warnings.push("e2e: skipped by --skip-e2e; the browser slice was not verified");
  }
  for (const warning of warnings) {
    process.stdout.write(`  WARNING  ${warning}\n`);
  }

  const failed = results.filter((result) => result.ran && result.exitCode !== 0);
  const notRun = results.filter((result) => !result.ran);

  if (failed.length > 0) {
    process.stderr.write(
      `\nVerdict: FAILED (${failed.length} failing step(s)` +
        (notRun.length > 0 ? `, ${notRun.length} not run` : "") +
        ").\n",
    );
    return 1;
  }

  if (options.skipE2e) {
    process.stdout.write(
      "\nVerdict: INCOMPLETE. Every executed step passed, but --skip-e2e means the " +
        "end-to-end coverage CI requires was not exercised. This is not a pass.\n",
    );
    return 2;
  }

  if (warnings.length > 0) {
    process.stdout.write(
      "\nVerdict: PASSED with a non-conforming environment. Every gate step passed, but " +
        "the warnings above mean CI remains the authoritative result.\n",
    );
    return 0;
  }

  process.stdout.write("\nVerdict: PASSED. Every gate step exited 0.\n");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `Quality gate could not complete: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
