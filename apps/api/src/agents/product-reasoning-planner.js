const DOMAIN_RULES = [
  ["customer-owner", ["customer", "owner", "business", "individual", "person", "address", "user"]],
  ["deal", ["deal", "quote", "fee", "closing", "transaction"]],
  ["titling", ["title", "titling", "vehicle", "vin", "lien"]],
  ["test-management", ["test case", "testrail", "regression", "coverage", "acceptance criteria"]],
  ["automation", ["automation", "playwright", "cypress", "repository", "spec", "page object"]],
  ["reliability", ["failure", "flaky", "reportportal", "execution", "defect", "error"]],
];

const LIVE_TERMS = ["currently", "now", "live", "ui", "screen", "browser", "cdp", "network", "console"];
const CODE_TERMS = ["code", "implementation", "repository", "file", "class", "function", "endpoint", "api"];

export function createReasoningPlan({ question, intent, workItemId, caseId }) {
  const normalized = String(question ?? "").trim().toLowerCase();
  const domains = DOMAIN_RULES
    .filter(([, terms]) => terms.some((term) => normalized.includes(term)))
    .map(([domain]) => domain);
  const domain = domains[0] ?? "product";
  const needsLiveEvidence = LIVE_TERMS.some((term) => normalized.includes(term));
  const needsCodeEvidence = CODE_TERMS.some((term) => normalized.includes(term));
  const sources = new Set(["jira", "confluence"]);
  if (workItemId || intent.includes("coverage") || intent.includes("test")) {
    sources.add("testrail");
    sources.add("github");
    sources.add("reportportal");
  }
  if (needsCodeEvidence || intent === "automation-design") sources.add("github");
  if (needsLiveEvidence) sources.add("live-ui");
  return {
    domain,
    domains,
    sources: [...sources],
    evidenceMode: needsLiveEvidence
      ? "live-observed"
      : needsCodeEvidence
        ? "combined"
        : "documented",
    investigation: {
      required: needsLiveEvidence || needsCodeEvidence,
      status: "planned",
      stopReason: null,
      steps: [
        ...(needsCodeEvidence ? ["Inspect linked repository evidence and implementation references."] : []),
        ...(needsLiveEvidence ? ["Inspect live UI/network/console evidence through an approved read-only provider."] : []),
        "Compare retrieved evidence with canonical TKL claims and open conflicts.",
      ],
      scope: {
        ...(workItemId ? { workItemId } : {}),
        ...(caseId ? { caseId } : {}),
      },
    },
  };
}

export function classifyClaims(result) {
  const claims = [];
  for (const item of result?.items ?? []) {
    if (item?.title) claims.push({ type: "fact", text: item.title, evidence: item.id });
  }
  for (const finding of result?.findings ?? []) {
    if (finding?.detail) claims.push({ type: "finding", text: finding.detail, evidence: finding.title });
  }
  for (const recommendation of result?.recommendations ?? []) {
    if (recommendation?.action) claims.push({ type: "inference", text: recommendation.action, evidence: null });
  }
  return claims.slice(0, 12);
}

export function finalizeReasoningMetadata(plan, result, { citations = [], conflicts = [] } = {}) {
  const liveObserved = citations.some((citation) => citation.source === "live-ui");
  const codeObserved = citations.some((citation) => citation.source === "github");
  return {
    ...plan,
    evidenceMode: liveObserved ? "live-observed" : codeObserved ? "combined" : plan.evidenceMode,
    investigation: {
      ...plan.investigation,
      status: plan.investigation.required
        ? (liveObserved || codeObserved ? "completed" : "not-enabled")
        : "not-required",
      stopReason: conflicts.length > 0
        ? "Open knowledge conflicts require review before stronger conclusions."
        : plan.investigation.required && !liveObserved && !codeObserved
          ? "The requested investigation provider is not enabled for this deployment."
          : null,
    },
    claims: classifyClaims(result),
  };
}
