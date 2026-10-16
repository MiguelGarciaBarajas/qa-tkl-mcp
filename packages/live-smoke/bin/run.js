#!/usr/bin/env node
/**
 * Opt-in CLI for the LIVE-101 smoke test harness. Never invoked by
 * `npm test`/`test:contract`/`test:integration` -- only by
 * `npm run smoke:live`, deliberately, once access has actually been
 * approved for one or more sources.
 *
 * Exit code is 0 only when every enabled source either smoke-tested
 * successfully or was cleanly skipped as not-yet-approved; it is 1 when an
 * enabled source could not be reached/authorized (including a missing
 * credential environment variable), so this can never silently report
 * "done" for access that was never actually exercised.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runLiveSmoke } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const productId = process.argv[2] ?? "fl-titling";
const configPath = new URL(`config/products/${productId}.json`, `file://${repoRoot}/`);

async function main() {
  const configuration = JSON.parse(await readFile(configPath, "utf8"));
  const report = await runLiveSmoke({ configuration });
  console.log(JSON.stringify(report, null, 2));

  const blocked = report.results.filter((result) => result.status === "blocked");
  if (blocked.length > 0) {
    console.error(
      `\nlive smoke: ${blocked.length} enabled source(s) could not be verified: `
      + blocked.map((result) => `${result.source} (${result.reason})`).join(", "),
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`live smoke: failed to run -- ${error?.message ?? error}`);
  process.exitCode = 1;
});
