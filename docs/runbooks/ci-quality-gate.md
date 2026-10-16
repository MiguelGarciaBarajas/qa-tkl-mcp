# CI Quality Gate Runbook (QA-101)

The quality gate is the single automated barrier between a branch and `main`. It runs the
same checks in the same order on a contributor's machine and on a GitHub Actions runner.

| Artifact | Purpose |
|---|---|
| `.github/workflows/pr-quality-gate.yml` | The CI workflow: three jobs, one aggregated protected check |
| `scripts/ci/quality-gate.mjs` (`npm run gate`) | The local aggregate gate |
| `scripts/ci/secret-scan.mjs` (`npm run scan:secrets`) | Dependency-free committed-credential scan |
| `scripts/ci/dependency-audit.mjs` (`npm run audit:deps`) | npm advisory policy enforcement |
| `scripts/ci/print-playwright-version.mjs` | Resolves the locked Playwright version for the browser cache key |
| `scripts/ci/lib/mini-yaml.mjs` | Strict YAML subset reader used by the workflow contract test |
| `.github/dependabot.yml` | Weekly npm and GitHub Actions update pull requests |
| `.github/dependency-audit-waivers.json` | Reviewed, dated, expiring advisory waivers |
| `.github/secret-scan-allowlist.json` | Reviewed, path-scoped scanner exceptions |
| `.nvmrc` | The exact Node version CI installs |
| `tests/contract/qa-101-ci-quality-gate.contract.test.ts` | Static contract tests for all of the above |

## Workflow Design

```text
pull_request / push to main / weekly schedule / manual dispatch
  |
  +-- supply-chain           (no npm install, no node_modules)
  |     secret scan: tracked + untracked files
  |     secret scan: lines added since the merge base (pull requests only)
  |     dependency audit policy
  |
  +-- quality-gate           (one npm ci, one browser download)
  |     lint -> typecheck -> build -> unit -> contract -> integration -> e2e
  |
  +-- required-checks        (needs both; if: always())
        fails unless every dependency reported "success"
```

### Why this shape

- **One expensive install.** Every command that needs `node_modules` lives in
  `quality-gate`, so `npm ci` and the Chromium download happen exactly once per run. The
  `supply-chain` job audits the lockfile with `npm audit --package-lock-only` and scans
  files with `git` plus Node, so it needs neither an install nor a browser and runs in
  parallel for free. Splitting the test commands into a matrix would add a second
  multi-minute install for no additional signal at this repository's size.
- **Cheap checks fail first.** Inside `quality-gate` the step order is ascending cost, so
  a lint or typecheck regression fails in about a minute instead of after the browser run.
- **Least privilege.** The workflow grants `contents: read` at the top level, each job
  re-declares its own read-only permissions, `required-checks` grants nothing at all
  (`permissions: {}`), and every checkout uses `persist-credentials: false` so the
  `GITHUB_TOKEN` is never written into `.git/config` where a build step could read it. No
  job references `secrets.*`; the gate cannot be used as a credential exfiltration path.
- **Determinism.** `npm ci` installs strictly from the committed lockfile, the Node
  version comes from `.nvmrc`, and every action is pinned to a 40-character commit SHA
  with a `# vX.Y.Z` comment recording the human-readable release. A moving tag such as
  `@v4` is mutable and is rejected by the contract test.
- **Cross-platform native tools.** The dashboard pins `oxlint` and Vite and explicitly
  records the Linux x64 bindings required by oxlint, Rolldown, and Lightning CSS as
  optional dependencies. A lockfile generated on Windows therefore still installs every
  native binary needed by the Ubuntu CI runner.
- **One protected name.** Branch protection should require only `Required checks`. Adding
  or renaming a job changes that job's entry in `required-checks.needs`, not the protected
  branch rule. `if: always()` plus an explicit per-dependency result comparison means a
  skipped or cancelled dependency fails the aggregate; GitHub treats a skipped job as
  neutral, so a plain `needs:` without the comparison would let a skipped job pass.

### Caching

- npm: `actions/setup-node` with `cache: npm` keyed on `package-lock.json`.
- Playwright browsers: `~/.cache/ms-playwright` keyed on
  `playwright-<os>-chromium-<locked version>`. The version is read from
  `package-lock.json` *before* `npm ci`, so the key always matches the version that is
  about to be installed. `npx playwright install --with-deps chromium` runs unconditionally
  afterwards: on a cache hit the browser download is skipped but the OS libraries are still
  installed, so a restored cache can never yield a half-working browser.

## Dependency Audit Policy

`npm audit` resolves advisories from the npm registry against `package-lock.json`. It is
part of the ecosystem already in use, so it needs no extra account, license, or token.

Scope is decided by re-running the audit with `--omit=dev`: an advisory that survives that
run is reachable from the **production** graph a deployed TKL process loads. Everything
else is build/test tooling.

| Scope | Severity | Fix published | Decision |
|---|---|---|---|
| production | critical, high | any | **BLOCK** |
| production | moderate | yes | **BLOCK** |
| production | moderate, low | no | WARN |
| production | low | yes | WARN |
| development | critical, high | yes | **BLOCK** |
| development | anything else | any | WARN |
| any | unrecognised severity | any | **BLOCK** (fails closed) |

Rationale: a severe production advisory is a real exposure whether or not upstream has
shipped a fix, so it blocks and forces an explicit decision. Development-only findings
cannot reach a deployed process, so they block only when they are both severe and trivially
fixable; otherwise they are printed as warnings. Warnings are never silent - every one is
listed with its advisory id, package, severity, and fix status.

### Fail-closed guarantee

If `npm audit` cannot reach the registry, returns unparseable output, or returns an error
object, the gate **fails**. "0 findings" is only ever printed after a successful advisory
lookup. Verified locally by pointing `npm_config_registry` at a closed port.

### Waivers

A BLOCK can only be suppressed through `.github/dependency-audit-waivers.json`. Each entry
needs `id`, `package`, `scope`, `reason`, `approvedBy`, `approvedOn`, and `expires`.
A waiver may not exceed 90 days, and an expired or malformed waiver **fails** the gate
rather than lapsing into silence. Waived findings are still printed, tagged `WAIVED`.

## Secret Scanning

`scripts/ci/secret-scan.mjs` uses only Node and `git`, so it behaves identically on a
laptop and a runner and can never pass because a third-party scanning service credential
was missing.

- **Working-tree mode** (default) scans tracked files plus untracked, non-ignored files.
  Including untracked files matters locally: a credential written but not yet `git add`ed
  must fail before it can be committed. A CI checkout has no untracked files, so both
  environments scan the same set.
- **Pull-request mode** (`--diff-base <ref>`) scans the lines added since the merge base,
  which catches a credential a pull request introduced and a later commit removed.
- High-precision rules: PEM/OpenSSH private keys, AWS access key ids, GitHub classic and
  fine-grained tokens, Atlassian API tokens, Slack tokens, Google API keys, npm tokens,
  Stripe live keys, serialized JWTs, and URLs with embedded credentials.
- One generic rule flags a high-entropy quoted literal assigned to a credential-shaped
  name. It ignores the repository's own reference conventions (`secret://`, `env://`,
  `${...}`, `process.env`) and obvious placeholders, and requires at least 3.5 bits of
  Shannon entropy per character.
- Findings print the rule, path, line, and a redacted preview. The matched value is never
  printed, so the gate's logs cannot become the leak.

**Documented limitation.** This scanner does not walk full repository history. GitHub
secret scanning with push protection is the platform control for history and for
provider-validated tokens; enable it alongside the branch protection rule below. Rotate an
exposed credential *first*, then remove it from the tree and from history.

Exceptions go in `.github/secret-scan-allowlist.json` and must name a concrete path and a
concrete rule id - a rule can never be disabled globally. Allowlisted matches are still
printed.

## Local Aggregate Gate

```bash
npm run gate                                   # the full CI equivalent
npm run gate -- --skip-e2e                     # fast inner loop; verdict INCOMPLETE, exit 2
npm run gate -- --keep-going                   # run every step, then report
npm run gate -- --with-live-smoke              # opt-in live smoke, never run by CI
npm run gate -- --allow-node-floor-mismatch    # record a below-floor runtime explicitly
```

Contract:

- **Exit codes propagate.** Each step's real exit code (or terminating signal) is recorded;
  the gate exits non-zero if any step did not exit 0.
- **No success-shaped fallback.** A step that cannot start is a failure, not a skip.
  `--skip-e2e` prints `Verdict: INCOMPLETE` and exits **2** - it can never print `PASSED`.
- **Live smoke cannot manufacture success.** `npm run smoke:live` (LIVE-101) requires
  approved live credentials, is never invoked by CI, and only runs under `--with-live-smoke`.
  Passing it cannot make an otherwise failing gate green, and its absence is not treated as
  a pass of anything else.
- **Runtime floor.** `package.json` `engines.node` is checked before any step runs. A
  below-floor runtime fails the precondition unless `--allow-node-floor-mismatch` is passed,
  in which case the verdict reads `PASSED with a non-conforming environment` and names CI as
  the authoritative result.

Exit codes: `0` pass, `1` failure or precondition failure, `2` incomplete.

## Verified Local Run

Recorded on the QA-101 working tree, Windows, Node **v22.14.0** - below the repository
floor `>=22.18.0`, so `--allow-node-floor-mismatch` was required and the verdict says so.
CI installs `.nvmrc` (v22.23.2) and remains the authoritative result.

```text
node scripts/ci/quality-gate.mjs --allow-node-floor-mismatch

  PASS  lint               exit=0  24.8s
  PASS  typecheck          exit=0  31.4s
  PASS  build              exit=0  35.1s
  PASS  unit               exit=0  44.4s     (workspace suites, all green)
  PASS  contract           exit=0  34.0s     (17 root contract tests, 13 of them QA-101)
  PASS  integration        exit=0   3.1s     (23/23)
  PASS  secret-scan        exit=0   0.8s     (370 files, 0 findings, 0 allowlisted)
  PASS  dependency-audit   exit=0   4.9s     (0 advisories, 0 warnings, 0 waived)
  PASS  e2e                exit=0  17.3s     (4/4 Chromium)
  WARNING node-floor: runtime v22.14.0 below >=22.18.0

  Verdict: PASSED with a non-conforming environment.
```

Behavioural checks performed on the same tree:

| Check | Command | Result |
|---|---|---|
| Skipping the browser slice cannot pass | `npm run gate -- --skip-e2e` | `Verdict: INCOMPLETE`, exit **2** |
| A failing step fails the gate | `npm run gate -- --with-live-smoke --keep-going` | `FAIL live-smoke exit=1`, `Verdict: FAILED`, exit **1** |
| Live smoke fails closed without access | `npm run smoke:live` | `blocked`, names `LIVE_SMOKE_GITHUB_TOKEN`, exit 1 |
| Dependency audit fails closed offline | `npm_config_registry=http://127.0.0.1:1/ npm run audit:deps` | `Dependency audit could not complete`, exit 1 |
| The scanner really detects credentials | Synthetic AWS key id written to a scratch file | `aws-access-key-id ... AKIA***OP (20 chars)`, exit 1; value redacted |

`npm audit` currently reports **0 advisories**, so no dependency vulnerability blocks the
gate, no waiver exists, and no dependency change was needed for QA-101.

## Branch Protection

Apply to `main` (Settings -> Branches -> Add branch protection rule, or a repository
ruleset). Requires admin rights on `Solera-Engineering/qa-tkl-mcp-f5`.

> **Accepted MVP constraint (2026-09-12):** inherited organization/enterprise rules
> already require a pull request and one approval and prevent deletion,
> non-fast-forward updates, and bypass by the current identity. They do not require the
> `Required checks` status, an up-to-date branch, or conversation resolution. The project
> owner accepted that platform-admin limitation as residual MVP risk, so QA-101 is
> complete based on the implemented green gate and the protections currently available.
> The settings below remain the recommended production hardening target.

1. Branch name pattern: `main`.
2. **Require a pull request before merging** - at least 1 approval; dismiss stale approvals
   on new commits; require review from Code Owners if a `CODEOWNERS` file is added later.
3. **Require status checks to pass before merging** and **Require branches to be up to date
   before merging**. Add exactly one required check:

   ```text
   Required checks
   ```

   The check only appears in the picker after the workflow has run at least once on a pull
   request, which is why QA-101 cannot be closed before the first PR.
4. **Require conversation resolution before merging**.
5. **Do not allow bypassing the above settings** (including for administrators).
6. Disable force pushes and branch deletion.
7. Settings -> Code security: enable **Secret scanning** and **Push protection**, and enable
   **Dependabot alerts** and **Dependabot security updates**. These are the platform-side
   controls the in-repo scanner deliberately does not duplicate.
8. Settings -> Actions -> General: set workflow permissions to **Read repository contents
   permission** and require approval for fork pull-request workflows.

## Failure Table

| Symptom | Likely cause | Action |
|---|---|---|
| `Precondition FAILED: this runtime is vX, below the repository floor` | Local Node older than `engines.node` | Install the `.nvmrc` version, or re-run with `--allow-node-floor-mismatch` and treat CI as authoritative |
| `Dependency audit could not complete` | Registry unreachable, proxy blocked, or npm error | Restore registry access; never bypass - the gate fails closed on purpose |
| `Dependency audit FAILED with N blocking finding(s)` | Advisory matched the block policy | Upgrade the dependency, or file a reviewed expiring waiver |
| `Secret scan FAILED` | A credential shape was found | Rotate the credential first, then remove it from the tree and history; allowlist only if provably not a credential |
| `Timed out starting the harness API` in e2e | Port exhaustion or a slow first run | Re-run; the harness now kills the child process on a startup timeout instead of leaking it |
| Chromium missing in CI | Browser cache restored without OS libraries | `npx playwright install --with-deps chromium` already runs unconditionally; check the step log |
| `Required checks` not offered in branch protection | The workflow has never completed on a pull request | Open the pull request first, then add the required check |

## Rollback

The gate is additive: it adds workflow, script, configuration, and documentation files and
extends `npm run lint` with a syntax check of the CI scripts. To disable it temporarily,
remove the `Required checks` entry from the branch protection rule; to remove it entirely,
delete `.github/workflows/pr-quality-gate.yml` and `scripts/ci/`, and revert the
`lint`/`gate`/`scan:secrets`/`audit:deps` entries in the root `package.json`. No runtime,
API, MCP, connector, or dashboard behavior depends on any of it.
