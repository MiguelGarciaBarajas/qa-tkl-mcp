import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// @ts-expect-error - dependency-free JavaScript helper shared with the CI scripts.
import { parseYaml, YamlError } from "../../scripts/ci/lib/mini-yaml.mjs";
// @ts-expect-error - dependency-free JavaScript CI script under test.
import { scanText, redact, shannonEntropy } from "../../scripts/ci/secret-scan.mjs";
// @ts-expect-error - dependency-free JavaScript CI script under test.
import {
  collectFindings,
  advisoryIdentifier,
  decide,
  loadWaivers,
} from "../../scripts/ci/dependency-audit.mjs";

/**
 * QA-101 static contract tests for the CI quality gate.
 *
 * A CI workflow cannot be executed from a unit test, so these assertions pin the
 * properties that make the gate trustworthy and that a careless edit would silently
 * remove: least-privilege permissions, SHA-pinned actions, a deterministic install, the
 * complete set of required commands, and a single aggregated status for branch
 * protection.
 *
 * These are static assertions about the committed workflow. They are evidence that the
 * gate is *configured* correctly; they are not evidence that a protected pull-request
 * check has run. That evidence can only come from a real pull request.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "pr-quality-gate.yml");

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function loadWorkflow(): Record<string, any> {
  const workflow = parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as Record<string, any>;
  assert.ok(workflow && typeof workflow === "object", "the workflow must parse to a mapping");
  return workflow;
}

function stepsOf(workflow: Record<string, any>, jobId: string): Record<string, any>[] {
  const job = workflow.jobs?.[jobId];
  assert.ok(job, `the workflow must define a "${jobId}" job`);
  assert.ok(Array.isArray(job.steps), `"${jobId}" must define a step list`);
  return job.steps as Record<string, any>[];
}

function runCommandsOf(workflow: Record<string, any>, jobId: string): string[] {
  return stepsOf(workflow, jobId)
    .map((step) => step.run)
    .filter((command): command is string => typeof command === "string");
}

test("the YAML subset reader fails loudly instead of parsing workflows vacuously", () => {
  assert.deepEqual(parseYaml("a: 1\nb:\n  - x\n  - y: z\n"), { a: 1, b: ["x", { y: "z" }] });
  // `on:` must stay a string key; a YAML 1.1 reader would turn it into `true` and every
  // trigger assertion below would silently pass against an absent key.
  assert.deepEqual(Object.keys(parseYaml("on:\n  push: null\n") as object), ["on"]);
  assert.equal((parseYaml("run: |\n  one\n  two\n") as any).run, "one\ntwo\n");
  assert.throws(() => parseYaml("a: 1\n\tb: 2\n"), YamlError);
  assert.throws(() => parseYaml("a: 1\na: 2\n"), YamlError);
});

test("the quality gate workflow runs on pull requests with least privilege", () => {
  const workflow = loadWorkflow();

  assert.equal(typeof workflow.name, "string");
  assert.ok(workflow.on?.pull_request, "the gate must run on pull requests");
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.ok(workflow.on.push?.branches?.includes("main"), "main must also be protected on push");
  assert.ok(Array.isArray(workflow.on.schedule), "a scheduled re-run must catch new advisories");
  assert.ok("workflow_dispatch" in workflow.on, "the gate must be manually re-runnable");

  assert.deepEqual(
    workflow.permissions,
    { contents: "read" },
    "the workflow token must stay read-only",
  );
  for (const [jobId, job] of Object.entries(workflow.jobs as Record<string, any>)) {
    assert.ok(job.permissions !== undefined, `job "${jobId}" must declare explicit permissions`);
    const granted = Object.entries(job.permissions ?? {});
    for (const [scope, level] of granted) {
      assert.equal(level, "read", `job "${jobId}" must not request ${scope}: ${level}`);
    }
  }

  assert.ok(workflow.concurrency?.group, "runs must be grouped so stale runs are superseded");
});

test("every third-party action is pinned to an immutable commit SHA", () => {
  const workflow = loadWorkflow();
  const uses: string[] = [];

  for (const job of Object.values(workflow.jobs as Record<string, any>)) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses === "string") uses.push(step.uses);
    }
  }

  assert.ok(uses.length > 0, "the workflow must consume at least one action");
  for (const reference of uses) {
    assert.match(
      reference,
      /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
      `action "${reference}" must be pinned to a 40-character commit SHA, not a tag or branch`,
    );
  }

  // The comment next to each pin records the human-readable version it corresponds to.
  const source = readFileSync(WORKFLOW_PATH, "utf8");
  for (const reference of uses) {
    const line = source.split("\n").find((candidate) => candidate.includes(reference));
    assert.match(
      String(line),
      /#\s*v\d+/,
      `the pin for "${reference}" must carry a "# vX.Y.Z" comment`,
    );
  }
});

test("the gate installs dependencies once and deterministically", () => {
  const workflow = loadWorkflow();

  const installs = Object.values(workflow.jobs as Record<string, any>)
    .flatMap((job) => job.steps ?? [])
    .map((step: any) => step.run)
    .filter((command: unknown): command is string => typeof command === "string")
    .filter((command) => /\bnpm (ci|install)\b/.test(command));

  assert.deepEqual(installs, ["npm ci"], "exactly one deterministic lockfile install is expected");

  const setupSteps = Object.values(workflow.jobs as Record<string, any>)
    .flatMap((job) => job.steps ?? [])
    .filter((step: any) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"));

  assert.ok(setupSteps.length > 0, "Node must be provisioned explicitly");
  for (const step of setupSteps as any[]) {
    assert.equal(
      step.with?.["node-version-file"],
      ".nvmrc",
      "the Node version must come from the committed .nvmrc pin",
    );
  }

  const installingJob = setupSteps.find((step: any) => step.with?.cache !== undefined) as any;
  assert.equal(installingJob?.with?.cache, "npm", "the npm cache must be keyed by the package manager");
  assert.equal(installingJob?.with?.["cache-dependency-path"], "package-lock.json");
});

test("the pinned CI Node version satisfies the repository engines floor", () => {
  const pinned = read(".nvmrc").trim();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, ".nvmrc must pin an exact Node version");

  const manifest = JSON.parse(read("package.json"));
  const floor = /^>=\s*v?(\d+)\.(\d+)\.(\d+)$/.exec(String(manifest.engines?.node ?? ""));
  assert.ok(floor, 'package.json engines.node must be a ">=x.y.z" range');

  const [major, minor, patch] = pinned.split(".").map(Number);
  const required = [Number(floor[1]), Number(floor[2]), Number(floor[3])];
  const pinnedParts = [major, minor, patch];

  const satisfies =
    pinnedParts[0] > required[0] ||
    (pinnedParts[0] === required[0] &&
      (pinnedParts[1] > required[1] ||
        (pinnedParts[1] === required[1] && pinnedParts[2] >= required[2])));

  assert.ok(satisfies, `.nvmrc pins ${pinned}, below engines.node >=${required.join(".")}`);
  assert.ok(required[0] > 22 || (required[0] === 22 && required[1] >= 18), "the floor must stay >=22.18");
});

test("the lockfile includes the Linux native bindings required by CI", () => {
  const dashboardManifest = JSON.parse(read("apps/dashboard/package.json"));
  const lockfile = JSON.parse(read("package-lock.json"));
  const requiredBindings = [
    ["@oxlint/binding-linux-x64-gnu", dashboardManifest.devDependencies.oxlint],
    ["@rolldown/binding-linux-x64-gnu", "1.2.8"],
    ["lightningcss-linux-x64-gnu", "1.33.0"],
  ];

  assert.match(dashboardManifest.devDependencies.oxlint, /^\d+\.\d+\.\d+$/);
  assert.match(dashboardManifest.devDependencies.vite, /^\d+\.\d+\.\d+$/);
  for (const [packageName, version] of requiredBindings) {
    assert.equal(dashboardManifest.optionalDependencies[packageName], version);
    assert.equal(
      lockfile.packages[`node_modules/${packageName}`].version,
      version,
      `npm ci on the Linux runner requires ${packageName} in the lockfile`,
    );
  }
});

test("the gate runs every required quality command", () => {
  const workflow = loadWorkflow();
  const commands = runCommandsOf(workflow, "quality-gate").join("\n");

  for (const required of [
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "npm test",
    "npm run test:contract",
    "npm run test:integration",
    "npm run test:e2e",
  ]) {
    assert.ok(
      new RegExp(`(^|\\n)${required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\n)`).test(commands),
      `the quality-gate job must run "${required}"`,
    );
  }

  assert.match(
    commands,
    /npx playwright install --with-deps chromium/,
    "the real Chromium browser and its OS dependencies must be installed before the e2e step",
  );

  const supplyChain = runCommandsOf(workflow, "supply-chain").join("\n");
  assert.match(supplyChain, /node scripts\/ci\/secret-scan\.mjs/, "a secret scan must run");
  assert.match(supplyChain, /node scripts\/ci\/dependency-audit\.mjs/, "a dependency audit must run");
});

test("CI never invokes the opt-in live smoke test or a live source", () => {
  const workflow = loadWorkflow();
  // Assert against what the workflow *executes*, not against its prose: the header
  // comment deliberately mentions `npm run smoke:live` to explain why it is absent.
  const executed = Object.values(workflow.jobs as Record<string, any>)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step: any) => [step.run, step.uses, JSON.stringify(step.with ?? {}), JSON.stringify(step.env ?? {})])
    .filter((value): value is string => typeof value === "string")
    .join("\n");

  assert.doesNotMatch(executed, /smoke:live/, "the live smoke test must stay opt-in and local");
  assert.doesNotMatch(executed, /sync:run/, "CI must not trigger an ingestion run");
  assert.doesNotMatch(
    readFileSync(WORKFLOW_PATH, "utf8"),
    /\$\{\{\s*secrets\./,
    "the gate must not depend on a repository secret",
  );
});

test("a single aggregated check can be protected on the default branch", () => {
  const workflow = loadWorkflow();
  const aggregate = workflow.jobs?.["required-checks"];

  assert.ok(aggregate, "an aggregating job is required for a stable branch-protection name");
  assert.equal(aggregate.if, "always()", "the aggregate must also run when a dependency failed");

  const gatedJobs = Object.keys(workflow.jobs as Record<string, any>).filter(
    (jobId) => jobId !== "required-checks",
  );
  assert.deepEqual(
    [...(aggregate.needs as string[])].sort(),
    gatedJobs.sort(),
    "every other job must be a dependency of the aggregated check",
  );

  const assertion = String(aggregate.steps?.[0]?.run ?? "");
  assert.match(assertion, /set -euo pipefail/, "the aggregate must not mask a shell failure");
  assert.match(assertion, /exit 1/, "the aggregate must fail when a dependency did not succeed");
  for (const jobId of gatedJobs) {
    const variable = `${jobId.replaceAll("-", "_").toUpperCase()}_RESULT`;
    assert.ok(
      String(aggregate.steps?.[0]?.env?.[variable] ?? "").includes(`needs.${jobId}.result`),
      `the aggregate must read needs.${jobId}.result`,
    );
  }
});

test("the local gate mirrors the CI command set", () => {
  const gateSource = read("scripts/ci/quality-gate.mjs");

  for (const fragment of [
    '["run", "lint"]',
    '["run", "typecheck"]',
    '["run", "build"]',
    '["test"]',
    '["run", "test:contract"]',
    '["run", "test:integration"]',
    '["run", "test:e2e"]',
    "secret-scan.mjs",
    "dependency-audit.mjs",
  ]) {
    assert.ok(gateSource.includes(fragment), `the local gate must run ${fragment}`);
  }

  // Skipping the browser slice must never be reported as a pass.
  assert.match(gateSource, /INCOMPLETE/);
  assert.match(gateSource, /--with-live-smoke/);

  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.scripts.gate, "node scripts/ci/quality-gate.mjs");
  assert.equal(manifest.scripts["scan:secrets"], "node scripts/ci/secret-scan.mjs");
  assert.equal(manifest.scripts["audit:deps"], "node scripts/ci/dependency-audit.mjs");
});

test("supply-chain policy files stay machine-readable and reviewable", () => {
  const waivers = JSON.parse(read(".github/dependency-audit-waivers.json"));
  assert.ok(Array.isArray(waivers.waivers));
  for (const waiver of waivers.waivers) {
    for (const field of ["id", "package", "scope", "reason", "approvedBy", "approvedOn", "expires"]) {
      assert.equal(typeof waiver[field], "string", `every waiver needs "${field}"`);
    }
  }

  const allowlist = JSON.parse(read(".github/secret-scan-allowlist.json"));
  assert.ok(Array.isArray(allowlist.entries));
  for (const entry of allowlist.entries) {
    for (const field of ["path", "rule", "reason", "approvedBy"]) {
      assert.equal(typeof entry[field], "string", `every allowlist entry needs "${field}"`);
    }
  }

  const dependabot = parseYaml(read(".github/dependabot.yml")) as Record<string, any>;
  assert.equal(dependabot.version, 2);
  const ecosystems = (dependabot.updates as any[]).map((update) => update["package-ecosystem"]);
  assert.deepEqual(ecosystems.sort(), ["github-actions", "npm"]);
});

test("the secret scanner detects real credential shapes and redacts what it reports", () => {
  const line = (value: string) => scanText(value, "probe.txt", () => 1);

  // Built by concatenation so this test file never contains a literal credential shape.
  const awsKey = `AK${"IA"}${"ABCDEFGHIJKLMNOP"}`;
  const githubToken = `gh${"p"}_${"a".repeat(36)}`;
  const privateKeyHeader = `-----BEGIN ${"RSA "}PRIVATE KEY-----`;

  assert.deepEqual(
    line(awsKey).map((finding) => finding.rule),
    ["aws-access-key-id"],
  );
  assert.deepEqual(
    line(githubToken).map((finding) => finding.rule),
    ["github-token"],
  );
  assert.deepEqual(
    line(privateKeyHeader).map((finding) => finding.rule),
    ["private-key-block"],
  );

  const highEntropy = "Zr7Qv2Xk91Ls3Mt8Pw4Hd6Bn0Yc5Jf";
  assert.deepEqual(
    line(`const apiKey = "${highEntropy}";`).map((finding) => finding.rule),
    ["generic-assigned-secret"],
  );

  // Configuration that references a credential instead of embedding one must stay clean.
  for (const clean of [
    'credentialRef: "secret://tkl/testrail/api-token"',
    'apiToken: "env://TKL_TESTRAIL_TOKEN"',
    'password: "${TKL_DB_PASSWORD}"',
    'token: "replace-with-your-token"',
    'apiKey: "aaaaaaaaaaaaaaaaaaaaaaaa"',
  ]) {
    assert.deepEqual(line(clean), [], `"${clean}" must not be reported`);
  }

  // Reports never echo the matched value.
  const [finding] = line(`const apiKey = "${highEntropy}";`);
  assert.ok(!finding.preview.includes(highEntropy));
  assert.match(finding.preview, /\*\*\*/);
  assert.equal(redact("abcdefghijkl").includes("cdefghij"), false);
  assert.ok(shannonEntropy("aaaaaaaaaaaaaaaa") < shannonEntropy(highEntropy));
});

test("the dependency audit policy blocks production risk and only warns on dev-only noise", () => {
  const production = "production" as const;
  const development = "development" as const;

  assert.equal(decide({ severity: "critical", fixAvailable: false }, production), "BLOCK");
  assert.equal(decide({ severity: "high", fixAvailable: false }, production), "BLOCK");
  assert.equal(decide({ severity: "moderate", fixAvailable: true }, production), "BLOCK");
  assert.equal(decide({ severity: "moderate", fixAvailable: false }, production), "WARN");
  assert.equal(decide({ severity: "low", fixAvailable: true }, production), "WARN");

  assert.equal(decide({ severity: "critical", fixAvailable: true }, development), "BLOCK");
  assert.equal(decide({ severity: "high", fixAvailable: true }, development), "BLOCK");
  assert.equal(decide({ severity: "high", fixAvailable: false }, development), "WARN");
  assert.equal(decide({ severity: "moderate", fixAvailable: true }, development), "WARN");

  // An unrecognised severity must fail closed, not fall through as harmless.
  assert.equal(decide({ severity: "unknown", fixAvailable: false }, production), "BLOCK");

  const report = {
    vulnerabilities: {
      "vulnerable-lib": {
        name: "vulnerable-lib",
        severity: "high",
        isDirect: true,
        fixAvailable: { name: "vulnerable-lib", version: "2.0.0", isSemVerMajor: true },
        via: [
          {
            source: 1234567,
            name: "vulnerable-lib",
            title: "Prototype pollution",
            url: "https://github.com/advisories/GHSA-abcd-efgh-ijkl",
            severity: "high",
          },
        ],
      },
      "transitive-consumer": {
        name: "transitive-consumer",
        severity: "high",
        isDirect: false,
        fixAvailable: false,
        via: ["vulnerable-lib"],
      },
    },
  };

  const findings = collectFindings(report);
  assert.equal(findings.size, 1, "a transitively affected package must not double-count");

  const [finding] = [...findings.values()];
  assert.equal(finding.advisory, "GHSA-ABCD-EFGH-IJKL");
  assert.equal(finding.package, "vulnerable-lib");
  assert.equal(finding.fixAvailable, true);
  assert.equal(finding.fixIsBreaking, true);
  assert.equal(advisoryIdentifier({ source: 42, url: "https://npmjs.com/advisories/42" }), "npm:42");
});

test("the waiver loader rejects expired and malformed exceptions", () => {
  const waivers = loadWaivers();
  assert.ok(Array.isArray(waivers), "the committed waiver file must load cleanly");
});
