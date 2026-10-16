import { randomUUID } from "node:crypto";

export const coverageContextAgentManifest = Object.freeze({
  id: "agent.coverage-context",
  version: "0.1.0",
  capabilities: ["quality-context.read", "coverage.analyze", "recommendations.propose"],
  mode: "read-only",
});

export function createCoverageContextAgent({
  knowledgeService,
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
} = {}) {
  if (!knowledgeService) {
    throw new TypeError("knowledgeService is required");
  }

  return {
    manifest: coverageContextAgentManifest,

    async execute({ productId, workItemId }) {
      const query = workItemId.replace(/^requirement:/, "");
      const { trace, coverageItems } = await knowledgeService.getCoverageContext({
        productId,
        workItemId: query,
      });
      if (!trace) {
        return {
          runId: createRunId(),
          agent: coverageContextAgentManifest,
          productId,
          workItemId: query,
          generatedAt: now(),
          status: "not-found",
          confidence: {
            level: "none",
            rationale: "The requested Jira work item is not present in the canonical knowledge store.",
          },
          summary: `No TKL knowledge was found for ${query}.`,
          findings: [],
          recommendations: [{
            id: "collect-jira-evidence",
            priority: "high",
            action: "Synchronize Jira for the requested work item and rerun the analyst.",
            rationale: "An agent cannot make a grounded coverage assessment without the root requirement.",
          }],
          evidence: {
            sources: [],
            requirements: [],
            tests: [],
            relationships: [],
            citations: [],
          },
          limitations: ["No canonical Jira requirement was found."],
        };
      }

      const coverageByRequirement = new Map(
        coverageItems.map((item) => [item.requirement.id, item.finding]),
      );
      const sources = unique(
        [trace.story, ...trace.requirements, ...trace.tests, ...trace.relationships]
          .flatMap(provenanceEntries)
          .map((entry) => entry.source),
      );
      const manualTests = trace.tests.filter((test) => test.type === "manual-test");
      const automatedTests = trace.tests.filter((test) => test.type === "test");
      const executions = trace.tests.filter((test) => test.type === "test-execution");
      const uncoveredRequirements = trace.requirements.filter((requirement) => {
        const finding = coverageByRequirement.get(requirement.id);
        return !finding || finding.denominator === 0 || finding.numerator < finding.denominator;
      });
      const findings = [];
      const recommendations = [];
      const limitations = [];

      if (trace.context?.issueType === "Epic" && trace.context.relatedRequirementCount === 0) {
        findings.push({
          id: "epic-hierarchy-missing",
          severity: "high",
          category: "knowledge-gap",
          title: "Epic hierarchy is unavailable",
          detail: "The epic is present, but no child Jira work items are linked in canonical knowledge.",
          evidenceIds: [trace.story.id],
        });
        recommendations.push({
          id: "refresh-jira-hierarchy",
          priority: "high",
          action: "Repeat the exact Jira investigation after parent and epic relationships are available.",
          rationale: "The bounded Jira retrieval needs explicit descendant relationships for epic impact analysis.",
        });
      }

      if (manualTests.length === 0) {
        findings.push({
          id: "manual-coverage-missing",
          severity: "medium",
          category: "coverage-gap",
          title: "No linked manual tests",
          detail: "No TestRail manual-test entity is linked to the selected scope.",
          evidenceIds: trace.requirements.map((requirement) => requirement.id),
        });
        recommendations.push({
          id: "sync-or-design-manual-tests",
          priority: "high",
          action: "Connect TestRail, retrieve related cases on demand, then run the Test Designer.",
          rationale: "Existing TestRail coverage should be checked through bounded retrieval before proposing new cases.",
        });
      }

      if (automatedTests.length === 0) {
        findings.push({
          id: "automation-coverage-missing",
          severity: "medium",
          category: "coverage-gap",
          title: "No linked automated tests",
          detail: "No GitHub automation entity is linked to the selected scope.",
          evidenceIds: trace.requirements.map((requirement) => requirement.id),
        });
        recommendations.push({
          id: "sync-or-design-automation",
          priority: "high",
          action: "Connect the relevant automation repositories and repeat the ticket investigation.",
          rationale: "Bounded repository lookup is required to reuse framework components and avoid duplicate tests.",
        });
      }

      if (executions.length === 0) {
        findings.push({
          id: "execution-evidence-missing",
          severity: "medium",
          category: "freshness-gap",
          title: "No execution history",
          detail: "No TestRail result or ReportPortal execution is linked to the selected scope.",
          evidenceIds: trace.tests.map((test) => test.id),
        });
        recommendations.push({
          id: "sync-execution-history",
          priority: "medium",
          action: "Retrieve the related TestRail case or ReportPortal test identity on demand.",
          rationale: "A stable case ID, uniqueId, or codeRef is required to assess execution quality without broad synchronization.",
        });
      }

      if (uncoveredRequirements.length > 0) {
        findings.push({
          id: "requirements-not-fully-covered",
          severity: "high",
          category: "coverage-gap",
          title: `${uncoveredRequirements.length} requirements are not fully covered`,
          detail: "Coverage findings show missing or incomplete trusted test links.",
          evidenceIds: uncoveredRequirements.map((requirement) => requirement.id),
        });
      }

      for (const requiredSource of ["testrail", "github", "reportportal"]) {
        if (!sources.includes(requiredSource)) {
          limitations.push(`No ${requiredSource} evidence is present in this result.`);
        }
      }
      if (trace.context?.truncated) {
        limitations.push(
          `The response includes ${trace.context.returnedRequirementCount} of `
          + `${trace.context.relatedRequirementCount} related Jira work items.`,
        );
      }

      const confidence = confidenceFor({ sources, manualTests, automatedTests, executions });
      return {
        runId: createRunId(),
        agent: coverageContextAgentManifest,
        productId,
        workItemId: query,
        generatedAt: now(),
        status: limitations.length > 0 ? "insufficient-context" : "ready-for-review",
        confidence,
        summary: buildSummary({
          workItemId: query,
          requirementCount: trace.requirements.length,
          manualCount: manualTests.length,
          automatedCount: automatedTests.length,
          executionCount: executions.length,
          uncoveredCount: uncoveredRequirements.length,
        }),
        findings,
        recommendations: uniqueById(recommendations),
        evidence: {
          sources,
          requirements: trace.requirements,
          tests: trace.tests,
          relationships: trace.relationships,
          citations: uniqueCitations(
            [trace.story, ...trace.requirements, ...trace.tests, ...trace.relationships]
              .flatMap(provenanceEntries),
          ),
        },
        limitations,
      };
    },
  };
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function confidenceFor({ sources, manualTests, automatedTests, executions }) {
  if (
    sources.includes("jira")
    && manualTests.length > 0
    && automatedTests.length > 0
    && executions.length > 0
  ) {
    return {
      level: "high",
      rationale: "Jira, manual, automated, and execution evidence are all represented.",
    };
  }
  if (sources.includes("jira") && (manualTests.length > 0 || automatedTests.length > 0)) {
    return {
      level: "medium",
      rationale: "The requirement has test evidence, but one or more quality dimensions are missing.",
    };
  }
  return {
    level: "low",
    rationale: "The result is based primarily on Jira without linked test and execution evidence.",
  };
}

function buildSummary({
  workItemId,
  requirementCount,
  manualCount,
  automatedCount,
  executionCount,
  uncoveredCount,
}) {
  return `${workItemId}: ${requirementCount} requirement(s), ${manualCount} manual test(s), `
    + `${automatedCount} automated test(s), ${executionCount} execution record(s), `
    + `${uncoveredCount} requirement(s) not fully covered.`;
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueById(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => candidate.id === value.id) === index);
}

function uniqueCitations(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) =>
      candidate.source === value.source
      && candidate.sourceId === value.sourceId
      && candidate.sourceVersion === value.sourceVersion) === index);
}
