import { randomUUID } from "node:crypto";

const PASS_STATUSES = new Set(["PASSED", "PASS", "SUCCESS"]);
const FAIL_STATUSES = new Set(["FAILED", "FAIL", "ERROR"]);
const ENVIRONMENT_ISSUE_PATTERN = /^(SI|SYSTEM|ENV|INFRA)|ENVIRONMENT|INFRASTRUCTURE/i;

export const reliabilityDefectIntelligenceAgentManifest = Object.freeze({
  id: "agent.reliability-defect-intelligence",
  version: "0.1.0",
  capabilities: [
    "reportportal-history.read",
    "jira-defects.read",
    "test-reliability.classify",
    "quality-improvement.propose",
  ],
  mode: "proposal-only",
});

export function createReliabilityDefectIntelligenceAgent({
  knowledgeService,
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
  maxTests = 50,
  maxRunsPerTest = 20,
} = {}) {
  if (!knowledgeService) throw new TypeError("knowledgeService is required");

  return {
    manifest: reliabilityDefectIntelligenceAgentManifest,

    async execute({ productId, workItemId, identity }) {
      const scopeId = identity ? `rp:${identity}` : workItemId;
      const context = identity
        ? await knowledgeService.getReportPortalReliabilityContext({
            productId,
            identity,
          })
        : await knowledgeService.getReliabilityIntelligenceContext({
            productId,
            workItemId,
          });
      const run = {
        runId: createRunId(),
        agent: reliabilityDefectIntelligenceAgentManifest,
        productId,
        workItemId: scopeId,
        ...(identity ? { identity } : {}),
        generatedAt: now(),
      };
      if (!context.trace) {
        return {
          ...run,
          status: "not-found",
          confidence: {
            level: "none",
            rationale: "The Jira work item is not present in canonical knowledge.",
          },
          summary: `No grounded reliability context was found for ${scopeId}.`,
          analyses: [],
          recommendations: [],
          evidence: emptyEvidence(),
          limitations: ["No canonical Jira requirement was found."],
        };
      }

      const grouped = groupExecutions(context.executionContexts ?? []);
      const selectedGroups = [...grouped.values()]
        .sort((left, right) => left.identity.key.localeCompare(right.identity.key))
        .slice(0, maxTests);
      const analyses = selectedGroups.map((group) =>
        analyzeHistory(group, context.jiraDefects ?? [], maxRunsPerTest));
      const recommendations = analyses.flatMap((analysis) => analysis.recommendations);
      const citations = uniqueCitations([
        ...(context.trace.requirements ?? []).flatMap(provenanceEntries),
        ...analyses.flatMap((analysis) => analysis.citations),
        ...(context.jiraDefects ?? []).flatMap(({ entity, claims }) => [
          ...provenanceEntries(entity),
          ...claims.flatMap(provenanceEntries),
        ]),
      ]);
      const limitations = buildLimitations({
        context,
        analyses,
        selectedGroupCount: selectedGroups.length,
        groupedCount: grouped.size,
        maxTests,
        maxRunsPerTest,
      });
      const supported = analyses.some((analysis) =>
        analysis.classification !== "insufficient-history");

      return {
        ...run,
        status: supported ? "ready-for-review" : "insufficient-context",
        confidence: overallConfidence(analyses),
        summary:
          `${analyses.length} stable test identity group(s) and `
          + `${analyses.reduce((sum, item) => sum + item.aggregates.independentRuns, 0)} `
          + `independent ReportPortal run(s) were evaluated for ${scopeId}.`,
        analyses,
        recommendations,
        evidence: {
          sources: unique(citations.map((citation) => citation.source)),
          requirements: context.trace.requirements ?? [],
          reportPortalExecutions: selectedGroups
            .flatMap((group) => group.executions.slice(-maxRunsPerTest))
            .map(({ claims: _claims, linkedDefects: _defects, ...item }) => item),
          jiraDefects: (context.jiraDefects ?? []).map(({ entity }) => entity),
          citations,
        },
        limitations,
      };
    },
  };
}

function groupExecutions(executionContexts) {
  const groups = new Map();
  for (const executionContext of executionContexts) {
    const key = executionContext.stableIdentity.key;
    const group = groups.get(key) ?? {
      identity: executionContext.stableIdentity,
      title: executionContext.execution.title,
      executions: [],
    };
    group.executions.push(executionContext);
    groups.set(key, group);
  }
  return groups;
}

function analyzeHistory(group, jiraDefects, maxRunsPerTest) {
  const runs = collapseLaunchAttempts(group.executions);
  const boundedRuns = runs.slice(-maxRunsPerTest);
  const aggregates = aggregateRuns(boundedRuns);
  const defectKeys = unique(
    boundedRuns.flatMap((run) => run.externalIssueKeys),
  );
  const matchedJiraDefects = jiraDefects
    .map(({ entity }) => entity)
    .filter((entity) => defectKeys.includes(jiraKeyOf(entity)));
  const classification = classify({
    aggregates,
    identityType: group.identity.type,
    matchedJiraDefects,
  });
  const citations = uniqueCitations([
    ...boundedRuns.flatMap((run) => run.citations),
    ...matchedJiraDefects.flatMap(provenanceEntries),
  ]);
  const recommendations = recommendationsFor({
    identity: group.identity,
    classification: classification.type,
    aggregates,
    matchedJiraDefects,
    citations,
  });

  return {
    identity: group.identity,
    title: group.title,
    classification: classification.type,
    confidence: classification.confidence,
    rationale: classification.rationale,
    aggregates,
    timeline: boundedRuns,
    linkedJiraDefects: matchedJiraDefects.map((entity) => ({
      id: entity.id,
      title: entity.title,
      issueType: entity.metadata?.issueType,
      status: entity.metadata?.status,
      citations: uniqueCitations(provenanceEntries(entity)),
    })),
    recommendations,
    citations,
    limitations: [
      ...(group.identity.type === "name"
        ? ["No codeRef was synchronized; exact normalized test name is used as a lower-confidence identity."]
        : []),
      ...(runs.length > boundedRuns.length
        ? [`History is bounded to the most recent ${maxRunsPerTest} independent runs.`]
        : []),
      ...(aggregates.otherRuns > 0
        ? ["Unknown or non-terminal statuses are retained but excluded from pass/fail rate calculations."]
        : []),
    ],
  };
}

function collapseLaunchAttempts(executions) {
  const byLaunch = new Map();
  for (const execution of [...executions].sort(compareExecutions)) {
    const launchKey = execution.launchId || `missing:${execution.execution.id}`;
    const attempts = byLaunch.get(launchKey) ?? [];
    attempts.push(execution);
    byLaunch.set(launchKey, attempts);
  }
  return [...byLaunch.entries()]
    .flatMap(([launchId, attempts]) => {
      const attemptGroups = [];
      for (const attempt of attempts.sort(compareExecutions)) {
        const isRetry = attempt.retry === true || Number(attempt.retry) > 0;
        if (!isRetry || attemptGroups.length === 0) {
          attemptGroups.push([attempt]);
        } else {
          attemptGroups.at(-1).push(attempt);
        }
      }
      return attemptGroups.map((ordered, groupIndex) => {
      const finalAttempt = ordered.at(-1);
      const normalizedStatus = statusBucket(finalAttempt.status);
      const citations = uniqueCitations(ordered.flatMap((attempt) => [
        ...provenanceEntries(attempt.execution),
        ...attempt.claims.flatMap(provenanceEntries),
      ]));
      return {
        launchId: attemptGroups.length > 1 ? `${launchId}:${groupIndex + 1}` : launchId,
        startedAt: ordered[0].startedAt ?? null,
        endedAt: finalAttempt.endedAt ?? null,
        status: finalAttempt.status,
        outcome: normalizedStatus,
        durationMs: finalAttempt.duration ?? null,
        attempts: ordered.map((attempt) => ({
          executionId: attempt.execution.id,
          status: attempt.status,
          retry: attempt.retry ?? false,
          startedAt: attempt.startedAt ?? null,
          durationMs: attempt.duration ?? null,
        })),
        retryAttemptCount: ordered.filter((attempt) =>
          attempt.retry === true || Number(attempt.retry) > 0).length,
        issueTypes: unique(ordered.map((attempt) => attempt.issueType).filter(Boolean)),
        environmentSignals: unique(
          ordered.flatMap(environmentSignalsForExecution),
        ),
        environmentAttributes: unique(
          ordered.flatMap((attempt) => (attempt.attributes ?? []).map((attribute) => {
            const key = String(attribute?.key ?? "tag").trim() || "tag";
            return `${key}:${String(attribute?.value ?? "").trim()}`;
          }).filter((value) => !value.endsWith(":"))),
        ),
        externalIssueKeys: unique(
          ordered.flatMap((attempt) => attempt.externalIssueKeys),
        ),
        evidenceIds: ordered.map((attempt) => attempt.execution.id),
        citations,
      };
      });
    })
    .sort(compareRuns);
}

function aggregateRuns(runs) {
  const passedRuns = runs.filter((run) => run.outcome === "passed").length;
  const failedRuns = runs.filter((run) => run.outcome === "failed").length;
  const otherRuns = runs.length - passedRuns - failedRuns;
  const knownSequence = runs
    .map((run) => run.outcome)
    .filter((outcome) => outcome === "passed" || outcome === "failed");
  const transitions = knownSequence.slice(1)
    .filter((outcome, index) => outcome !== knownSequence[index]).length;
  const durations = runs.map((run) => run.durationMs).filter(Number.isFinite);
  const unknownStatusCounts = {};
  for (const run of runs.filter((item) => item.outcome === "other")) {
    unknownStatusCounts[run.status] = (unknownStatusCounts[run.status] ?? 0) + 1;
  }
  const environmentFailureRuns = runs.filter((run) =>
    run.outcome === "failed" && run.environmentSignals.length > 0).length;
  const trend = trendFor(runs);
  return {
    independentRuns: runs.length,
    observedAttempts: runs.reduce((sum, run) => sum + run.attempts.length, 0),
    passedRuns,
    failedRuns,
    otherRuns,
    failureRate: passedRuns + failedRuns > 0
      ? round(failedRuns / (passedRuns + failedRuns))
      : null,
    transitions,
    retryRuns: runs.filter((run) => run.retryAttemptCount > 0).length,
    environmentFailureRuns,
    unknownStatusCounts: Object.fromEntries(
      Object.entries(unknownStatusCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    durationMs: durations.length === 0
      ? { minimum: null, maximum: null, average: null }
      : {
          minimum: Math.min(...durations),
          maximum: Math.max(...durations),
          average: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
        },
    firstSeenAt: runs[0]?.startedAt ?? null,
    lastSeenAt: runs.at(-1)?.startedAt ?? null,
    statusSequence: runs.map((run) => run.outcome),
    trend,
  };
}

function classify({ aggregates, identityType, matchedJiraDefects }) {
  const knownRuns = aggregates.passedRuns + aggregates.failedRuns;
  const identityRationale = identityType === "codeRef"
    ? "Stable codeRef identity is available."
    : "Only exact normalized name identity is available.";
  if (aggregates.independentRuns < 3 || knownRuns < 3) {
    return classification(
      "insufficient-history",
      "low",
      `At least three independent runs with known terminal outcomes are required. `
        + `${aggregates.independentRuns} independent run(s) and ${knownRuns} known outcome(s) are available. `
        + identityRationale,
    );
  }
  if (
    aggregates.environmentFailureRuns >= 2
    && aggregates.environmentFailureRuns / Math.max(aggregates.failedRuns, 1) >= 0.5
  ) {
    return classification(
      "environment-infrastructure-signal",
      aggregates.environmentFailureRuns >= 3 && identityType === "codeRef" ? "high" : "medium",
      `${aggregates.environmentFailureRuns} failed independent runs carry explicit `
        + `ReportPortal system/environment issue classifications. ${identityRationale}`,
    );
  }
  if (aggregates.failedRuns === 0 && aggregates.otherRuns === 0 && aggregates.passedRuns >= 3) {
    return classification(
      "healthy",
      aggregates.passedRuns >= 5 && identityType === "codeRef" ? "high" : "medium",
      `All ${aggregates.passedRuns} independent runs passed with no unknown terminal status. `
        + `${identityRationale}`,
    );
  }
  if (aggregates.failedRuns >= 3 && aggregates.failureRate >= 0.75) {
    const defectRationale = matchedJiraDefects.length > 0
      ? ` ${matchedJiraDefects.length} synchronized Jira defect(s) are explicitly linked.`
      : " No synchronized Jira defect is explicitly linked, so product ownership remains a review decision.";
    return classification(
      "consistently-failing-product-risk",
      matchedJiraDefects.length > 0 && identityType === "codeRef" ? "high" : "medium",
      `${aggregates.failedRuns} of ${knownRuns} independent runs failed `
        + `(${Math.round(aggregates.failureRate * 100)}%).${defectRationale} ${identityRationale}`,
    );
  }
  if (
    aggregates.failedRuns >= 2
    && aggregates.passedRuns >= 2
    && aggregates.transitions >= 2
  ) {
    return classification(
      "likely-flaky",
      aggregates.independentRuns >= 6 && identityType === "codeRef" ? "high" : "medium",
      `Pass and failure outcomes recur across ${knownRuns} independent runs with `
        + `${aggregates.transitions} transition(s). Same-launch retries were collapsed and did not `
        + `count as independent evidence. ${identityRationale}`,
    );
  }
  return classification(
    "insufficient-history",
    "low",
    `The available sequence does not meet the conservative thresholds for healthy, `
      + `likely-flaky, repeated environment signal, or consistently failing classification. `
      + identityRationale,
  );
}

function classification(type, level, rationale) {
  return { type, confidence: { level, rationale }, rationale };
}

function recommendationsFor({
  identity,
  classification: classificationType,
  aggregates,
  matchedJiraDefects,
  citations,
}) {
  const recommendations = [];
  const add = (id, kind, priority, action, rationale) => recommendations.push({
    id: `${id}:${safeId(identity.value)}`,
    testIdentity: identity.value,
    kind,
    priority,
    action,
    rationale,
    citations,
  });
  if (classificationType === "likely-flaky") {
    add(
      "stabilize",
      "improvement",
      "high",
      "Review the automation for nondeterministic waits, shared state, data collisions, and dependency timing.",
      "Repeated pass/fail transitions occur across independent runs; a single retry was not used as flaky evidence.",
    );
    add(
      "protect-signal",
      "regression-prevention",
      "medium",
      "Keep the test active while comparing environment and duration changes across the cited runs.",
      "Quarantining or relabeling the test without review would hide a potentially real product failure.",
    );
  } else if (classificationType === "consistently-failing-product-risk") {
    add(
      "triage-defect",
      "improvement",
      "high",
      matchedJiraDefects.length > 0
        ? "Review the linked Jira defect status and verify the failing behavior against the cited executions."
        : "Triage the repeated failure with product and automation owners before assigning defect ownership.",
      "A high failure rate across independent runs indicates persistent risk rather than intermittent flakiness.",
    );
  } else if (classificationType === "environment-infrastructure-signal") {
    add(
      "stabilize-environment",
      "improvement",
      "high",
      "Compare the cited environment, browser, node, and dependency signals and remediate the shared infrastructure cause.",
      "Multiple independent failures carry explicit ReportPortal system/environment classifications.",
    );
  } else if (classificationType === "healthy") {
    add(
      "preserve-baseline",
      "regression-prevention",
      "low",
      "Retain this test in the regression suite and monitor for a future failure-rate or duration shift.",
      "The bounded history contains only supported passing outcomes.",
    );
  } else {
    add(
      "collect-history",
      "improvement",
      "medium",
      "Collect at least three independent ReportPortal runs with a stable codeRef and known terminal outcomes.",
      "The current evidence cannot support a reliable health, flakiness, product-risk, or environment classification.",
    );
  }
  if (aggregates.trend.direction === "regression") {
    add(
      "investigate-regression",
      "regression-prevention",
      "high",
      "Review changes between the earlier and recent run windows for a reliability regression.",
      `The recent failure rate increased by ${Math.round(aggregates.trend.delta * 100)} percentage points.`,
    );
  } else if (aggregates.trend.direction === "improving") {
    add(
      "verify-improvement",
      "regression-prevention",
      "medium",
      "Verify the apparent improvement over additional independent runs before closing related follow-up.",
      `The recent failure rate decreased by ${Math.round(Math.abs(aggregates.trend.delta) * 100)} percentage points.`,
    );
  }
  return recommendations;
}

function trendFor(runs) {
  const known = runs.filter((run) => ["passed", "failed"].includes(run.outcome));
  if (known.length < 6) {
    return { direction: "insufficient-history", delta: null, earlierFailureRate: null, recentFailureRate: null };
  }
  const earlier = known.slice(-6, -3);
  const recent = known.slice(-3);
  const rate = (items) => items.filter((item) => item.outcome === "failed").length / items.length;
  const earlierFailureRate = round(rate(earlier));
  const recentFailureRate = round(rate(recent));
  const delta = round(recentFailureRate - earlierFailureRate);
  return {
    direction: delta >= 0.34 ? "regression" : delta <= -0.34 ? "improving" : "stable",
    delta,
    earlierFailureRate,
    recentFailureRate,
  };
}

function buildLimitations({
  context,
  analyses,
  selectedGroupCount,
  groupedCount,
  maxTests,
  maxRunsPerTest,
}) {
  const limitations = [
    "This agent is read/proposal-only and cannot update ReportPortal classifications, Jira defects, tests, or repositories.",
    "Likely-flaky is a review signal only; this agent never emits or writes a confirmed-flaky classification.",
    `History is deterministically bounded to ${maxTests} test identities and ${maxRunsPerTest} independent runs per identity.`,
  ];
  if (analyses.length === 0) {
    limitations.push(
      "No ReportPortal history was explicitly connected to the Jira scope by external issue key or a Jira-linked repository path/codeRef.",
    );
  }
  if (analyses.some((analysis) => analysis.identity.type === "name")) {
    limitations.push("Some histories lack codeRef and use exact normalized names as lower-confidence identities.");
  }
  if (analyses.some((analysis) => analysis.aggregates.otherRuns > 0)) {
    limitations.push("Unknown or non-terminal ReportPortal statuses were retained and excluded from pass/fail rates.");
  }
  if ((context.jiraDefects ?? []).length === 0) {
    limitations.push("No synchronized Jira issue typed as a bug, defect, incident, or problem is linked to the selected history.");
  }
  if (context.executionEvidenceTruncated) {
    limitations.push("Matching ReportPortal execution evidence was truncated by the service safety limit.");
  }
  if (groupedCount > selectedGroupCount) {
    limitations.push(`Only the first ${maxTests} stable identities in deterministic order were analyzed.`);
  }
  return limitations;
}

function overallConfidence(analyses) {
  if (analyses.length === 0) {
    return {
      level: "low",
      rationale: "The Jira scope exists, but no synchronized ReportPortal history is explicitly connected to it.",
    };
  }
  const supported = analyses.filter((analysis) =>
    analysis.classification !== "insufficient-history");
  if (supported.length === 0) {
    return {
      level: "low",
      rationale: "Execution evidence exists, but independent-run history is below conservative classification thresholds.",
    };
  }
  if (
    supported.every((analysis) => analysis.identity.type === "codeRef")
    && supported.every((analysis) => analysis.confidence.level === "high")
  ) {
    return {
      level: "high",
      rationale: "Every supported classification uses stable codeRef identity and high-confidence multi-run evidence.",
    };
  }
  return {
    level: "medium",
    rationale: "At least one multi-run classification is supported, with remaining identity or history limitations shown per test.",
  };
}

function environmentSignalsForExecution(execution) {
  const signals = [];
  if (execution.issueType && ENVIRONMENT_ISSUE_PATTERN.test(execution.issueType)) {
    signals.push(`issueType:${execution.issueType}`);
  }
  return signals;
}

function statusBucket(status) {
  const normalized = String(status ?? "").trim().toUpperCase() || "UNKNOWN";
  if (PASS_STATUSES.has(normalized)) return "passed";
  if (FAIL_STATUSES.has(normalized)) return "failed";
  return "other";
}

function compareExecutions(left, right) {
  return String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""))
    || left.execution.id.localeCompare(right.execution.id);
}

function compareRuns(left, right) {
  return String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""))
    || compareNumericStrings(left.launchId, right.launchId);
}

function compareNumericStrings(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return 0;
  }
  return left.localeCompare(right);
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function uniqueCitations(values) {
  const deduplicated = new Map();
  for (const value of values.filter(Boolean)) {
    deduplicated.set(
      `${value.source}|${value.sourceId}|${value.sourceVersion}|${value.contentHash ?? ""}`,
      value,
    );
  }
  return [...deduplicated.values()]
    .sort((left, right) =>
      left.source.localeCompare(right.source)
      || left.sourceId.localeCompare(right.sourceId)
      || left.sourceVersion.localeCompare(right.sourceVersion));
}

function unique(values) {
  return [...new Set(values)];
}

function jiraKeyOf(entity) {
  return entity.id.replace(/^(requirement|story):/, "").trim().toUpperCase();
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function emptyEvidence() {
  return {
    sources: [],
    requirements: [],
    reportPortalExecutions: [],
    jiraDefects: [],
    citations: [],
  };
}
