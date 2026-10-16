import { randomUUID } from "node:crypto";

export const automationDesignerAgentManifest = Object.freeze({
  id: "agent.automation-designer",
  version: "0.1.0",
  capabilities: [
    "quality-context.read",
    "repository-evidence.read",
    "automation.plan.propose",
    "repository-components.reuse.propose",
    "validation.plan.propose",
  ],
  mode: "proposal-only",
});

export function createAutomationDesignerAgent({
  knowledgeService,
  testDesignerAgent,
  now = () => new Date().toISOString(),
  createRunId = () => randomUUID(),
  maxCases = 12,
} = {}) {
  if (!knowledgeService) throw new TypeError("knowledgeService is required");

  return {
    manifest: automationDesignerAgentManifest,

    async execute({ productId, workItemId }) {
      const context = await knowledgeService.getAutomationDesignContext({
        productId,
        workItemId,
      });
      const run = {
        runId: createRunId(),
        agent: automationDesignerAgentManifest,
        productId,
        workItemId,
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
          summary: `No grounded automation design context was found for ${workItemId}.`,
          proposal: emptyProposal(),
          evidence: emptyEvidence(),
          limitations: ["No canonical Jira requirement was found."],
        };
      }

      const manualCases = [
        ...synchronizedManualCases(context.manualCaseContexts ?? []),
        ...await proposedManualCases(testDesignerAgent, { productId, workItemId }),
      ].slice(0, maxCases);
      const repositoryFiles = (context.repositoryFiles ?? []).map((file) => ({
        ...file,
        role: classifyRepositoryFile(file.path),
      }));
      const scopeFiles = (context.scopeRepositoryFiles ?? []).map((file) => ({
        ...file,
        role: classifyRepositoryFile(file.path),
      }));
      const conventions = inferConventions(repositoryFiles);
      const reusableComponents = repositoryFiles
        .filter((file) => ["page-object", "fixture", "utility"].includes(file.role))
        .slice(0, 12)
        .map((file) => ({
          path: file.path,
          role: file.role,
          confidence: {
            level: "low",
            rationale:
              "The candidate is identified from its synchronized repository path; file content was not inspected.",
          },
          rationale: `Review this existing ${file.role} before adding a duplicate component.`,
          citations: uniqueCitations(provenanceEntries(file)),
        }));
      const filePlan = buildFilePlan({
        manualCases,
        scopeFiles,
        conventions,
      });
      const codeOutline = manualCases.map(outlineFromManualCase);
      const requiredTestData = collectRequiredTestData(manualCases);
      const validationCommands = validationCommandsFromEvidence(repositoryFiles);
      const contentAvailable = scopeFiles.length > 0
        && scopeFiles.every((file) => file.contentAvailable);
      const discoveryTasks = buildDiscoveryTasks({
        context,
        manualCases,
        repositoryFiles,
        scopeFiles,
        reusableComponents,
        validationCommands,
        contentAvailable,
      });
      const limitations = buildLimitations({
        context,
        manualCases,
        repositoryFiles,
        scopeFiles,
        contentAvailable,
        validationCommands,
      });
      const citations = uniqueCitations([
        ...(context.trace.requirements ?? []).flatMap(provenanceEntries),
        ...(context.requirementClaims ?? []).flatMap(({ claim }) => provenanceEntries(claim)),
        ...manualCases.flatMap((item) => item.citations),
        ...(context.githubAutomation ?? []).flatMap(provenanceEntries),
        ...repositoryFiles.flatMap(provenanceEntries),
      ]);
      const ready = manualCases.length > 0
        && (context.githubAutomation ?? []).length > 0
        && repositoryFiles.length > 0;

      return {
        ...run,
        status: ready ? "ready-for-review" : "insufficient-context",
        confidence: confidenceFor({
          ready,
          manualCases,
          scopeFiles,
          repositoryFiles,
          contentAvailable,
        }),
        summary: `${manualCases.length} approved/proposed manual case(s) and `
          + `${repositoryFiles.length} synchronized repository file path(s) were evaluated for `
          + `${workItemId}; ${filePlan.length} automation file-plan item(s) are ready for review.`,
        proposal: {
          delivery: "review-only",
          codeGeneration: {
            status: contentAvailable ? "not-requested" : "abstained",
            rationale: contentAvailable
              ? "Phase 4 returns a structured implementation outline, not repository-writing code."
              : "Repository file contents are not synchronized, so executable code would be fabricated.",
          },
          filePlan,
          codeOutline,
          reusableComponents,
          requiredTestData,
          validationCommands,
          conventions,
          discoveryTasks,
        },
        evidence: {
          sources: unique(citations.map((citation) => citation.source)),
          requirements: context.trace.requirements ?? [],
          manualCases: manualCases.map(({ internalClaims: _claims, ...item }) => item),
          automatedTests: context.githubAutomation ?? [],
          repositoryFiles: repositoryFiles.map(({ content: _content, ...file }) => file),
          citations,
        },
        limitations,
      };
    },
  };
}

function synchronizedManualCases(caseContexts) {
  return caseContexts
    .filter((caseContext) => caseContext.conflictedClaimCount === 0)
    .map(({ testCase, claims, requirementIds }) => {
      const citations = uniqueCitations(
        [testCase, ...claims].flatMap(provenanceEntries),
      );
      const steps = latestClaimValue(claims, "custom_steps_separated");
      const plainSteps = latestClaimValue(claims, "custom_steps");
      const expected = latestClaimValue(claims, "custom_expected");
      return {
        id: testCase.id,
        title: testCase.title,
        origin: claims.some((claim) => claim.status === "approved")
          ? "approved"
          : "proposed",
        source: "testrail",
        requirementIds,
        preconditions: textValues(latestClaimValue(claims, "custom_preconds")),
        steps: Array.isArray(steps)
          ? steps.map((step, index) => ({
              order: index + 1,
              action: String(step?.content ?? "").trim(),
              expectedResult: String(step?.expected ?? "").trim(),
            }))
          : textValues(plainSteps).map((action, index) => ({
              order: index + 1,
              action,
              expectedResult: typeof expected === "string" ? expected : "",
            })),
        expectedResult: typeof expected === "string" ? expected : "",
        citations,
        internalClaims: claims,
      };
    });
}

async function proposedManualCases(testDesignerAgent, request) {
  if (!testDesignerAgent) return [];
  const result = await testDesignerAgent.execute(request);
  if (result.status === "not-found") return [];
  return result.proposals.map((proposal) => ({
    id: proposal.id,
    title: proposal.title,
    origin: "proposed",
    source: "test-designer",
    requirementIds: proposal.requirementIds,
    preconditions: proposal.preconditions,
    steps: proposal.steps,
    expectedResult: proposal.expectedResult,
    citations: proposal.citations,
    internalClaims: [],
  }));
}

function buildFilePlan({ manualCases, scopeFiles, conventions }) {
  const scopedTests = scopeFiles.filter((file) => file.role === "test");
  return manualCases.map((manualCase) => {
    const existing = scopedTests.length === 1 ? scopedTests[0] : undefined;
    const targetPath = existing?.path
      ?? proposedPath(conventions, manualCase.title);
    return {
      id: `automation-file-plan:${manualCase.id}`,
      action: existing ? "extend" : "discover-before-create",
      targetPath,
      sourceCaseIds: [manualCase.id],
      requirementIds: manualCase.requirementIds,
      rationale: existing
        ? "The only synchronized test path in a Jira-linked pull request is the grounded extension candidate."
        : "No unambiguous Jira-linked test path is available; the target remains a reviewer-selected placeholder.",
      evidenceIds: unique([
        manualCase.id,
        ...(existing ? [existing.id] : []),
      ]),
      citations: uniqueCitations([
        ...manualCase.citations,
        ...provenanceEntries(existing),
      ]),
    };
  });
}

function outlineFromManualCase(manualCase) {
  return {
    sourceCaseId: manualCase.id,
    title: manualCase.title,
    requirementIds: manualCase.requirementIds,
    sections: {
      setup: manualCase.preconditions.length > 0
        ? manualCase.preconditions
        : ["Reviewer must supply setup supported by repository fixtures and the cited manual case."],
      actions: manualCase.steps
        .map((step) => step.action)
        .filter(Boolean),
      assertions: unique([
        ...manualCase.steps.map((step) => step.expectedResult).filter(Boolean),
        ...textValues(manualCase.expectedResult),
      ]),
    },
    implementationNote:
      "Translate this behavioral outline only after the target test, reusable components, and fixtures have been inspected.",
    citations: manualCase.citations,
  };
}

function collectRequiredTestData(manualCases) {
  return manualCases.flatMap((manualCase) =>
    manualCase.preconditions
      .filter((value) => value && !value.toLowerCase().includes("reviewer"))
      .map((value, index) => ({
        id: `test-data:${manualCase.id}:${index + 1}`,
        description: value,
        sourceCaseId: manualCase.id,
        status: "review-required",
        citations: manualCase.citations,
      })));
}

function validationCommandsFromEvidence(repositoryFiles) {
  const commands = [];
  for (const file of repositoryFiles) {
    if (!/(^|\/)package\.json$/i.test(file.path) || !file.contentAvailable) continue;
    let manifest;
    try {
      manifest = JSON.parse(file.content);
    } catch {
      continue;
    }
    if (!manifest?.scripts || typeof manifest.scripts !== "object") continue;
    const workingDirectory = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : ".";
    for (const name of ["test", "typecheck", "lint", "build"]) {
      if (typeof manifest.scripts[name] !== "string") continue;
      commands.push({
        command: `npm run ${name}`,
        workingDirectory,
        rationale: `The synchronized ${file.path} declares the "${name}" script.`,
        citations: uniqueCitations(provenanceEntries(file)),
      });
    }
  }
  return uniqueBy(commands, (item) => `${item.workingDirectory}:${item.command}`);
}

function inferConventions(files) {
  const testFiles = files.filter((file) => file.role === "test");
  const suffixes = testFiles.map(({ path }) => {
    const match = path.match(/(\.(?:spec|test)\.[^.]+)$/i);
    return match?.[1];
  }).filter(Boolean);
  const directories = testFiles.map(({ path }) =>
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
  const extensions = files.map(({ path }) => path.match(/(\.[a-z0-9]+)$/i)?.[1]).filter(Boolean);
  const frameworkSignals = [];
  for (const file of files.filter((item) => item.contentAvailable)) {
    if (file.path.endsWith("package.json")) {
      try {
        const manifest = JSON.parse(file.content);
        const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
        for (const [dependency, framework] of [
          ["@playwright/test", "playwright"],
          ["cypress", "cypress"],
          ["vitest", "vitest"],
          ["jest", "jest"],
        ]) {
          if (dependencies?.[dependency]) frameworkSignals.push(framework);
        }
      } catch {
        // Invalid or unavailable repository content is not used as evidence.
      }
    }
  }
  return {
    testDirectories: rankedUnique(directories),
    testFileSuffixes: rankedUnique(suffixes),
    fileExtensions: rankedUnique(extensions),
    frameworkSignals: unique(frameworkSignals),
  };
}

function proposedPath(conventions, title) {
  const directory = conventions.testDirectories[0];
  const suffix = conventions.testFileSuffixes[0];
  if (!directory || !suffix) return "[repository test path to be discovered]";
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "reviewer-selected-scenario";
  return `${directory}/${slug}${suffix}`;
}

function buildDiscoveryTasks({
  context,
  manualCases,
  repositoryFiles,
  scopeFiles,
  reusableComponents,
  validationCommands,
  contentAvailable,
}) {
  const tasks = [];
  if ((context.githubAutomation ?? []).length === 0) {
    tasks.push(discoveryTask(
      "link-github-automation",
      "Synchronize or review the explicit GitHub automation link for the requested Jira scope.",
      "No linked GitHub automation entity is available.",
      context.trace.requirements?.map((item) => item.id) ?? [],
    ));
  }
  if (repositoryFiles.length === 0) {
    tasks.push(discoveryTask(
      "index-repository-files",
      "Synchronize GitHub changed-file evidence for the linked repository and pull request.",
      "No repository file paths are indexed for this scope.",
      (context.githubAutomation ?? []).map((item) => item.id),
    ));
  }
  if (repositoryFiles.length > 0 && !contentAvailable) {
    tasks.push(discoveryTask(
      "collect-repository-file-contents",
      "Collect read-only contents for the target tests, framework configuration, page objects, fixtures, utilities, and package manifests.",
      "Changed-file paths alone cannot support executable code or exact validation commands.",
      unique(repositoryFiles.map((item) => item.id)),
    ));
  }
  if (scopeFiles.filter((file) => file.role === "test").length === 0) {
    tasks.push(discoveryTask(
      "identify-target-test",
      "Inspect repository test directories and select the existing test to extend or the approved location for a new test.",
      "No synchronized test file is directly associated with the Jira-linked pull request.",
      scopeFiles.map((item) => item.id),
    ));
  }
  if (reusableComponents.length === 0 && repositoryFiles.length > 0) {
    tasks.push(discoveryTask(
      "discover-reusable-components",
      "Inspect repository page objects, fixtures, and utilities before introducing new helpers.",
      "Changed-file evidence does not identify a reusable component candidate.",
      repositoryFiles.map((item) => item.id),
    ));
  }
  if (validationCommands.length === 0 && repositoryFiles.length > 0) {
    tasks.push(discoveryTask(
      "discover-validation-commands",
      "Collect and inspect repository manifests or CI workflow contents to identify supported validation commands.",
      "No exact command is present in the collected repository evidence.",
      repositoryFiles.map((item) => item.id),
    ));
  }
  if (manualCases.length === 0) {
    tasks.push(discoveryTask(
      "approve-or-propose-manual-case",
      "Approve a synchronized TestRail case or review a grounded Test Designer proposal before automation design.",
      "Automation must start from an approved or proposed manual case.",
      context.trace.requirements?.map((item) => item.id) ?? [],
    ));
  }
  return tasks;
}

function discoveryTask(id, action, rationale, evidenceIds) {
  return { id, action, rationale, evidenceIds: unique(evidenceIds) };
}

function buildLimitations({
  context,
  manualCases,
  repositoryFiles,
  scopeFiles,
  contentAvailable,
  validationCommands,
}) {
  const limitations = [
    "This agent is proposal-only and has no repository, branch, commit, or pull-request write capability.",
  ];
  if (manualCases.length === 0) {
    limitations.push("No approved or proposed manual case is available for this Jira scope.");
  }
  if ((context.githubAutomation ?? []).length === 0) {
    limitations.push("No synchronized GitHub automation is linked to the requested Jira scope.");
  }
  if (repositoryFiles.length === 0) {
    limitations.push("No synchronized GitHub changed-file evidence is indexed for the linked repository.");
  } else if (!contentAvailable) {
    limitations.push(
      "Repository file contents are not collected; code generation is explicitly abstained and path-based component classifications require review.",
    );
  }
  if (scopeFiles.length === 0 && repositoryFiles.length > 0) {
    limitations.push(
      "Repository conventions are available only from other synchronized pull requests in the linked repository.",
    );
  }
  if (context.repositoryEvidenceTruncated) {
    limitations.push(
      "Repository evidence was truncated to the bounded response limit; review additional files before implementation.",
    );
  }
  if (scopeFiles.filter((file) => file.role === "test").length > 1) {
    limitations.push(
      "Multiple Jira-linked test paths exist, so the agent abstained from assigning cases to files without stronger evidence.",
    );
  }
  if (validationCommands.length === 0) {
    limitations.push(
      "No validation command is proposed because no synchronized manifest content proves an available command.",
    );
  }
  if ((context.manualCaseContexts ?? []).some((item) => item.conflictedClaimCount > 0)) {
    limitations.push("Manual cases with unresolved claim conflicts were excluded.");
  }
  return limitations;
}

function confidenceFor({ ready, manualCases, scopeFiles, repositoryFiles, contentAvailable }) {
  if (!ready) {
    return {
      level: "low",
      rationale:
        "Jira scope is available, but manual-case or synchronized GitHub repository evidence is incomplete.",
    };
  }
  if (
    contentAvailable
    && scopeFiles.some((file) => file.role === "test")
    && manualCases.some((item) => item.origin === "approved")
  ) {
    return {
      level: "high",
      rationale:
        "An approved manual case, Jira-linked test path, and repository file contents are available.",
    };
  }
  return {
    level: "medium",
    rationale:
      "Manual-case, Jira, and repository path evidence are available, but implementation details require repository-content discovery.",
  };
}

function classifyRepositoryFile(path) {
  const normalized = path.toLowerCase().replaceAll("\\", "/");
  const name = normalized.split("/").at(-1);
  if (
    /(^|\/)(page-?objects?|pages|pom)(\/|$)/.test(normalized)
    || /\.page\.[a-z0-9]+$/.test(normalized)
  ) return "page-object";
  if (/(^|\/)(fixtures?|test-data|testdata)(\/|$)/.test(normalized)) return "fixture";
  if (/(^|\/)(utils?|utilities|helpers?|support|common)(\/|$)/.test(normalized)) {
    return "utility";
  }
  if (
    /(^|\/)(__tests__|tests?|e2e|integration|specs?)(\/|$)/.test(normalized)
    || /\.(spec|test)\.[a-z0-9]+$/.test(normalized)
  ) return "test";
  if (
    name === "package.json"
    || name?.endsWith(".config.ts")
    || name?.endsWith(".config.js")
    || name?.startsWith("tsconfig")
    || name?.endsWith(".yml")
    || name?.endsWith(".yaml")
  ) return "configuration";
  return "other";
}

function latestClaimValue(claims, attribute) {
  return claims.filter((claim) => claim.attribute === attribute).at(-1)?.value;
}

function textValues(value) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function provenanceEntries(value) {
  if (!value?.provenance) return [];
  return Array.isArray(value.provenance) ? value.provenance : [value.provenance];
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueBy(values, key) {
  return values.filter((value, index) =>
    values.findIndex((candidate) => key(candidate) === key(value)) === index);
}

function rankedUnique(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
}

function uniqueCitations(values) {
  return values.filter((value, index) =>
    values.findIndex((candidate) =>
      candidate.source === value.source
      && candidate.sourceId === value.sourceId
      && candidate.sourceVersion === value.sourceVersion) === index);
}

function emptyProposal() {
  return {
    delivery: "review-only",
    codeGeneration: {
      status: "abstained",
      rationale: "No grounded Jira scope is available.",
    },
    filePlan: [],
    codeOutline: [],
    reusableComponents: [],
    requiredTestData: [],
    validationCommands: [],
    conventions: {
      testDirectories: [],
      testFileSuffixes: [],
      fileExtensions: [],
      frameworkSignals: [],
    },
    discoveryTasks: [],
  };
}

function emptyEvidence() {
  return {
    sources: [],
    requirements: [],
    manualCases: [],
    automatedTests: [],
    repositoryFiles: [],
    citations: [],
  };
}
