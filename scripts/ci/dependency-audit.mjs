import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, npmInvocation, runCaptured } from "./lib/exec.mjs";

/**
 * QA-101 dependency and supply-chain audit policy.
 *
 * Uses the npm registry advisory database through `npm audit`, which is already part of
 * this repository's ecosystem and needs no extra account, license, or token. Findings are
 * resolved from the committed lockfile (`--package-lock-only`), so the gate audits
 * exactly what `npm ci` will install and does not need `node_modules` to exist.
 *
 * Fail-closed contract: if `npm audit` cannot reach the registry, returns output this
 * script cannot parse, or reports an error object, the gate FAILS. "No findings" is only
 * ever reported after a successful advisory lookup.
 *
 * Policy (also documented in docs/runbooks/ci-quality-gate.md):
 *
 *   | Scope       | Severity          | Fix available | Decision |
 *   |-------------|-------------------|---------------|----------|
 *   | production  | critical, high    | any           | BLOCK    |
 *   | production  | moderate          | yes           | BLOCK    |
 *   | production  | moderate, low     | no            | WARN     |
 *   | production  | low               | yes           | WARN     |
 *   | development | critical, high    | yes           | BLOCK    |
 *   | development | anything else     | any           | WARN     |
 *
 * "Production" means the advisory is still reachable when development dependencies are
 * omitted - the graph that a deployed TKL process actually loads. Everything else is
 * build/test tooling that never runs in a deployed environment, so it is reported but
 * does not block a pull request unless it is both severe and fixable.
 *
 * A WARN is never silent: every warning is printed with its advisory id and package.
 * A BLOCK can only be suppressed by a reviewed, dated, expiring entry in
 * `.github/dependency-audit-waivers.json`; an expired or malformed waiver fails the gate.
 */

const WAIVERS_PATH = path.join(REPO_ROOT, ".github", "dependency-audit-waivers.json");
const MAX_WAIVER_DAYS = 90;
const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];

/**
 * @param {string[]} extraArguments
 * @returns {Record<string, unknown>}
 */
function runAudit(extraArguments) {
  const args = ["audit", "--json", "--package-lock-only", ...extraArguments];
  const invocation = npmInvocation(args);
  const result = runCaptured(invocation.command, invocation.args);

  if (result.spawnError) {
    throw new Error(`Could not start "npm ${args.join(" ")}": ${result.spawnError.message}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `"npm ${args.join(" ")}" did not produce parseable JSON (exit ${result.exitCode}).\n` +
        `stderr: ${result.stderr.trim() || "(empty)"}\n` +
        "Refusing to report a clean audit from an unreadable result.",
    );
  }

  if (report && typeof report === "object" && "error" in report) {
    const detail = /** @type {{ error: { code?: string, summary?: string, detail?: string } }} */ (
      report
    ).error;
    const described = [detail?.code, detail?.summary, detail?.detail]
      .filter((part) => typeof part === "string" && part.trim() !== "")
      .join(" | ");
    throw new Error(
      `"npm ${args.join(" ")}" failed (exit ${result.exitCode}): ` +
        `${described || JSON.stringify(detail ?? null)}\n` +
        `stderr: ${result.stderr.trim() || "(empty)"}`,
    );
  }

  if (typeof report?.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new Error(
      `"npm ${args.join(" ")}" returned an unexpected report shape (exit ${result.exitCode}). ` +
        "Refusing to report a clean audit.",
    );
  }

  return report;
}

/**
 * Flattens an npm audit v2 report into one entry per (advisory, package) pair.
 *
 * @param {Record<string, any>} report
 * @returns {Map<string, { advisory: string, package: string, severity: string, title: string, url: string, fixAvailable: boolean, fixIsBreaking: boolean, direct: boolean }>}
 */
function collectFindings(report) {
  /** @type {Map<string, any>} */
  const findings = new Map();

  for (const [packageName, entry] of Object.entries(report.vulnerabilities ?? {})) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    const advisories = via.filter((item) => item && typeof item === "object");

    // A package whose `via` holds only strings is vulnerable transitively; the advisory
    // itself is attributed to the package named in those strings, which is reported on
    // its own entry. Keeping it here would double-count the same advisory.
    if (advisories.length === 0) continue;

    for (const advisory of advisories) {
      const identifier = advisoryIdentifier(advisory);
      const key = `${identifier}::${packageName}`;
      if (findings.has(key)) continue;
      findings.set(key, {
        advisory: identifier,
        package: packageName,
        severity: String(advisory.severity ?? entry.severity ?? "unknown").toLowerCase(),
        title: String(advisory.title ?? "(no title)"),
        url: String(advisory.url ?? ""),
        fixAvailable: entry.fixAvailable !== false,
        fixIsBreaking: Boolean(entry.fixAvailable?.isSemVerMajor),
        direct: Boolean(entry.isDirect),
      });
    }
  }

  return findings;
}

/**
 * @param {{ source?: unknown, url?: unknown }} advisory
 * @returns {string}
 */
function advisoryIdentifier(advisory) {
  const url = typeof advisory.url === "string" ? advisory.url : "";
  const ghsa = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(url);
  if (ghsa) return ghsa[0].toUpperCase();
  if (advisory.source !== undefined && advisory.source !== null) return `npm:${advisory.source}`;
  return "unknown-advisory";
}

function loadWaivers() {
  let raw;
  try {
    raw = readFileSync(WAIVERS_PATH, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${path.relative(REPO_ROOT, WAIVERS_PATH)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.waivers)) {
    throw new Error("The dependency audit waiver file must contain a `waivers` array.");
  }

  const today = new Date();
  return parsed.waivers.map((waiver, index) => {
    for (const field of ["id", "package", "scope", "reason", "approvedBy", "approvedOn", "expires"]) {
      if (typeof waiver?.[field] !== "string" || waiver[field].trim() === "") {
        throw new Error(`Waiver ${index} is missing a non-empty "${field}".`);
      }
    }
    if (waiver.scope !== "production" && waiver.scope !== "development") {
      throw new Error(`Waiver ${index} has scope "${waiver.scope}"; expected production or development.`);
    }

    const approvedOn = new Date(`${waiver.approvedOn}T00:00:00Z`);
    const expires = new Date(`${waiver.expires}T23:59:59Z`);
    if (Number.isNaN(approvedOn.getTime()) || Number.isNaN(expires.getTime())) {
      throw new Error(`Waiver ${index} has an unparseable date; expected YYYY-MM-DD.`);
    }
    const spanDays = (expires.getTime() - approvedOn.getTime()) / 86_400_000;
    if (spanDays > MAX_WAIVER_DAYS) {
      throw new Error(`Waiver ${index} lasts ${Math.round(spanDays)} days; the maximum is ${MAX_WAIVER_DAYS}.`);
    }
    if (expires.getTime() < today.getTime()) {
      throw new Error(
        `Waiver ${index} for ${waiver.id} (${waiver.package}) expired on ${waiver.expires}. ` +
          "Re-review the advisory instead of extending the waiver silently.",
      );
    }

    return waiver;
  });
}

/**
 * @param {{ severity: string, fixAvailable: boolean }} finding
 * @param {"production" | "development"} scope
 * @returns {"BLOCK" | "WARN"}
 */
function decide(finding, scope) {
  const severity = SEVERITY_ORDER.includes(finding.severity) ? finding.severity : "critical";

  if (scope === "production") {
    if (severity === "critical" || severity === "high") return "BLOCK";
    if (severity === "moderate" && finding.fixAvailable) return "BLOCK";
    return "WARN";
  }

  if ((severity === "critical" || severity === "high") && finding.fixAvailable) return "BLOCK";
  return "WARN";
}

/**
 * @param {any} finding
 * @param {"production" | "development"} scope
 * @param {string} decision
 * @returns {string}
 */
function format(finding, scope, decision) {
  const fix = finding.fixAvailable
    ? finding.fixIsBreaking
      ? "fix: available (semver-major)"
      : "fix: available"
    : "fix: none published";
  return (
    `  ${decision.padEnd(6)} ${scope.padEnd(11)} ${finding.severity.padEnd(8)} ` +
    `${finding.advisory} ${finding.package} - ${finding.title} [${fix}]` +
    (finding.url ? ` ${finding.url}` : "")
  );
}

function main() {
  const waivers = loadWaivers();

  const fullReport = runAudit([]);
  const productionReport = runAudit(["--omit=dev"]);

  const allFindings = collectFindings(fullReport);
  const productionFindings = collectFindings(productionReport);

  const totals = fullReport?.metadata?.vulnerabilities ?? {};
  process.stdout.write(
    "Dependency audit (npm registry advisories, resolved from package-lock.json)\n" +
      `  advisories reported: ${allFindings.size} ` +
      `(critical ${totals.critical ?? 0}, high ${totals.high ?? 0}, ` +
      `moderate ${totals.moderate ?? 0}, low ${totals.low ?? 0})\n` +
      `  reachable without development dependencies: ${productionFindings.size}\n`,
  );

  const blocking = [];
  const warnings = [];
  const waived = [];

  for (const [key, finding] of allFindings) {
    const scope = productionFindings.has(key) ? "production" : "development";
    const decision = decide(finding, scope);

    if (decision === "BLOCK") {
      const waiver = waivers.find(
        (candidate) =>
          candidate.id.toUpperCase() === finding.advisory.toUpperCase() &&
          candidate.package === finding.package &&
          candidate.scope === scope,
      );
      if (waiver) {
        waived.push(format(finding, scope, "WAIVED") + ` (expires ${waiver.expires}: ${waiver.reason})`);
        continue;
      }
      blocking.push(format(finding, scope, "BLOCK"));
      continue;
    }

    warnings.push(format(finding, scope, "WARN"));
  }

  for (const line of waived) process.stdout.write(`${line}\n`);
  for (const line of warnings) process.stdout.write(`${line}\n`);

  if (warnings.length > 0) {
    process.stdout.write(
      `  ${warnings.length} non-blocking finding(s): development-only, or production with no published fix ` +
        "below the blocking threshold. Tracked, not ignored - see docs/runbooks/ci-quality-gate.md.\n",
    );
  }

  if (blocking.length === 0) {
    process.stdout.write(
      `Dependency audit passed: 0 blocking findings, ${warnings.length} warning(s), ${waived.length} waived.\n`,
    );
    return 0;
  }

  process.stderr.write(`\nDependency audit FAILED with ${blocking.length} blocking finding(s):\n`);
  for (const line of blocking) process.stderr.write(`${line}\n`);
  process.stderr.write(
    "\nUpgrade the affected dependency, or record a reviewed, expiring waiver in " +
      ".github/dependency-audit-waivers.json.\n",
  );
  return 1;
}

export { collectFindings, advisoryIdentifier, decide, loadWaivers };

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `Dependency audit could not complete: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
