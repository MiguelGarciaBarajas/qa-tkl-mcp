import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setTklApiClientForTests } from "../api/client";
import type { TklApiClient } from "../api/client";
import type {
  ApprovedActionPreview,
  CoverageContextAgentRun,
  KnowledgeCuratorAgentRun,
  ReliabilityDefectIntelligenceAgentRun,
  TestDesignerAgentRun,
  TestRailImprovementAgentRun,
} from "../contracts/types";
import { AgentWorkbenchPage } from "./AgentWorkbenchPage";

const result: CoverageContextAgentRun = {
  runId: "run-1",
  agent: {
    id: "agent.coverage-context",
    version: "0.1.0",
    mode: "read-only",
  },
  productId: "fl-titling",
  workItemId: "STT-3731",
  generatedAt: "2026-09-14T00:00:00.000Z",
  status: "insufficient-context",
  confidence: {
    level: "low",
    rationale: "The result is based primarily on Jira.",
  },
  summary: "STT-3731 has no linked test evidence.",
  findings: [{
    id: "manual-coverage-missing",
    severity: "medium",
    category: "coverage-gap",
    title: "No linked manual tests",
    detail: "No TestRail manual-test entity is linked.",
    evidenceIds: ["requirement:STT-3731"],
  }],
  recommendations: [{
    id: "sync-testrail",
    priority: "high",
    action: "Connect TestRail and retrieve related cases on demand.",
    rationale: "Existing cases must be checked first.",
  }],
  evidence: {
    sources: ["jira"],
    requirements: [{ id: "requirement:STT-3731", title: "FL Modernization" }],
    tests: [],
    relationships: [],
    citations: [{
      source: "jira",
      sourceId: "STT-3731",
      sourceVersion: "1",
      observedAt: "2026-09-13T00:00:00.000Z",
    }],
  },
  limitations: ["No testrail evidence is present in this result."],
};

function fakeClient(
  runAgent: TklApiClient["runCoverageContextAgent"],
  runDesigner: TklApiClient["runTestDesignerAgent"] = () => Promise.reject(new Error("not used")),
  runImprovement: TklApiClient["runTestRailImprovementAgent"] =
    () => Promise.reject(new Error("not used")),
  runAutomation: TklApiClient["runAutomationDesignerAgent"] =
    () => Promise.reject(new Error("not used")),
  runReliability: TklApiClient["runReliabilityDefectIntelligenceAgent"] =
    () => Promise.reject(new Error("not used")),
  runCurator: TklApiClient["runKnowledgeCuratorAgent"] =
    () => Promise.reject(new Error("not used")),
): TklApiClient {
  return {
    resolveArtifacts: () => Promise.reject(new Error("not used")),
    askTkl: () => Promise.reject(new Error("not used")),
    getConnectorHealth: () => Promise.resolve([]),
    getTicketContextOperations: () => Promise.reject(new Error("not used")),
    getStoryTraceability: () => Promise.resolve([]),
    getTicketContextJob: () => Promise.resolve(null),
    refreshTicketContext: () => Promise.reject(new Error("not used")),
    cancelTicketContext: () => Promise.reject(new Error("not used")),
    getCoverageGaps: () => Promise.resolve([]),
    getKnowledgeInventory: () => Promise.reject(new Error("not used in these tests")),
    getKnowledgeConflicts: () => Promise.resolve([]),
    reviewKnowledgeConflict: () => Promise.reject(new Error("not used")),
    getEvaluationMetrics: () => Promise.reject(new Error("not used")),
    runCoverageContextAgent: runAgent,
    runTestDesignerAgent: runDesigner,
    runTestRailImprovementAgent: runImprovement,
    runAutomationDesignerAgent: runAutomation,
    runReliabilityDefectIntelligenceAgent: runReliability,
    runKnowledgeCuratorAgent: runCurator,
    getSourceConnections: () => Promise.resolve([]),
    getGitHubRepositories: () => Promise.resolve([]),
    getGitHubRepository: () => Promise.reject(new Error("not used")),
    createGitHubRepository: () => Promise.reject(new Error("not used")),
    updateGitHubRepository: () => Promise.reject(new Error("not used")),
    deleteGitHubRepository: () => Promise.reject(new Error("not used")),
    testGitHubRepository: () => Promise.reject(new Error("not used")),
    syncGitHubRepository: () => Promise.reject(new Error("not used")),
    cancelGitHubRepositorySync: () => Promise.reject(new Error("not used")),
    discoverTestRailSuites: () => Promise.resolve([]),
    discoverTestRailSections: () => Promise.resolve([
      { id: "1201", suiteId: "77", parentId: null, depth: 0, name: "Regression" },
    ]),
    discoverConfluencePages: () => Promise.resolve({ baseUrl: "", authMode: "bearer", roots: [] }),
    saveSourceConnection: () => Promise.reject(new Error("not used")),
    testSourceConnection: () => Promise.reject(new Error("not used")),
    syncSourceConnection: () => Promise.reject(new Error("not used")),
    cancelSourceConnectionSync: () => Promise.reject(new Error("not used")),
    disconnectSourceConnection: () => Promise.reject(new Error("not used")),
  };
}

describe("AgentWorkbenchPage", () => {
  afterEach(() => setTklApiClientForTests(null));

  it("starts with one guided TestRail workflow and requires a selected draft", async () => {
    const client = fakeClient(() => Promise.resolve(result));
    setTklApiClientForTests(client);
    render(<AgentWorkbenchPage />);

    expect(screen.getByRole("combobox", { name: /proposal workflow/i })).toHaveValue("manual-tests");
    expect(screen.queryByRole("button", { name: /review testrail case/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/approved action type/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/source version/i)).not.toBeInTheDocument();
  });

  it("runs the active analyst and renders grounded findings", async () => {
    const runAgent = vi.fn(async () => result);
    setTklApiClientForTests(fakeClient(runAgent));
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /proposal workflow/i }), {
      target: { value: "coverage" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run analyst/i }));

    await waitFor(() => expect(screen.getByText("STT-3731 analysis")).toBeInTheDocument());
    expect(runAgent).toHaveBeenCalledWith("STT-3731");
    expect(screen.getByText("insufficient context")).toBeInTheDocument();
    expect(screen.getByText("No linked manual tests")).toBeInTheDocument();
    expect(screen.getByText("Connect TestRail and retrieve related cases on demand."))
      .toBeInTheDocument();
    expect(screen.getByText(/no testrail evidence/i)).toBeInTheDocument();
  });

  it("shows ticket context for the Jira item used by an agent flow", async () => {
    const client = fakeClient(() => Promise.resolve(result));
    client.getTicketContextJob = vi.fn(async () => null);
    setTklApiClientForTests(client);
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /proposal workflow/i }), {
      target: { value: "coverage" },
    });
    await waitFor(() => expect(screen.getByText("Ticket context for STT-3731")).toBeInTheDocument());
    expect(screen.getByText(/no enrichment job exists yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run analyst/i })).toBeEnabled();
  });

  it("renders reviewable Test Designer drafts", async () => {
    const designerResult: TestDesignerAgentRun = {
      runId: "designer-run-1",
      agent: { id: "agent.test-designer", version: "0.1.0", mode: "proposal-only" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T01:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Acceptance criteria available." },
      summary: "One manual test draft proposed.",
      proposals: [{
        id: "draft-1",
        disposition: "propose-new",
        title: "Verify valid VIN",
        objective: "Verify the requirement.",
        preconditions: ["Workflow available."],
        steps: [{
          order: 1,
          action: "Submit a valid VIN.",
          expectedResult: "The application is accepted.",
        }],
        expectedResult: "The application is accepted.",
        requirementIds: ["requirement:STT-100"],
        duplicateCandidates: [],
        confidence: { level: "high", rationale: "Explicit criterion." },
        citations: [{
          source: "jira",
          sourceId: "STT-100",
          sourceVersion: "7",
          observedAt: "2026-09-14T00:00:00.000Z",
        }],
      }],
      evidence: {
        sources: ["jira"],
        requirements: [{ id: "requirement:STT-100", title: "Valid VIN" }],
        existingManualTests: [],
        citations: [],
      },
      limitations: ["No synchronized TestRail cases are available."],
    };
    const runDesigner = vi.fn(async () => designerResult);
    const client = fakeClient(() => Promise.resolve(result), runDesigner);
    const preview: ApprovedActionPreview = {
      id: "preview:00000000-0000-4000-8000-000000000001",
      productId: "fl-titling",
      subject: "qa-reviewer",
      actionType: "testrail.case.create",
      target: { sectionId: "1201" },
      changes: {
        title: "Verify valid VIN",
        refs: "STT-100",
        custom_preconds: "Workflow available.",
        custom_steps_separated: [{
          content: "Submit a valid VIN.",
          expected: "The application is accepted.",
        }],
      },
      sourceVersions: [{ source: "jira", sourceId: "STT-100", sourceVersion: "7" }],
      requiredPermission: "actions:testrail-case-create",
      previewHash: "a".repeat(64),
      risk: "high",
      summary: "Create a TestRail case from an approved preview.",
      executable: true,
      executionStatus: "ready",
      blockReason: null,
      createdAt: "2026-09-14T08:00:00.000Z",
      expiresAt: "2026-09-14T08:15:00.000Z",
    };
    client.previewApprovedAction = vi.fn(async () => preview);
    setTklApiClientForTests(client);
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("textbox", { name: /test designer jira/i }), {
      target: { value: "STT-100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate test drafts/i }));

    await waitFor(() => expect(screen.getByText("STT-100 test design")).toBeInTheDocument());
    expect(screen.getByText("Verify valid VIN")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use this draft/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /testrail suite id/i }), {
      target: {
        value: "https://soleranorthamerica.testrail.com/index.php?/suites/view/77",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /load sections/i }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /destination testrail section/i }))
        .toHaveValue("1201"));
    fireEvent.click(screen.getByRole("button", { name: /review testrail case/i }));

    await waitFor(() => expect(client.previewApprovedAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "testrail.case.create",
        target: { sectionId: "1201", suiteId: "77" },
        changes: expect.objectContaining({
          title: "Verify valid VIN",
          refs: "STT-100",
          template_id: 2,
          custom_automation_status: 2,
        }),
        sourceVersions: [{ source: "jira", sourceId: "STT-100", sourceVersion: "7" }],
      }),
    ));
    expect(screen.getByRole("button", { name: /approve case creation/i })).toBeInTheDocument();
  });

  it("renders TestRail field-level improvement diffs and duplicate evidence", async () => {
    const improvementResult: TestRailImprovementAgentRun = {
      runId: "improvement-run-1",
      agent: {
        id: "agent.testrail-improvement",
        version: "0.1.0",
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T02:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Grounded TestRail evidence." },
      summary: "One linked TestRail case inspected; one edit proposed.",
      proposals: [{
        id: "testrail-improvement:manual-test:testrail:42",
        caseId: "manual-test:testrail:42",
        title: "Verify valid VIN",
        disposition: "propose-edit",
        requirementIds: ["requirement:STT-100"],
        findings: [{
          id: "manual-test:testrail:42:missing-preconditions",
          category: "missing-preconditions",
          severity: "medium",
          detail: "The synchronized TestRail case has no explicit preconditions.",
          evidenceIds: ["manual-test:testrail:42"],
        }],
        fieldDiffs: [{
          field: "custom_preconds",
          before: null,
          after: "[Reviewer input required: document verified prerequisites.]",
          rationale: "Make prerequisites explicit without inventing setup.",
          confidence: {
            level: "medium",
            rationale: "The current field value is directly supported.",
          },
          citations: [],
        }],
        duplicateCandidates: [{
          id: "manual-test:testrail:43",
          title: "Validate valid VIN",
          similarity: 0.8,
          citations: [],
        }],
        confidence: {
          level: "medium",
          rationale: "The synchronized field is absent.",
        },
        citations: [],
      }],
      evidence: {
        sources: ["jira", "testrail"],
        requirements: [{ id: "requirement:STT-100", title: "Valid VIN" }],
        manualTests: [{ id: "manual-test:testrail:42", title: "Verify valid VIN" }],
        relationships: [],
        citations: [{
          source: "testrail",
          sourceId: "42",
          sourceVersion: "1",
          observedAt: "2026-09-14T00:00:00.000Z",
        }],
      },
      limitations: ["Proposed values require QA review and are never written to TestRail."],
    };
    const runImprovement = vi.fn(async () => improvementResult);
    setTklApiClientForTests(fakeClient(
      () => Promise.resolve(result),
      () => Promise.reject(new Error("not used")),
      runImprovement,
    ));
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /proposal workflow/i }), {
      target: { value: "testrail-improvement" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /TestRail Improvement Jira/i }), {
      target: { value: "STT-100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /inspect TestRail cases/i }));

    await waitFor(() =>
      expect(screen.getByText("STT-100 TestRail improvements")).toBeInTheDocument());
    expect(runImprovement).toHaveBeenCalledWith("STT-100");
    expect(screen.getByText("custom_preconds")).toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    expect(screen.getByText(/Validate valid VIN \(80%\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/never written to TestRail/i)).toHaveLength(2);
  });

  it("creates automation-ready TestRail drafts with reusable case evidence", async () => {
    const automationResult: TestDesignerAgentRun = {
      runId: "automation-ready-run-1",
      agent: { id: "agent.test-designer", version: "0.1.0", mode: "proposal-only" },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T03:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "high", rationale: "Jira and TestRail evidence are available." },
      summary: "One automation-ready manual case is ready for review.",
      proposals: [{
        id: "draft-automation-1",
        disposition: "propose-new",
        title: "Verify valid VIN",
        objective: "Verify the requirement.",
        preconditions: ["An eligible title application exists."],
        steps: [{
          order: 1,
          action: "Submit a valid VIN.",
          expectedResult: "The application is accepted.",
        }],
        expectedResult: "The application is accepted.",
        requirementIds: ["requirement:STT-100"],
        duplicateCandidates: [],
        referenceCases: [{
          id: "manual-test:testrail:42",
          title: "Create a complete title and registration deal",
          similarity: 0.76,
          preconditions: "An eligible dealer and vehicle are available.",
          steps: [{
            action: "Select Create Deal.",
            expectedResult: "The Start a Deal window opens.",
          }],
        }],
        automationSuitability: {
          status: "candidate",
          rationale: "The draft has repeatable evidence-backed steps.",
          blockers: [
            "ReportPortal execution evidence requires a stable codeRef or uniqueId.",
          ],
          reusedCaseId: "manual-test:testrail:42",
        },
        confidence: { level: "high", rationale: "Explicit criterion." },
        citations: [{
          source: "jira",
          sourceId: "STT-100",
          sourceVersion: "7",
          observedAt: "2026-09-14T00:00:00.000Z",
        }],
      }],
      evidence: {
        sources: ["jira", "testrail"],
        requirements: [{ id: "requirement:STT-100", title: "Valid VIN" }],
        existingManualTests: [{ id: "manual-test:testrail:42", title: "Verify valid VIN" }],
        citations: [],
      },
      limitations: [],
    };
    const runDesigner = vi.fn(async () => automationResult);
    setTklApiClientForTests(fakeClient(
      () => Promise.resolve(result),
      runDesigner,
    ));
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /proposal workflow/i }), {
      target: { value: "automation" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /automation-ready testrail case jira/i }), {
      target: { value: "STT-100" },
    });
    fireEvent.change(screen.getByRole("textbox", {
      name: /automation-ready target testrail suite/i,
    }), {
      target: { value: "77" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load live sections/i }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", {
        name: /automation-ready target testrail section/i,
      })).toHaveValue("1201"));
    fireEvent.click(screen.getByRole("button", { name: /generate automation-ready cases/i }));

    await waitFor(() =>
      expect(screen.getByText(/STT-100 automation-ready case design/i)).toBeInTheDocument());
    expect(runDesigner).toHaveBeenCalledWith(
      "STT-100",
      { suiteId: "77", sectionId: "1201" },
    );
    expect(screen.getByText("manual-test:testrail:42")).toBeInTheDocument();
    expect(screen.getByRole("table", {
      name: /proposed steps for verify valid vin/i,
    })).toBeInTheDocument();
    expect(screen.getByText(/reference workflow · C42 · 1 source steps/i))
      .toBeInTheDocument();
    expect(screen.getByText(/ReportPortal execution evidence requires a stable codeRef/i))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use this draft/i })).toBeInTheDocument();
  });

  it("renders reliability classifications, timeline, defects, and recommendations", async () => {
    const reliabilityResult: ReliabilityDefectIntelligenceAgentRun = {
      runId: "reliability-run-1",
      agent: {
        id: "agent.reliability-defect-intelligence",
        version: "0.1.0",
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T04:00:00.000Z",
      status: "ready-for-review",
      confidence: { level: "medium", rationale: "Stable multi-run history is available." },
      summary: "One stable test identity was analyzed.",
      analyses: [{
        identity: {
          type: "codeRef",
          value: "tests/title.spec.ts#submits title",
          key: "codeRef:tests/title.spec.ts#submits title",
        },
        title: "submits title",
        classification: "likely-flaky",
        confidence: {
          level: "medium",
          rationale: "Repeated transitions occurred across independent runs.",
        },
        rationale: "Two passing and two failing independent runs were observed.",
        aggregates: {
          independentRuns: 4,
          observedAttempts: 5,
          passedRuns: 2,
          failedRuns: 2,
          otherRuns: 0,
          failureRate: 0.5,
          transitions: 3,
          retryRuns: 1,
          environmentFailureRuns: 0,
          unknownStatusCounts: {},
          durationMs: { minimum: 1000, maximum: 1400, average: 1200 },
          firstSeenAt: "2026-09-10T00:00:00.000Z",
          lastSeenAt: "2026-09-13T00:00:00.000Z",
          statusSequence: ["failed", "passed", "failed", "passed"],
          trend: {
            direction: "insufficient-history",
            delta: null,
            earlierFailureRate: null,
            recentFailureRate: null,
          },
        },
        timeline: [{
          launchId: "501",
          startedAt: "2026-09-10T00:00:00.000Z",
          endedAt: "2026-09-10T00:00:01.000Z",
          status: "FAILED",
          outcome: "failed",
          durationMs: 1000,
          attempts: [{
            executionId: "test-execution:reportportal:item:9001",
            status: "FAILED",
            retry: false,
            startedAt: "2026-09-10T00:00:00.000Z",
            durationMs: 1000,
          }],
          retryAttemptCount: 0,
          issueTypes: ["PB001"],
          environmentSignals: [],
          environmentAttributes: ["browser:chromium"],
          externalIssueKeys: ["BUG-1"],
          evidenceIds: ["test-execution:reportportal:item:9001"],
          citations: [],
        }],
        linkedJiraDefects: [{
          id: "requirement:BUG-1",
          title: "Title submission defect",
          issueType: "Bug",
          status: "Open",
          citations: [],
        }],
        recommendations: [],
        citations: [],
        limitations: [],
      }],
      recommendations: [{
        id: "stabilize:title",
        testIdentity: "tests/title.spec.ts#submits title",
        kind: "improvement",
        priority: "high",
        action: "Review nondeterministic waits and shared state.",
        rationale: "Repeated pass/fail transitions occur across independent runs.",
        citations: [],
      }],
      evidence: {
        sources: ["jira", "reportportal"],
        requirements: [{ id: "requirement:STT-100", title: "Submit title" }],
        reportPortalExecutions: [],
        jiraDefects: [{ id: "requirement:BUG-1", title: "Title submission defect" }],
        citations: [{
          source: "reportportal",
          sourceId: "9001",
          sourceVersion: "1",
          observedAt: "2026-09-14T00:00:00.000Z",
        }],
      },
      limitations: [
        "Likely-flaky is a review signal only; this agent never writes confirmed flaky.",
      ],
    };
    const runReliability = vi.fn(async () => reliabilityResult);
    setTklApiClientForTests(fakeClient(
      () => Promise.resolve(result),
      () => Promise.reject(new Error("not used")),
      () => Promise.reject(new Error("not used")),
      () => Promise.reject(new Error("not used")),
      runReliability,
    ));
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /proposal workflow/i }), {
      target: { value: "reliability" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reliability Intelligence Jira/i }), {
      target: { value: "STT-100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /analyze reliability/i }));

    await waitFor(() =>
      expect(screen.getByText("STT-100 reliability intelligence")).toBeInTheDocument());
    expect(runReliability).toHaveBeenCalledWith("STT-100");
    expect(screen.getByText("likely flaky")).toBeInTheDocument();
    expect(screen.getByText(/501:FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/BUG-1 \(Open\)/)).toBeInTheDocument();
    expect(screen.getByText(/Review nondeterministic waits/i)).toBeInTheDocument();
    expect(screen.getAllByText(/single failure or retry/i)).toHaveLength(1);
  });

  it("renders Knowledge Curator proposals with previews, evidence, and approval", async () => {
    const curatorResult: KnowledgeCuratorAgentRun = {
      runId: "curator-run-1",
      agent: {
        id: "agent.knowledge-curator",
        version: "0.1.0",
        mode: "proposal-only",
      },
      productId: "fl-titling",
      workItemId: "STT-100",
      generatedAt: "2026-09-14T05:00:00.000Z",
      scope: {
        rootRequirementId: "requirement:STT-100",
        requirementIds: ["requirement:STT-100", "requirement:STT-101"],
        productId: "fl-titling",
      },
      status: "ready-for-review",
      confidence: {
        level: "medium",
        rationale: "Direct provenance is available; mapping remains inferred.",
      },
      summary: "One reviewable curation finding was identified.",
      findings: [{
        id: "curation:missing-link",
        category: "missing-trace-link",
        severity: "medium",
        title: "Review a possible verifies mapping",
        detail: "A synchronized TestRail case has matching intent but no trace link.",
        entityIds: ["manual-test:testrail:43", "requirement:STT-101"],
        claimIds: [],
        evidenceIds: ["manual-test:testrail:43", "requirement:STT-101"],
        confidence: { level: "low", rationale: "Text similarity requires review." },
        citations: [],
        preview: {
          before: { matchingTraceLink: null },
          action: "review-trace-mapping",
          after: {
            proposedLink: {
              fromEntityId: "manual-test:testrail:43",
              toEntityId: "requirement:STT-101",
              type: "verifies",
            },
          },
        },
        disposition: "propose-review",
        limitations: ["No trace link is created."],
      }],
      proposals: [{
        id: "proposal:curation:missing-link",
        findingId: "curation:missing-link",
        kind: "trace-mapping",
        disposition: "propose-review",
        title: "Review a possible verifies mapping",
        rationale: "A synchronized TestRail case has matching intent but no trace link.",
        confidence: { level: "low", rationale: "Text similarity requires review." },
        evidenceIds: ["manual-test:testrail:43", "requirement:STT-101"],
        citations: [],
        preview: {
          before: { matchingTraceLink: null },
          action: "review-trace-mapping",
          after: {
            proposedLink: {
              fromEntityId: "manual-test:testrail:43",
              toEntityId: "requirement:STT-101",
              type: "verifies",
            },
          },
        },
        limitations: ["No trace link is created."],
        approval: { required: true, role: "knowledge-reviewer" },
      }],
      evidence: {
        sources: ["jira", "testrail"],
        requirements: [{ id: "requirement:STT-101", title: "Submit title" }],
        entities: [],
        claims: [],
        traceLinks: [],
        openConflicts: [],
        unresolvedTraceLinks: [],
        citations: [{
          source: "testrail",
          sourceId: "43",
          sourceVersion: "1",
          observedAt: "2026-09-01T00:00:00.000Z",
        }],
      },
      limitations: ["This agent cannot mutate canonical knowledge."],
      approval: {
        required: true,
        role: "knowledge-reviewer",
        statement: "A human reviewer must approve every proposed action.",
      },
    };
    const runCurator = vi.fn(async () => curatorResult);
    setTklApiClientForTests(fakeClient(
      () => Promise.resolve(result),
      () => Promise.reject(new Error("not used")),
      () => Promise.reject(new Error("not used")),
      () => Promise.reject(new Error("not used")),
      () => Promise.reject(new Error("not used")),
      runCurator,
    ));
    render(<AgentWorkbenchPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /proposal workflow/i }), {
      target: { value: "curation" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Knowledge Curator Jira/i }), {
      target: { value: "STT-100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /propose curation reviews/i }));

    await waitFor(() =>
      expect(screen.getByText("STT-100 knowledge curation")).toBeInTheDocument());
    expect(runCurator).toHaveBeenCalledWith("STT-100");
    expect(screen.getByText("trace mapping")).toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After / action preview")).toBeInTheDocument();
    expect(screen.getAllByText(/manual-test:testrail:43/).length).toBeGreaterThan(0);
    expect(screen.getByText(/reviewer role/i)).toHaveTextContent("knowledge-reviewer");
    expect(screen.getAllByText(/never resolves conflicts/i)).toHaveLength(1);
  });
});
