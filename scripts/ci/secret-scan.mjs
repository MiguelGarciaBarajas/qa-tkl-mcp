import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, runCaptured } from "./lib/exec.mjs";

/**
 * QA-101 secret scan.
 *
 * Scans the repository for committed credentials using only Node and `git`. It needs no
 * service account, no API key, and no network access, so it behaves identically on a
 * contributor's machine and on a GitHub Actions runner - and it can never "pass" because
 * a token for an external scanning service was missing.
 *
 * Two modes, both enforced in CI:
 *
 *   node scripts/ci/secret-scan.mjs                     scan every tracked file
 *   node scripts/ci/secret-scan.mjs --diff-base <ref>   scan lines a branch added
 *
 * The second mode catches a credential that a pull request introduced and a later commit
 * on the same branch deleted, which a working-tree scan alone cannot see.
 *
 * Scope limit, stated plainly: this scanner does not walk the repository's full history.
 * GitHub secret scanning with push protection is the platform control for history and
 * for provider-validated tokens; see docs/runbooks/ci-quality-gate.md.
 *
 * Findings are reported as rule id, path, line number, and a redacted preview. The
 * matched value is never printed, so the gate's own logs cannot become the leak.
 */

const ALLOWLIST_PATH = path.join(REPO_ROOT, ".github", "secret-scan-allowlist.json");
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bmp",
  ".bz2",
  ".class",
  ".dll",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tgz",
  ".ttf",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/**
 * Values that look like a credential slot but are deliberately not one. Matching any of
 * these markers downgrades a generic finding to "not a secret" - narrowly, and only for
 * the low-precision generic rule.
 */
const PLACEHOLDER_MARKERS = [
  "${",
  "{{",
  "<",
  "env://",
  "secret://",
  "process.env",
  "example",
  "sample",
  "placeholder",
  "changeme",
  "change-me",
  "redacted",
  "dummy",
  "fake",
  "invalid",
  "your-",
  "your_",
  "todo",
  "none",
  "null",
  "undefined",
  "xxxx",
];

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} description
 * @property {RegExp} pattern
 * @property {"high" | "generic"} precision
 * @property {(match: RegExpExecArray, line: string) => boolean} [accept]
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: "private-key-block",
    description: "PEM/OpenSSH private key block",
    precision: "high",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    precision: "high",
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub personal access, OAuth, app, or refresh token",
    precision: "high",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    id: "github-fine-grained-token",
    description: "GitHub fine-grained personal access token",
    precision: "high",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  },
  {
    id: "atlassian-api-token",
    description: "Atlassian (Jira/Confluence) API token",
    precision: "high",
    pattern: /\bATATT3[A-Za-z0-9_\-=]{50,}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    precision: "high",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    precision: "high",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "npm-token",
    description: "npm access token",
    precision: "high",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "stripe-live-key",
    description: "Stripe live secret key",
    precision: "high",
    pattern: /\b[rs]k_live_[0-9a-zA-Z]{16,}\b/g,
  },
  {
    id: "json-web-token",
    description: "Serialized JSON Web Token",
    precision: "high",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: "basic-auth-url",
    description: "URL embedding a username and password",
    precision: "high",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/:@"']{6,}@[^\s/"']+/g,
    accept: (match) => !PLACEHOLDER_MARKERS.some((marker) => match[0].toLowerCase().includes(marker)),
  },
  {
    id: "generic-assigned-secret",
    description: "High-entropy literal assigned to a credential-shaped name",
    precision: "generic",
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credential)s?["']?\s*[:=]\s*(["'])([^"'\s]{16,})\1/gi,
    accept: (match) => {
      const value = match[2];
      const lowered = value.toLowerCase();
      if (PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker))) return false;
      return shannonEntropy(value) >= 3.5;
    },
  },
];

/**
 * @param {string} value
 * @returns {number} bits of Shannon entropy per character.
 */
function shannonEntropy(value) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * @param {string} value
 * @returns {string} a preview that reveals the shape of a match without its content.
 */
function redact(value) {
  if (value.length <= 8) return `${value.slice(0, 2)}***(${value.length} chars)`;
  return `${value.slice(0, 4)}***${value.slice(-2)} (${value.length} chars)`;
}

/**
 * @param {string[]} argv
 * @returns {{ diffBase: string | null }}
 */
function parseArguments(argv) {
  let diffBase = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--diff-base") {
      diffBase = argv[index + 1] ?? null;
      index += 1;
      if (diffBase === null || diffBase.startsWith("--")) {
        throw new Error("--diff-base requires a git revision argument.");
      }
      continue;
    }
    if (argument.startsWith("--diff-base=")) {
      diffBase = argument.slice("--diff-base=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { diffBase };
}

function loadAllowlist() {
  let raw;
  try {
    raw = readFileSync(ALLOWLIST_PATH, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read the secret-scan allowlist at ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = JSON.parse(raw);
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("The secret-scan allowlist must contain an `entries` array.");
  }

  const knownRules = new Set(RULES.map((rule) => rule.id));
  return entries.map((entry, index) => {
    for (const field of ["path", "rule", "reason", "approvedBy"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`Allowlist entry ${index} is missing a non-empty "${field}".`);
      }
    }
    if (!knownRules.has(entry.rule)) {
      throw new Error(`Allowlist entry ${index} references unknown rule "${entry.rule}".`);
    }
    return { path: entry.path, rule: entry.rule, reason: entry.reason, approvedBy: entry.approvedBy };
  });
}

/**
 * Lists every file the scan covers: files in the index plus untracked files that are not
 * ignored. Including untracked files matters locally - a credential written but not yet
 * `git add`ed must still fail the gate before it can be committed. On a CI checkout there
 * are no untracked files, so both environments scan exactly the same set.
 *
 * @returns {string[]} repository-relative POSIX paths.
 */
function listScannableFiles() {
  const result = runCaptured("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return [...new Set(result.stdout.split("\0").filter((entry) => entry !== ""))];
}

/**
 * @param {string} relativePath
 * @returns {string | null} file text, or `null` when the file is binary or oversized.
 */
function readScannableText(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return null;

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    // Tracked but absent from the working tree (for example a sparse checkout).
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;

  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

/**
 * @param {string} text
 * @param {string} location
 * @param {(lineIndex: number) => number} lineNumberOf
 * @returns {{ rule: string, description: string, path: string, line: number, preview: string }[]}
 */
function scanText(text, location, lineNumberOf) {
  /** @type {{ rule: string, description: string, path: string, line: number, preview: string }[]} */
  const findings = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 4096) continue;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        if (rule.accept && !rule.accept(match, line)) continue;
        findings.push({
          rule: rule.id,
          description: rule.description,
          path: location,
          line: lineNumberOf(index),
          preview: redact(match[2] ?? match[0]),
        });
      }
    }
  }

  return findings;
}

/**
 * @param {string} diffBase
 * @returns {{ rule: string, description: string, path: string, line: number, preview: string }[]}
 */
function scanAddedLines(diffBase) {
  const mergeBase = runCaptured("git", ["merge-base", diffBase, "HEAD"]);
  if (mergeBase.exitCode !== 0) {
    throw new Error(
      `Could not resolve a merge base between "${diffBase}" and HEAD (exit ${mergeBase.exitCode}): ` +
        `${mergeBase.stderr.trim()}`,
    );
  }

  const diff = runCaptured("git", [
    "diff",
    "--no-color",
    "--unified=0",
    "--diff-filter=ACMR",
    `${mergeBase.stdout.trim()}..HEAD`,
  ]);
  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed (exit ${diff.exitCode}): ${diff.stderr.trim()}`);
  }

  /** @type {{ rule: string, description: string, path: string, line: number, preview: string }[]} */
  const findings = [];
  let currentPath = "(unknown)";
  let currentLine = 0;

  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("@@")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      currentLine = hunk ? Number(hunk[1]) : 0;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      findings.push(...scanText(added, currentPath, () => currentLine));
      currentLine += 1;
    }
  }

  return findings;
}

function main() {
  const { diffBase } = parseArguments(process.argv.slice(2));
  const allowlist = loadAllowlist();

  /** @type {{ rule: string, description: string, path: string, line: number, preview: string }[]} */
  let findings = [];
  let scannedFiles = 0;

  if (diffBase === null) {
    for (const relativePath of listScannableFiles()) {
      const text = readScannableText(relativePath);
      if (text === null) continue;
      scannedFiles += 1;
      findings.push(...scanText(text, relativePath, (index) => index + 1));
    }
    process.stdout.write(`Secret scan: ${scannedFiles} text files scanned (tracked plus untracked, ignoring .gitignore).\n`);
  } else {
    findings = scanAddedLines(diffBase);
    process.stdout.write(`Secret scan: lines added since the merge base with "${diffBase}".\n`);
  }

  const allowed = [];
  const blocking = [];
  for (const finding of findings) {
    const isAllowed = allowlist.some(
      (entry) => entry.path === finding.path && entry.rule === finding.rule,
    );
    (isAllowed ? allowed : blocking).push(finding);
  }

  for (const finding of allowed) {
    process.stdout.write(
      `  allowlisted  ${finding.rule}  ${finding.path}:${finding.line}  ${finding.preview}\n`,
    );
  }

  if (blocking.length === 0) {
    process.stdout.write(
      `Secret scan passed: 0 blocking findings, ${allowed.length} allowlisted.\n`,
    );
    return 0;
  }

  process.stderr.write(`\nSecret scan FAILED with ${blocking.length} finding(s):\n`);
  for (const finding of blocking) {
    process.stderr.write(
      `  ${finding.rule}  ${finding.path}:${finding.line}  ${finding.description}  ${finding.preview}\n`,
    );
  }
  process.stderr.write(
    "\nRotate the exposed credential first, then remove it from the tree and from history.\n" +
      "If a match is provably not a credential, add a reviewed entry to " +
      ".github/secret-scan-allowlist.json.\n",
  );
  return 1;
}

export { RULES, scanText, redact, shannonEntropy };

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `Secret scan could not complete: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
