import { randomUUID } from "node:crypto";
import { parseStructuredJiraDescription } from "../jira-description.js";
import {
  createReasoningPlan,
  finalizeReasoningMetadata,
} from "./product-reasoning-planner.js";
import {
  createUnavailableInvestigationProvider,
  mergeInvestigationResult,
} from "./read-only-investigation-provider.js";

const JIRA_KEY_PATTERN = /\b[A-Z]{2,}[A-Z0-9_]*-\d+\b/g;
const HAS_JIRA_KEY_PATTERN = /\b[A-Z]{2,}[A-Z0-9_]*-\d+\b/;
const MAX_SEARCH_TERMS = 4;
const MAX_SEARCH_RESULTS = 12;
const MAX_CITATIONS = 12;
const MAX_DETAILS = 8;
const FRESHNESS_DAYS = 30;
const TICKET_SUMMARY_TERMS = [
  "about", "describe", "explain", "summary", "summarize", "what is",
  "de que trata", "de qué trata", "resumen", "resume", "explica",
];
const TICKET_INTELLIGENCE_TERMS = [
  "what should qa know", "what does qa need to know", "qa know about",
  "full qa context", "quality context", "everything about",
  "que debe saber qa", "qué debe saber qa", "contexto completo de qa",
];

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "can", "could", "does", "explain",
  "find", "for", "from", "have", "how", "into", "its", "our", "please", "show",
  "that", "the", "their", "this", "under", "what", "when", "where", "which",
  "why", "with", "would",
]);

const INTENT_RULES = [
  {
    id: "reliability",
    requiresWorkItem: true,
    terms: ["flaky", "failure", "failures", "failing", "inconsistent", "retry", "retries",
      "reliability", "defect", "regression", "reportportal"],
  },
  {
    id: "automation-design",
    requiresWorkItem: true,
    all: ["automation"],
    terms: ["propose", "design", "create", "implement", "plan", "framework", "repository"],
  },
  {
    id: "testrail-improvement",
    requiresWorkItem: true,
    all: ["testrail"],
    terms: ["improve", "improvement", "update", "edit", "quality", "duplicate"],
  },
  {
    id: "test-design",
    requiresWorkItem: true,
    terms: ["negative case", "negative cases", "test case", "test cases", "test design",
      "manual test", "edge case", "edge cases"],
  },
  {
    id: "knowledge-curation",
    requiresWorkItem: true,
    terms: ["conflict", "conflicts", "duplicate", "duplicates", "stale", "mapping",
      "curate", "curation"],
  },
  {
    id: "coverage-context",
    requiresWorkItem: true,
    terms: ["coverage", "covered", "uncovered", "unverified", "traceability", "trace",
      "changed", "impact", "acceptance criteria", "happy path", "context"],
  },
];

const KNOWLEDGE_TERMS = [
  "acceptance", "application", "automation", "case", "confluence", "coverage", "defect",
  "epic", "execution", "feature", "fl titling", "github", "jira", "manual", "product",
  "qa", "quality", "requirement", "story", "test", "testrail", "title", "tkl",
  "traceability", "workflow",
];
const TESTRAIL_CASE_PATTERN = /\bC(\d+)\b/gi;

const INTENT_PERMISSIONS = Object.freeze({
  "knowledge-search": "knowledge:read",
  "ticket-summary": "knowledge:read",
  "ticket-intelligence": "coverage:read",
  "coverage-context": "coverage:read",
  "test-design": "coverage:read",
  "testrail-improvement": "coverage:read",
  "automation-design": "coverage:read",
  reliability: "coverage:read",
  "knowledge-curation": "conflicts:read",
});

export const askTklAgentManifest = Object.freeze({
  id: "agent.ask-tkl",
  version: "0.1.0",
  capabilities: [
    "question.classify",
    "quality-knowledge.search",
    "approved-agent.orchestrate",
    "grounded-answer.synthesize",
  ],
  mode: "read-only",
});

export function createAskTklAgent({
  knowledgeService,
  coverageContextAgent,
  testDesignerAgent,
  testRailImprovementAgent,
  automationDesignerAgent,
  reliabilityDefectIntelligenceAgent,
  knowledgeCuratorAgent,
  investigationProvider = createUnavailableInvestigationProvider(),
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
} = {}) {
  if (!knowledgeService) throw new TypeError("knowledgeService is required");

  const agents = {
    "coverage-context": coverageContextAgent,
    "test-design": testDesignerAgent,
    "testrail-improvement": testRailImprovementAgent,
    "automation-design": automationDesignerAgent,
    reliability: reliabilityDefectIntelligenceAgent,
    "knowledge-curation": knowledgeCuratorAgent,
  };

  return {
    manifest: askTklAgentManifest,

    async execute({ productId, question, workItemId, unifiedContext }) {
      const generatedAt = now();
      const {
        classification: effectiveClassification,
        questionKeys,
        resolvedWorkItemId,
        resolvedCaseId,
      } = resolveAskTklIntent({ question, workItemId });
      const base = {
        runId: createRunId(),
        agent: askTklAgentManifest,
        productId,
        question,
        ...(resolvedWorkItemId ? { workItemId: resolvedWorkItemId } : {}),
        ...(resolvedCaseId ? { caseId: resolvedCaseId } : {}),
        generatedAt,
        intent: {
          primary: effectiveClassification.primary,
          matched: effectiveClassification.matched,
        },
        scope: {
          productId,
          ...(resolvedWorkItemId ? { workItemId: resolvedWorkItemId } : {}),
          interpretation: scopeInterpretation(
            effectiveClassification.primary,
            resolvedWorkItemId,
            resolvedCaseId,
          ),
        },
      };
      const reasoningPlan = createReasoningPlan({
        question,
        intent: effectiveClassification.primary,
        workItemId: resolvedWorkItemId,
        caseId: resolvedCaseId,
      });

      if (
        questionKeys.length > 1
        || (workItemId && questionKeys.length === 1 && questionKeys[0] !== workItemId)
      ) {
        return abstention(base, reasoningPlan, {
          limitation: "The question contains a Jira scope that conflicts with the supplied Jira key.",
          nextAction: "Ask one question for one exact Jira key, or make the optional Jira key match the question.",
        });
      }

      if (effectiveClassification.primary === "unsupported") {
        return abstention(base, reasoningPlan, {
          limitation:
            "The question is outside the supported product, requirement, testing, reliability, and knowledge-governance intents.",
          nextAction: "Ask a product or QA question grounded in synchronized TKL evidence.",
        });
      }

      if (effectiveClassification.requiresWorkItem && !resolvedWorkItemId) {
        return abstention(base, reasoningPlan, {
          limitation:
            `The ${effectiveClassification.primary} capability requires one exact Jira key to bound retrieval.`,
          nextAction: "Provide a Jira key such as STT-3731 and ask the question again.",
        });
      }

      const toolCalls = [];
      let result;
      if (effectiveClassification.primary === "ticket-intelligence") {
        const ticket = await summarizeTicket({
          knowledgeService,
          productId,
          workItemId: resolvedWorkItemId,
          toolCalls,
        });
        const selectedAgent = agents["coverage-context"];
        if (!selectedAgent || typeof selectedAgent.execute !== "function") {
          return abstention(base, reasoningPlan, {
            limitation: "Cross-platform coverage context is not configured.",
            nextAction: "Ask an administrator to enable the Coverage Context capability.",
          });
        }
        const coverage = await selectedAgent.execute({
          productId,
          workItemId: resolvedWorkItemId,
        });
        toolCalls.push({
          capability: selectedAgent.manifest?.id ?? "agent.coverage-context",
          status: coverage.status ?? "completed",
          summary: coverage.summary ?? "Cross-platform quality context was evaluated.",
        });
        result = combineTicketIntelligence(ticket, coverage);
      } else if (effectiveClassification.primary === "ticket-summary") {
        result = await summarizeTicket({
          knowledgeService,
          productId,
          workItemId: resolvedWorkItemId,
          toolCalls,
        });
      } else if (effectiveClassification.primary === "knowledge-search") {
        result = await searchKnowledge({
          knowledgeService,
          productId,
          question,
          toolCalls,
        });
      } else {
        const selectedAgent = agents[effectiveClassification.primary];
        if (!selectedAgent || typeof selectedAgent.execute !== "function") {
          return abstention(base, reasoningPlan, {
            limitation: `The classified ${effectiveClassification.primary} capability is not configured.`,
            nextAction: "Ask an administrator to enable the corresponding read-only TKL capability.",
          });
        }
        result = await selectedAgent.execute({
          productId,
          workItemId: resolvedWorkItemId,
          ...(resolvedCaseId ? { caseId: resolvedCaseId } : {}),
          ...(unifiedContext ? { unifiedContext } : {}),
        });
        toolCalls.push({
          capability: selectedAgent.manifest?.id ?? `agent.${effectiveClassification.primary}`,
          status: result.status ?? "completed",
          summary: result.summary ?? "The read-only capability completed.",
        });
      }

      if (reasoningPlan.investigation.required) {
        const investigation = await investigationProvider.investigate({
          productId,
          question,
          workItemId: resolvedWorkItemId,
          caseId: resolvedCaseId,
          plan: reasoningPlan.investigation,
          unifiedContext,
        });
        result = mergeInvestigationResult(result, investigation);
        toolCalls.push({
          capability: investigationProvider.manifest?.id ?? "provider.read-only-investigation",
          status: investigation.status ?? "completed",
          summary: investigation.summary ?? "Read-only investigation completed.",
        });
      }

      const evidenceIds = collectEvidenceIds(result, resolvedWorkItemId);
      const conflictResult = typeof knowledgeService.listKnowledgeConflicts === "function"
        ? await knowledgeService.listKnowledgeConflicts({ productId })
        : { conflicts: [] };
      if (typeof knowledgeService.listKnowledgeConflicts === "function") {
        toolCalls.push({
          capability: "list_knowledge_conflicts",
          status: "completed",
          summary: "Checked open conflicts in the authenticated product scope.",
        });
      }
      const conflicts = (conflictResult.conflicts ?? [])
        .filter((conflict) => evidenceIds.has(conflict.entityId))
        .slice(0, 20)
        .map((conflict) => ({
          id: conflict.id,
          entityId: conflict.entityId,
          reason: conflict.reason,
        }));
      const citations = buildCitations(productId, collectCitations(result)).slice(0, MAX_CITATIONS);
      const freshness = summarizeFreshness(citations, generatedAt);
      const limitations = unique([
        ...(result.limitations ?? []),
        ...(citations.length === 0 ? ["No source citation was returned by the selected capability."] : []),
      ]);
      const status = answerStatus(result, citations);
      const confidence = adjustedConfidence(result.confidence, {
        citations,
        conflicts,
        freshness,
        status,
      });
      const nextActions = collectNextActions(result, status);
      const reasoning = finalizeReasoningMetadata(reasoningPlan, result, {
        citations,
        conflicts,
      });

      return {
        ...base,
        status,
        answer: synthesizeAnswer({
          intent: effectiveClassification.primary,
          result,
          citations,
          conflicts,
          status,
        }),
        citations,
        freshness,
        confidence,
        conflicts,
        limitations,
        nextActions,
        toolCalls,
        ...reasoning,
      };
    },
  };
}

export function classifyQuestion(question) {
  const normalized = question.trim().toLowerCase();
  const matched = INTENT_RULES
    .filter((rule) =>
      (!rule.all || rule.all.every((term) => normalized.includes(term)))
      && rule.terms.some((term) => normalized.includes(term)))
    .map((rule) => rule.id);
  if (matched.length > 0) {
    const primary = matched[0];
    return {
      primary,
      matched,
      requiresWorkItem: INTENT_RULES.find((rule) => rule.id === primary).requiresWorkItem,
    };
  }
  const hasJiraKey = HAS_JIRA_KEY_PATTERN.test(question);
  if (hasJiraKey && TICKET_INTELLIGENCE_TERMS.some((term) => normalized.includes(term))) {
    return {
      primary: "ticket-intelligence",
      matched: ["ticket-intelligence"],
      requiresWorkItem: true,
    };
  }
  if (hasJiraKey && TICKET_SUMMARY_TERMS.some((term) => normalized.includes(term))) {
    return {
      primary: "ticket-summary",
      matched: ["ticket-summary"],
      requiresWorkItem: true,
    };
  }
  if (hasJiraKey || KNOWLEDGE_TERMS.some((term) => normalized.includes(term))) {
    return {
      primary: hasJiraKey ? "coverage-context" : "knowledge-search",
      matched: [hasJiraKey ? "coverage-context" : "knowledge-search"],
      requiresWorkItem: hasJiraKey,
    };
  }
  if (
    normalized.includes("?")
    && /\b(workflow|product|feature|field|rule|screen|user|customer|owner|business|individual)\b/i.test(normalized)
  ) {
    return {
      primary: "knowledge-search",
      matched: ["knowledge-search"],
      requiresWorkItem: false,
    };
  }
  return { primary: "unsupported", matched: [], requiresWorkItem: false };
}

export function requiredPermissionForAskTkl(request) {
  const { classification } = resolveAskTklIntent(request);
  return INTENT_PERMISSIONS[classification.primary];
}

export function resolveAskTklIntent({ question, workItemId }) {
  const classification = classifyQuestion(question);
  const questionKeys = unique(
    [...question.matchAll(JIRA_KEY_PATTERN)].map((match) => match[0]),
  );
  const questionCaseIds = unique(
    [...question.matchAll(TESTRAIL_CASE_PATTERN)].map((match) =>
      BigInt(match[1]).toString()),
  );
  const resolvedWorkItemId = workItemId ?? questionKeys[0];
  const resolvedCaseId = questionCaseIds.length === 1 ? questionCaseIds[0] : undefined;
  const effectiveClassification = resolvedCaseId
    && ["knowledge-search", "unsupported", "ticket-summary"].includes(classification.primary)
      ? {
          primary: "testrail-improvement",
          matched: unique(["testrail-improvement", ...classification.matched]),
          requiresWorkItem: false,
        }
    : resolvedWorkItemId
    && ["knowledge-search", "unsupported"].includes(classification.primary)
      ? {
          primary: "ticket-summary",
          matched: unique(["ticket-summary", ...classification.matched]),
          requiresWorkItem: true,
        }
      : classification;
  return {
    classification: effectiveClassification,
    questionKeys,
    resolvedWorkItemId,
    resolvedCaseId,
  };
}

async function searchKnowledge({ knowledgeService, productId, question, toolCalls }) {
  const terms = searchTerms(question);
  const responses = await Promise.all(
    terms.map((query) => knowledgeService.search({
      productId,
      query,
      limit: MAX_SEARCH_RESULTS,
      offset: 0,
    })),
  );
  const items = uniqueBy(
    responses.flatMap((response) => response.items ?? []),
    (item) => item.id,
  ).slice(0, MAX_SEARCH_RESULTS);
  toolCalls.push({
    capability: "search_quality_knowledge",
    status: items.length > 0 ? "completed" : "not-found",
    summary: `Searched canonical knowledge with ${terms.length} bounded term(s); found ${items.length} item(s).`,
  });
  return {
    status: items.length > 0 ? "ready-for-review" : "not-found",
    summary: items.length > 0
      ? `Found ${items.length} canonical knowledge item(s) relevant to the question.`
      : "No canonical knowledge matched the bounded search terms.",
    items,
    evidence: {
      citations: items.flatMap(provenanceEntries),
    },
    limitations: terms.length === 0
      ? ["No safe bounded search term could be derived from the question."]
      : [],
    confidence: {
      level: items.length > 0 ? "medium" : "none",
      rationale: items.length > 0
        ? "The response is limited to canonical title and identifier matches."
        : "TKL returned no matching canonical knowledge.",
    },
  };
}

async function summarizeTicket({ knowledgeService, productId, workItemId, toolCalls }) {
  if (typeof knowledgeService.getRequirementSummaryContext !== "function") {
    return {
      status: "insufficient-context",
      summary: `No grounded Jira summary capability is available for ${workItemId}.`,
      items: [],
      evidence: { citations: [] },
      limitations: ["The requirement summary context is not configured."],
      confidence: { level: "none", rationale: "No Jira summary context was available." },
    };
  }
  const context = await knowledgeService.getRequirementSummaryContext({
    productId,
    workItemId,
  });
  toolCalls.push({
    capability: "get_requirement_summary_context",
    status: context.requirement ? "completed" : "not-found",
    summary: context.requirement
      ? `Retrieved the bounded Jira summary context for ${workItemId}.`
      : `No canonical Jira requirement was found for ${workItemId}.`,
  });
  if (!context.requirement) {
    return {
      status: "not-found",
      summary: `No grounded Jira requirement was found for ${workItemId}.`,
      items: [],
      evidence: { citations: [] },
      limitations: ["The Jira work item is not present in canonical knowledge."],
      confidence: { level: "none", rationale: "No Jira requirement was found." },
    };
  }
  const textClaims = (context.claims ?? []).filter((claim) =>
    typeof claim.value === "string" && claim.value.trim().length > 0);
  const descriptions = textClaims.filter((claim) => claim.attribute === "description");
  const criteria = textClaims.filter((claim) => claim.attribute === "acceptanceCriteria");
  const metadata = textClaims.filter((claim) =>
    ["issueType", "status"].includes(claim.attribute));
  const structuredDescription = parseStructuredJiraDescription(descriptions[0]?.value ?? "");
  const descriptionItems = structuredDescription
    ? [
        ...(structuredDescription.issue ? [{
          id: `${descriptions[0].id}:issue`,
          type: "description",
          title: structuredDescription.issue,
        }] : []),
        ...(structuredDescription.acceptanceCriteria ? [{
          id: `${descriptions[0].id}:acceptance-criteria`,
          type: "acceptance-criterion",
          title: structuredDescription.acceptanceCriteria,
        }] : []),
        ...structuredDescription.reproSteps.map((step, index) => ({
          id: `${descriptions[0].id}:repro-step:${index + 1}`,
          type: "repro-step",
          title: step,
        })),
      ]
    : descriptions.slice(0, 1).map((claim) => ({
        id: claim.id,
        type: "description",
        title: String(claim.value).trim(),
      }));
  return {
    status: "ready-for-review",
    summary: `${workItemId}: ${context.requirement.title}`,
    items: uniqueBy([
      ...descriptionItems,
      ...metadata.map((claim) => ({
        id: claim.id,
        type: claim.attribute,
        title: `${claim.attribute === "issueType" ? "Type" : "Status"}: ${claim.value}`,
      })),
      ...(!structuredDescription?.acceptanceCriteria ? criteria.slice(0, 2) : []).map((claim) => ({
        id: claim.id,
        type: "acceptance-criterion",
        title: String(claim.value).trim(),
      })),
    ], (item) => `${item.type}:${item.title}`),
    evidence: {
      requirements: [context.requirement],
      citations: [
        ...provenanceEntries(context.requirement),
        ...textClaims.flatMap(provenanceEntries),
      ],
    },
    limitations: criteria.length > 2
      ? [`${criteria.length - 2} additional acceptance criterion/criteria are not shown in the concise summary.`]
      : [],
    confidence: {
      level: descriptions.length > 0 ? "high" : "medium",
      rationale: descriptions.length > 0
        ? "The summary is grounded in the Jira title and description."
        : "The summary is grounded in the Jira title and available metadata.",
    },
  };
}

function combineTicketIntelligence(ticket, coverage) {
  const sources = coverage.evidence?.sources ?? [];
  return {
    status: coverage.status === "not-found" ? ticket.status : coverage.status,
    summary: `${ticket.summary}. Cross-platform quality context: ${coverage.summary}`,
    ticket,
    coverage,
    findings: coverage.findings ?? [],
    recommendations: coverage.recommendations ?? [],
    items: ticket.items ?? [],
    evidence: {
      sources,
      requirements: uniqueBy([
        ...(ticket.evidence?.requirements ?? []),
        ...(coverage.evidence?.requirements ?? []),
      ], (item) => item.id),
      tests: coverage.evidence?.tests ?? [],
      relationships: coverage.evidence?.relationships ?? [],
      citations: uniqueBy([
        ...(ticket.evidence?.citations ?? []),
        ...(coverage.evidence?.citations ?? []),
      ], sourceVersionKey),
    },
    limitations: unique([
      ...(ticket.limitations ?? []),
      ...(coverage.limitations ?? []),
    ]),
    confidence: coverage.confidence ?? ticket.confidence,
  };
}

function searchTerms(question) {
  const jiraKeys = [...question.matchAll(JIRA_KEY_PATTERN)].map((match) => match[0]);
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
  return unique([
    ...jiraKeys,
    ...words.filter((word) => !STOP_WORDS.has(word) && !/^\d+$/.test(word)),
  ]).slice(0, MAX_SEARCH_TERMS);
}

function scopeInterpretation(intent, workItemId, caseId) {
  const root = caseId
    ? `the exact C${caseId} TestRail case and its bounded cross-source neighborhood`
    : workItemId
    ? `the exact ${workItemId} Jira hierarchy in the authenticated product`
    : "the authenticated product's bounded canonical knowledge";
  return `${intent.replaceAll("-", " ")} over ${root}`;
}

function abstention(base, reasoningPlan, { limitation, nextAction }) {
  return {
    ...base,
    status: "abstained",
    answer:
      "I cannot answer this from grounded TKL evidence. I will not use model memory or infer unsupported product facts.",
    citations: [],
    freshness: {
      status: "unknown",
      asOf: base.generatedAt,
      newestObservedAt: null,
      oldestObservedAt: null,
      staleCitationCount: 0,
      thresholdDays: FRESHNESS_DAYS,
    },
    confidence: { level: "none", rationale: limitation },
    conflicts: [],
    limitations: [limitation],
    nextActions: [nextAction],
    toolCalls: [],
    ...finalizeReasoningMetadata(reasoningPlan, {}, {}),
  };
}

function answerStatus(result, citations) {
  if (result.status === "not-found") return "not-found";
  if (citations.length === 0) return "abstained";
  if (result.status === "insufficient-context") return "insufficient-context";
  return "answered";
}

function synthesizeAnswer({ intent, result, citations, conflicts, status }) {
  if (status === "not-found") {
    return `${result.summary ?? "No matching TKL knowledge was found"} I will not fill the gap from model memory.`;
  }
  if (status === "abstained") {
    return "The selected capability returned no citable source evidence, so I cannot provide a grounded answer.";
  }
  const citationMarker = citations.slice(0, 2).map((citation) => `[${citation.id}]`).join(" ");
  const details = detailLines(intent, result).slice(0, MAX_DETAILS);
  const conflictNote = conflicts.length > 0
    ? ` ${conflicts.length} open conflict(s) affect this scope; treat the answer as review-required.`
    : "";
  return [
    `${result.summary} ${citationMarker}`.trim(),
    ...details.map((detail) => `- ${detail} ${citationMarker}`.trim()),
  ].join("\n") + conflictNote;
}

function detailLines(intent, result) {
  if (intent === "ticket-intelligence") {
    const items = result.ticket?.items ?? [];
    const descriptions = items
      .filter((item) => item.type === "description")
      .map((item) => `Description: ${item.title}`);
    const criteria = items
      .filter((item) => item.type === "acceptance-criterion")
      .map((item) => `Acceptance criterion: ${item.title}`);
    const metadata = items
      .filter((item) => ["issueType", "status"].includes(item.type))
      .map((item) => item.title);
    const reproSteps = items.filter((item) => item.type === "repro-step");
    const coverage = result.coverage?.evidence ?? {};
    const platformLine =
      `Cross-platform evidence: Jira ${coverage.requirements?.length ?? 0} requirement(s); `
      + `TestRail ${coverage.tests?.filter((item) => item.type === "manual-test").length ?? 0} manual test(s); `
      + `GitHub ${coverage.tests?.filter((item) => item.type === "test").length ?? 0} automated test(s); `
      + `TestRail/ReportPortal ${coverage.tests?.filter((item) =>
        item.type === "test-execution").length ?? 0} execution record(s).`;
    const reproLine = reproSteps.length > 0
      ? `Repro steps: ${reproSteps.map((item, index) => `${index + 1}. ${item.title}`).join(" ")}`
      : null;
    return [
      ...descriptions,
      ...criteria,
      ...metadata,
      platformLine,
      ...(result.findings ?? []).map((finding) => `${finding.title}: ${finding.detail}`),
      ...(reproLine ? [reproLine] : []),
    ];
  }
  if (intent === "coverage-context") {
    return (result.findings ?? []).map((finding) => `${finding.title}: ${finding.detail}`);
  }
  if (intent === "test-design") {
    return (result.proposals ?? []).map((proposal) =>
      `${proposal.title}: ${proposal.disposition.replaceAll("-", " ")}.`);
  }
  if (intent === "testrail-improvement") {
    const sourceLines = Object.entries(result.evidence?.sourceStatus ?? {})
      .map(([source, status]) =>
        `${source}: ${status.state}${status.detail ? ` — ${status.detail}` : ""}`);
    const proposalLines = (result.proposals ?? []).map((proposal) =>
      `${proposal.title}: ${(proposal.findings ?? []).map((finding) => finding.detail).join(" ")}`);
    return [...sourceLines, ...proposalLines];
  }
  if (intent === "automation-design") {
    const files = result.proposal?.filePlan ?? [];
    if (files.length > 0) {
      return files.map((file) => `${file.action.replaceAll("-", " ")} ${file.targetPath}: ${file.rationale}`);
    }
    return result.proposal?.codeGeneration?.rationale
      ? [`Automation code ${result.proposal.codeGeneration.status}: ${result.proposal.codeGeneration.rationale}`]
      : [];
  }
  if (intent === "reliability") {
    return (result.analyses ?? []).map((analysis) =>
      `${analysis.title}: ${analysis.classification.replaceAll("-", " ")}. ${analysis.rationale}`);
  }
  if (intent === "knowledge-curation") {
    return (result.findings ?? []).map((finding) =>
      `${finding.title}: ${finding.detail} (${finding.disposition.replaceAll("-", " ")}).`);
  }
  return (result.items ?? []).map((item) => `${item.title} (${item.type}, ${item.id}).`);
}

function collectNextActions(result, status) {
  const actions = [
    ...(result.recommendations ?? []).map((item) => item.action),
    ...(result.proposals ?? []).map((item) => item.title),
    ...(result.proposal?.discoveryTasks ?? []).map((item) => item.action),
  ];
  if (status === "not-found") {
    actions.push("Connect the relevant source, then repeat the exact lookup for on-demand retrieval.");
  } else if (status === "abstained") {
    actions.push("Add a Jira key or connect source evidence that directly supports the question.");
  }
  return unique(actions.filter(Boolean)).slice(0, 3);
}

function collectEvidenceIds(result, workItemId) {
  const ids = new Set();
  if (workItemId) ids.add(`requirement:${workItemId}`);
  for (const collection of [
    result.items,
    result.evidence?.requirements,
    result.evidence?.tests,
    result.evidence?.entities,
    result.evidence?.manualTests,
    result.evidence?.automatedTests,
    result.evidence?.jiraDefects,
  ]) {
    for (const item of collection ?? []) {
      if (item?.id) ids.add(item.id);
    }
  }
  return ids;
}

function collectCitations(result) {
  return uniqueBy([
    ...(result.evidence?.citations ?? []),
    ...(result.items ?? []).flatMap(provenanceEntries),
  ].filter((citation) =>
    typeof citation?.source === "string"
    && typeof citation?.sourceId === "string"
    && typeof citation?.sourceVersion === "string"
    && typeof citation?.observedAt === "string"), sourceVersionKey);
}

function buildCitations(productId, citations) {
  return citations.map((citation, index) => {
    const resourceUri =
      `tkl://products/${encodeURIComponent(productId)}/sources/`
      + `${encodeURIComponent(citation.source)}/${encodeURIComponent(citation.sourceId)}/provenance`;
    return {
      id: `S${index + 1}`,
      source: citation.source,
      sourceId: citation.sourceId,
      sourceVersion: citation.sourceVersion,
      observedAt: citation.observedAt,
      ...(citation.sourceUrl ? { sourceUrl: citation.sourceUrl } : {}),
      resourceUri,
      href:
        `/v1/resources/read?productId=${encodeURIComponent(productId)}`
        + `&uri=${encodeURIComponent(resourceUri)}`,
    };
  });
}

function summarizeFreshness(citations, generatedAt) {
  const validDates = citations
    .map((citation) => ({ citation, time: Date.parse(citation.observedAt) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => left.time - right.time);
  if (validDates.length === 0) {
    return {
      status: "unknown",
      asOf: generatedAt,
      newestObservedAt: null,
      oldestObservedAt: null,
      staleCitationCount: 0,
      thresholdDays: FRESHNESS_DAYS,
    };
  }
  const asOfTime = Date.parse(generatedAt);
  const thresholdMs = FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  const staleCitationCount = validDates.filter((entry) =>
    Number.isFinite(asOfTime) && asOfTime - entry.time > thresholdMs).length;
  return {
    status: staleCitationCount === 0
      ? "current"
      : staleCitationCount === validDates.length ? "stale" : "mixed",
    asOf: generatedAt,
    newestObservedAt: new Date(validDates.at(-1).time).toISOString(),
    oldestObservedAt: new Date(validDates[0].time).toISOString(),
    staleCitationCount,
    thresholdDays: FRESHNESS_DAYS,
  };
}

function adjustedConfidence(confidence, { citations, conflicts, freshness, status }) {
  if (status === "not-found" || status === "abstained" || citations.length === 0) {
    return {
      level: "none",
      rationale: "No citable evidence supports a product answer.",
    };
  }
  const levels = ["none", "low", "medium", "high"];
  let index = Math.max(1, levels.indexOf(confidence?.level ?? "low"));
  const reasons = [confidence?.rationale ?? "The selected TKL capability returned cited evidence."];
  if (freshness.status === "stale" || freshness.status === "mixed") {
    index = Math.max(1, index - 1);
    reasons.push("One or more citations are older than the freshness threshold.");
  }
  if (conflicts.length > 0) {
    index = Math.max(1, index - 1);
    reasons.push("Open knowledge conflicts affect the scoped evidence.");
  }
  return { level: levels[index], rationale: reasons.join(" ") };
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function sourceVersionKey(value) {
  return `${value?.source ?? ""}|${value?.sourceId ?? ""}|${value?.sourceVersion ?? ""}`;
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, key) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => key(candidate) === key(value)) === index);
}
