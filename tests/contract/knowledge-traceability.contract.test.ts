import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryKnowledgeStore } from "@tkl/knowledge-store";
import type { RawEvidenceRecord } from "@tkl/contracts";
import { JiraNormalizer } from "@tkl/normalizer-jira";
import { GitHubNormalizer } from "@tkl/normalizer-github";
import { CoverageAnalyzer } from "@tkl/analyzer-coverage";
import { renderEntityToMarkdown } from "@tkl/markdown-export";

function loadFixture(relativePath: string): RawEvidenceRecord {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as RawEvidenceRecord;
}

/**
 * Exercises the shared first-milestone vertical slice end to end using only the
 * Knowledge and Traceability workstream's own components and static fixtures (no live
 * connectors, API, or MCP gateway required):
 *
 *   Jira raw evidence -> canonical requirement + claims
 *   GitHub raw evidence -> canonical test + verifies trace link
 *   -> coverage analysis exposing numerator/denominator/confidence
 *   -> Markdown export of only human-approved knowledge
 *
 * If `packages/contracts` ships with a different `RawEvidenceRecord`/`Normalizer` shape,
 * this test and the shared `@tkl/contracts` declarations must be updated
 * together.
 */
test("Jira + GitHub raw evidence normalize into traceable, coverable, exportable knowledge", async () => {
  const store = new InMemoryKnowledgeStore();

  const jiraRecord = loadFixture("../fixtures/jira/STT-1234.raw.json");
  const githubRecord = loadFixture("../fixtures/github/pr-4321.raw.json");

  const jiraResult = await new JiraNormalizer().normalize(jiraRecord);
  const githubResult = await new GitHubNormalizer().normalize(githubRecord);

  for (const entity of [...jiraResult.entities, ...githubResult.entities]) {
    store.addEntity(entity);
  }
  for (const claim of jiraResult.claims) {
    // Simulate human review approving the claims produced from explicit Jira fields.
    store.addClaim({ ...claim, status: "approved" });
  }
  for (const link of githubResult.traceLinks) {
    store.addTraceLink(link);
  }

  const requirementId = "requirement:STT-1234";
  assert.ok(store.getEntity(requirementId), "requirement entity must exist");
  assert.ok(store.getEntity("test:github:4321"), "test entity must exist");

  const traceLinks = store.getTraceLinks(requirementId);
  assert.equal(traceLinks.length, 1);
  assert.equal(traceLinks[0].fromEntityId, "test:github:4321");

  const coverage = await new CoverageAnalyzer().analyze({ store, requirementId });
  assert.equal(coverage.denominator, 2, "two acceptance criteria in the fixture");
  assert.ok(coverage.numerator >= 1, "at least one verifying link exists");
  assert.equal(coverage.linkConfidence, 1);

  const markdown = renderEntityToMarkdown(store.getEntity(requirementId)!, store);
  assert.match(markdown, /VIN checksum/i);
  assert.match(markdown, /verifies/);
});
