import { type FormEvent, useState } from "react";
import { getTklApiClient } from "../api/client";
import type {
  ApprovedActionApproval,
  ApprovedActionExecution,
  ApprovedActionPreview,
  ApprovedActionType,
  AutomationDesignerAgentRun,
  CoverageContextAgentRun,
  KnowledgeCuratorAgentRun,
  ReliabilityDefectIntelligenceAgentRun,
  TestDesignerAgentRun,
  TestRailSection,
  TestRailImprovementAgentRun,
} from "../contracts/types";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { TicketContextStatus } from "../components/TicketContextStatus";
import { hashSearchParam } from "../routing/hashSearchParams";

type Proposal = TestDesignerAgentRun["proposals"][number];
type ProposalWorkflow =
  | "manual-tests"
  | "coverage"
  | "testrail-improvement"
  | "automation"
  | "reliability"
  | "curation";

function parseTestRailId(value: string, kind: "suite" | "section") {
  const normalized = value.trim();
  if (/^[1-9]\d*$/.test(normalized)) return normalized;

  const match = kind === "suite"
    ? normalized.match(/\/suites\/view\/([1-9]\d*)/i)
    : normalized.match(/(?:[?&](?:group_id|section_id)=|\/sections\/(?:view|edit)\/)([1-9]\d*)/i);
  return match?.[1] ?? null;
}

export function AgentWorkbenchPage() {
  const [workflow, setWorkflow] = useState<ProposalWorkflow>("manual-tests");
  const [workItemId, setWorkItemId] = useState(
    hashSearchParam("workItemId") || "STT-3731",
  );
  const [contextIssueKey, setContextIssueKey] = useState(workItemId);
  const [result, setResult] = useState<CoverageContextAgentRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [designerResult, setDesignerResult] = useState<TestDesignerAgentRun | null>(null);
  const [designerLoading, setDesignerLoading] = useState(false);
  const [designerError, setDesignerError] = useState<Error | null>(null);
  const [improvementResult, setImprovementResult] =
    useState<TestRailImprovementAgentRun | null>(null);
  const [improvementLoading, setImprovementLoading] = useState(false);
  const [improvementError, setImprovementError] = useState<Error | null>(null);
  const [automationResult, setAutomationResult] =
    useState<TestDesignerAgentRun | null>(null);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationError, setAutomationError] = useState<Error | null>(null);
  const [reliabilityResult, setReliabilityResult] =
    useState<ReliabilityDefectIntelligenceAgentRun | null>(null);
  const [reliabilityLoading, setReliabilityLoading] = useState(false);
  const [reliabilityError, setReliabilityError] = useState<Error | null>(null);
  const [curatorResult, setCuratorResult] = useState<KnowledgeCuratorAgentRun | null>(null);
  const [curatorLoading, setCuratorLoading] = useState(false);
  const [curatorError, setCuratorError] = useState<Error | null>(null);
  const [actionType] = useState<ApprovedActionType>("testrail.case.create");
  const [suiteTarget, setSuiteTarget] = useState("");
  const [loadedSuiteId, setLoadedSuiteId] = useState<string | null>(null);
  const [testRailSections, setTestRailSections] = useState<TestRailSection[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionsError, setSectionsError] = useState<Error | null>(null);
  const [sectionDestination, setSectionDestination] = useState("");
  const [newSectionName, setNewSectionName] = useState("");
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [actionPreview, setActionPreview] = useState<ApprovedActionPreview | null>(null);
  const [actionApproval, setActionApproval] = useState<ApprovedActionApproval | null>(null);
  const [actionExecution, setActionExecution] = useState<ApprovedActionExecution | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);

  const runAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContextIssueKey(workItemId.trim());
    setLoading(true);
    setError(null);
    try {
      setResult(await getTklApiClient().runCoverageContextAgent(workItemId.trim()));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught : new Error("Agent execution failed."));
    } finally {
      setLoading(false);
    }
  };

  const runDesigner = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContextIssueKey(workItemId.trim());
    setDesignerLoading(true);
    setDesignerError(null);
    try {
      setDesignerResult(await getTklApiClient().runTestDesignerAgent(workItemId.trim()));
    } catch (caught) {
      setDesignerResult(null);
      setDesignerError(caught instanceof Error ? caught : new Error("Test Designer failed."));
    } finally {
      setDesignerLoading(false);
    }
  };

  const runImprovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContextIssueKey(workItemId.trim());
    setImprovementLoading(true);
    setImprovementError(null);
    try {
      setImprovementResult(
        await getTklApiClient().runTestRailImprovementAgent(workItemId.trim()),
      );
    } catch (caught) {
      setImprovementResult(null);
      setImprovementError(
        caught instanceof Error ? caught : new Error("TestRail Improvement failed."),
      );
    } finally {
      setImprovementLoading(false);
    }
  };

  const runAutomationDesigner = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const suiteId = parseTestRailId(suiteTarget, "suite");
    if (
      !suiteId
      || suiteId !== loadedSuiteId
      || !sectionDestination
      || sectionDestination === "new"
    ) {
      setAutomationError(
        new Error(
          "Load the target TestRail suite and select an existing section before designing cases.",
        ),
      );
      return;
    }
    setContextIssueKey(workItemId.trim());
    setAutomationLoading(true);
    setAutomationError(null);
    try {
      setAutomationResult(
        await getTklApiClient().runTestDesignerAgent(workItemId.trim(), {
          suiteId,
          sectionId: sectionDestination,
        }),
      );
    } catch (caught) {
      setAutomationResult(null);
      setAutomationError(
        caught instanceof Error ? caught : new Error("Automation-ready case design failed."),
      );
    } finally {
      setAutomationLoading(false);
    }
  };

  const loadTestRailSections = async () => {
    const suiteId = parseTestRailId(suiteTarget, "suite");
    if (!suiteId) {
      setSectionsError(new Error("Enter a numeric TestRail suite ID or paste the suite URL."));
      return;
    }
    setSectionsLoading(true);
    setSectionsError(null);
    setActionPreview(null);
    setActionApproval(null);
    setActionExecution(null);
    try {
      const client = getTklApiClient();
      if (!client.discoverTestRailSections) {
        throw new Error("TestRail section discovery is unavailable.");
      }
      const sections = await client.discoverTestRailSections(suiteId);
      setTestRailSections(sections);
      setLoadedSuiteId(suiteId);
      setSectionDestination(sections[0]?.id ?? "new");
    } catch (caught) {
      setTestRailSections([]);
      setLoadedSuiteId(null);
      setSectionDestination("");
      setSectionsError(
        caught instanceof Error ? caught : new Error("TestRail sections could not be loaded."),
      );
    } finally {
      setSectionsLoading(false);
    }
  };

  const runReliabilityIntelligence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContextIssueKey(workItemId.trim());
    setReliabilityLoading(true);
    setReliabilityError(null);
    try {
      setReliabilityResult(
        await getTklApiClient().runReliabilityDefectIntelligenceAgent(workItemId.trim()),
      );
    } catch (caught) {
      setReliabilityResult(null);
      setReliabilityError(
        caught instanceof Error ? caught : new Error("Reliability Intelligence failed."),
      );
    } finally {
      setReliabilityLoading(false);
    }
  };

  const runKnowledgeCurator = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContextIssueKey(workItemId.trim());
    setCuratorLoading(true);
    setCuratorError(null);
    try {
      setCuratorResult(
        await getTklApiClient().runKnowledgeCuratorAgent(workItemId.trim()),
      );
    } catch (caught) {
      setCuratorResult(null);
      setCuratorError(
        caught instanceof Error ? caught : new Error("Knowledge Curator failed."),
      );
    } finally {
      setCuratorLoading(false);
    }
  };

  const previewAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProposal) {
      setActionError(new Error("Select one generated test draft before preparing the TestRail case."));
      return;
    }
    const suiteId = parseTestRailId(suiteTarget, "suite");
    if (!suiteId || suiteId !== loadedSuiteId) {
      setActionError(new Error("Load the destination suite sections before preparing the case."));
      return;
    }
    if (!sectionDestination) {
      setActionError(new Error("Choose a TestRail section or create a new section."));
      return;
    }
    if (sectionDestination === "new" && !newSectionName.trim()) {
      setActionError(new Error("Enter the name of the new TestRail section."));
      return;
    }
    setActionLoading(true);
    setActionError(null);
    setActionApproval(null);
    setActionExecution(null);
    try {
      const client = getTklApiClient();
      if (!client.previewApprovedAction) {
        throw new Error("Approved action previews are unavailable.");
      }
      const citation = selectedProposal.citations.find((item) => item.source === "jira")
        ?? selectedProposal.citations[0];
      if (!citation) {
        throw new Error("The selected draft has no source version to bind to the approval.");
      }
      setActionPreview(await client.previewApprovedAction({
        actionType,
        target: sectionDestination === "new"
          ? { suiteId, newSectionName: newSectionName.trim() }
          : { sectionId: sectionDestination, suiteId },
        changes: {
          title: selectedProposal.title,
          refs: workItemId.trim().toUpperCase(),
          template_id: 2,
          custom_automation_status: 2,
          custom_preconds: selectedProposal.preconditions.join("\n"),
          custom_steps_separated: selectedProposal.steps.map((step) => ({
            content: step.action,
            expected: step.expectedResult,
          })),
        },
        sourceVersions: [{
          source: "jira",
          sourceId: citation.sourceId,
          sourceVersion: citation.sourceVersion,
        }],
        idempotencyKey: requestId("preview"),
      }));
    } catch (caught) {
      setActionPreview(null);
      setActionError(caught instanceof Error ? caught : new Error("Action preview failed."));
    } finally {
      setActionLoading(false);
    }
  };

  const approveAction = async () => {
    if (!actionPreview) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const client = getTklApiClient();
      if (!client.approveAction) throw new Error("Action approval is unavailable.");
      setActionApproval(await client.approveAction(actionPreview));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught : new Error("Action approval failed."));
    } finally {
      setActionLoading(false);
    }
  };

  const executeAction = async () => {
    if (!actionPreview || !actionApproval) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const client = getTklApiClient();
      if (!client.executeApprovedAction) throw new Error("Action execution is unavailable.");
      setActionExecution(await client.executeApprovedAction(actionPreview, actionApproval));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught : new Error("Action execution failed."));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Human review"
        title="Agent Proposals"
        description="Choose one outcome, generate a grounded proposal, review it, and publish only the approved result."
        icon="sparkles"
        summary="Proposal first · Human approval required"
      />

      <div className="review-workflow" aria-label="Proposal review workflow">
        <div><strong>1. Generate</strong><span>Enter one Jira ticket.</span></div>
        <div><strong>2. Review</strong><span>Select the proposal you want.</span></div>
        <div><strong>3. Publish</strong><span>Approve and create it in TestRail.</span></div>
      </div>

      <div className="agent-workbench">
          <article className="card">
            <div className="workflow-picker">
              <label htmlFor="proposal-workflow">What do you want to do?</label>
              <div className="workflow-picker__control">
              <select
                aria-label="Proposal workflow"
                id="proposal-workflow"
                value={workflow}
                onChange={(event) => {
                  setWorkflow(event.target.value as ProposalWorkflow);
                  setSelectedProposal(null);
                  setActionPreview(null);
                  setActionApproval(null);
                  setActionExecution(null);
                  setActionError(null);
                }}
              >
                <option value="manual-tests">Create manual test cases in TestRail</option>
                <option value="coverage">Analyze coverage and impact</option>
                <option value="testrail-improvement">Improve existing TestRail cases</option>
                <option value="automation">Create automation-ready TestRail cases</option>
                <option value="reliability">Analyze failures and reliability</option>
                <option value="curation">Review knowledge conflicts</option>
              </select>
              </div>
            </div>
            <p className="page__hint">
              Only the selected workflow is shown. Change this option when you need a different agent.
            </p>
          </article>

          <TicketContextStatus issueKey={contextIssueKey} />

          {workflow === "coverage" && (
          <>
          <article className="card">
            <div className="traceability-card__heading">
              <div>
                <h3>Coverage & Context Analyst</h3>
                <p className="page__hint">
                  Read-only analysis of Jira hierarchy, linked tests, executions,
                  coverage gaps, source evidence, and missing context.
                </p>
              </div>
              <span className="badge badge--pending">Complete</span>
            </div>
            <form className="intelligence-search" onSubmit={runAgent}>
              <label>
                Jira ticket or epic
                <input
                  aria-label="Jira ticket or epic"
                  onChange={(event) => setWorkItemId(event.target.value)}
                  placeholder="STT-3731"
                  required
                  value={workItemId}
                />
              </label>
              <button className="button button--primary" disabled={loading} type="submit">
                <Icon name="sparkles" size={17} />
                {loading ? "Analyzing…" : "Run analyst"}
              </button>
              <span>
                The agent does not invent product facts or modify Jira, TestRail, or GitHub.
              </span>
            </form>
            {error && <p role="alert">Agent execution failed: {error.message}</p>}
          </article>

          {result && <AgentResult result={result} />}
          </>
          )}

          {workflow === "manual-tests" && (
          <>
          <article className="card">
            <div className="traceability-card__heading">
              <div>
                <h3>Test Designer</h3>
                <p className="page__hint">
                  Creates reviewable manual test drafts from explicit Jira evidence and
                  checks synchronized TestRail titles for likely duplicates.
                </p>
              </div>
              <span className="badge badge--ok">Proposal only</span>
            </div>
            <form className="intelligence-search" onSubmit={runDesigner}>
              <label>
                Jira ticket or epic
                <input
                  aria-label="Test Designer Jira ticket or epic"
                  onChange={(event) => setWorkItemId(event.target.value)}
                  placeholder="STT-123"
                  required
                  value={workItemId}
                />
              </label>
              <button className="button button--primary" disabled={designerLoading} type="submit">
                <Icon name="sparkles" size={17} />
                {designerLoading ? "Designing…" : "Generate test drafts"}
              </button>
              <span>
                Drafts require QA review and are never published to TestRail automatically.
              </span>
            </form>
            {designerError && <p role="alert">Test Designer failed: {designerError.message}</p>}
          </article>

          {designerResult && (
            <TestDesignerResult
              result={designerResult}
              selectedProposalId={selectedProposal?.id ?? null}
              onSelect={(proposal) => {
                setSelectedProposal(proposal);
                setActionPreview(null);
                setActionApproval(null);
                setActionExecution(null);
                setActionError(null);
                window.setTimeout(() => {
                  const publishSection = document.getElementById("publish-testrail-case");
                  if (typeof publishSection?.scrollIntoView === "function") {
                    publishSection.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                }, 0);
              }}
            />
          )}
          </>
          )}

          {workflow === "testrail-improvement" && (
          <>
          <article className="card">
            <div className="traceability-card__heading">
              <div>
                <h3>TestRail Improvement</h3>
                <p className="page__hint">
                  Inspects existing cases linked to an exact Jira scope and proposes
                  cited, field-level edits for missing case detail or duplicate intent.
                </p>
              </div>
              <span className="badge badge--ok">Proposal only</span>
            </div>
            <form className="intelligence-search" onSubmit={runImprovement}>
              <label>
                Exact Jira ticket or epic
                <input
                  aria-label="TestRail Improvement Jira ticket or epic"
                  onChange={(event) => setWorkItemId(event.target.value)}
                  placeholder="STT-123"
                  required
                  value={workItemId}
                />
              </label>
              <button
                className="button button--primary"
                disabled={improvementLoading}
                type="submit"
              >
                <Icon name="sparkles" size={17} />
                {improvementLoading ? "Inspecting…" : "Inspect TestRail cases"}
              </button>
              <span>
                Proposed edits require QA review and are never written to TestRail.
              </span>
            </form>
            {improvementError && (
              <p role="alert">TestRail Improvement failed: {improvementError.message}</p>
            )}
          </article>

          {improvementResult && <TestRailImprovementResult result={improvementResult} />}
          </>
          )}

          {workflow === "automation" && (
          <>
          <article className="card">
            <div className="traceability-card__heading">
              <div>
                <h3>Automation-ready TestRail Case Designer</h3>
                <p className="page__hint">
                  Creates reviewable TestRail cases designed as automation candidates,
                  reusing grounded steps and expected results from similar cases when available.
                </p>
              </div>
              <span className="badge badge--ok">Proposal only</span>
            </div>
            <form className="intelligence-search" onSubmit={runAutomationDesigner}>
              <label>
                Exact Jira ticket or epic
                <input
                  aria-label="Automation-ready TestRail case Jira ticket or epic"
                  onChange={(event) => setWorkItemId(event.target.value)}
                  placeholder="STT-123"
                  required
                  value={workItemId}
                />
              </label>
              <label>
                Target TestRail suite
                <input
                  aria-label="Automation-ready target TestRail suite"
                  onChange={(event) => {
                    setSuiteTarget(event.target.value);
                    setLoadedSuiteId(null);
                    setTestRailSections([]);
                    setSectionDestination("");
                    setAutomationResult(null);
                    setSelectedProposal(null);
                  }}
                  placeholder="128951 or paste the suite URL"
                  required
                  value={suiteTarget}
                />
              </label>
              <button
                className="button button--secondary"
                disabled={sectionsLoading}
                onClick={loadTestRailSections}
                type="button"
              >
                {sectionsLoading ? "Loading sections…" : "Load live sections"}
              </button>
              {loadedSuiteId && (
                <label>
                  Search similar cases in section
                  <select
                    aria-label="Automation-ready target TestRail section"
                    onChange={(event) => {
                      setSectionDestination(event.target.value);
                      setAutomationResult(null);
                      setSelectedProposal(null);
                    }}
                    required
                    value={sectionDestination}
                  >
                    {testRailSections.map((section) => (
                      <option key={section.id} value={section.id}>
                        {`${"— ".repeat(section.depth)}${section.name} (S${section.id})`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {sectionsError && <p role="alert">{sectionsError.message}</p>}
              <button
                className="button button--primary"
                disabled={
                  automationLoading
                  || !loadedSuiteId
                  || !sectionDestination
                  || sectionDestination === "new"
                }
                type="submit"
              >
                <Icon name="sparkles" size={17} />
                {automationLoading ? "Designing…" : "Generate automation-ready cases"}
              </button>
              <span>
                The result is still a manual TestRail case; automation suitability and missing
                execution identity are shown for human review.
              </span>
            </form>
            {automationError && (
              <p role="alert">Automation-ready case design failed: {automationError.message}</p>
            )}
          </article>

          {automationResult && (
            <TestDesignerResult
              mode="automation-ready"
              result={automationResult}
              selectedProposalId={selectedProposal?.id ?? null}
              onSelect={(proposal) => {
                setSelectedProposal(proposal);
                setActionPreview(null);
                setActionApproval(null);
                setActionExecution(null);
                setActionError(null);
                window.setTimeout(() => {
                  document.getElementById("publish-testrail-case")?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }, 0);
              }}
            />
          )}
          </>
          )}

          {workflow === "reliability" && (
          <>
          <article className="card">
            <div className="traceability-card__heading">
              <div>
                <h3>Reliability &amp; Defect Intelligence</h3>
                <p className="page__hint">
                  Classifies bounded multi-run ReportPortal history by stable test identity,
                  correlates synchronized Jira defects, and proposes review-only improvements.
                </p>
              </div>
              <span className="badge badge--ok">Read/proposal only</span>
            </div>
            <form className="intelligence-search" onSubmit={runReliabilityIntelligence}>
              <label>
                Exact Jira ticket or epic
                <input
                  aria-label="Reliability Intelligence Jira ticket or epic"
                  onChange={(event) => setWorkItemId(event.target.value)}
                  placeholder="STT-123"
                  required
                  value={workItemId}
                />
              </label>
              <button
                className="button button--primary"
                disabled={reliabilityLoading}
                type="submit"
              >
                <Icon name="sparkles" size={17} />
                {reliabilityLoading ? "Analyzing history…" : "Analyze reliability"}
              </button>
              <span>
                A single failure or retry is never classified as flaky, and no source is modified.
              </span>
            </form>
            {reliabilityError && (
              <p role="alert">Reliability Intelligence failed: {reliabilityError.message}</p>
            )}
          </article>

          {reliabilityResult && <ReliabilityIntelligenceResult result={reliabilityResult} />}
          </>
          )}

          {workflow === "curation" && (
          <>
          <article className="card">
            <div className="traceability-card__heading">
              <div>
                <h3>Knowledge Curator</h3>
                <p className="page__hint">
                  Inspects the exact Jira hierarchy for conflicts, duplicate knowledge,
                  missing mappings, and stale claims, then produces review-only previews.
                </p>
              </div>
              <span className="badge badge--ok">Proposal only</span>
            </div>
            <form className="intelligence-search" onSubmit={runKnowledgeCurator}>
              <label>
                Exact Jira ticket or epic
                <input
                  aria-label="Knowledge Curator Jira ticket or epic"
                  onChange={(event) => setWorkItemId(event.target.value)}
                  placeholder="STT-123"
                  required
                  value={workItemId}
                />
              </label>
              <button
                className="button button--primary"
                disabled={curatorLoading}
                type="submit"
              >
                <Icon name="sparkles" size={17} />
                {curatorLoading ? "Inspecting knowledge…" : "Propose curation reviews"}
              </button>
              <span>
                The agent never resolves conflicts, merges entities, or changes canonical knowledge.
              </span>
            </form>
            {curatorError && (
              <p role="alert">Knowledge Curator failed: {curatorError.message}</p>
            )}
          </article>

          {curatorResult && <KnowledgeCuratorResult result={curatorResult} />}
          </>
          )}

          {(workflow === "manual-tests" || workflow === "automation") && (
          <>
          <article className="card" id="publish-testrail-case">
            <div className="traceability-card__heading">
              <div>
                <h3>Publish selected case to TestRail</h3>
                <p className="page__hint">
                  Enter the exact suite, load its live sections, select the destination
                  or create a new section, then approve the final case.
                </p>
              </div>
              <span className={`badge ${selectedProposal ? "badge--pending" : "badge--muted"}`}>
                {selectedProposal ? "Draft selected" : "Waiting for draft"}
              </span>
            </div>
            <div className="destination-builder">
              <label>
                TestRail suite ID or URL
                <input
                  aria-label="TestRail suite ID or URL"
                  onChange={(event) => {
                    setSuiteTarget(event.target.value);
                    setLoadedSuiteId(null);
                    setTestRailSections([]);
                    setSectionDestination("");
                    setActionPreview(null);
                    setActionApproval(null);
                    setActionExecution(null);
                  }}
                  placeholder="Example: 128951 or paste the suite URL"
                  value={suiteTarget}
                />
                <span className="page__hint">
                  Regression suite - FL uses suite ID 128951.
                </span>
              </label>
              <button
                className="button button--secondary"
                disabled={sectionsLoading}
                onClick={loadTestRailSections}
                type="button"
              >
                {sectionsLoading ? "Loading sections…" : "Load sections"}
              </button>
              {sectionsError && <p role="alert">{sectionsError.message}</p>}
              {loadedSuiteId && (
                <form className="destination-builder__selection" onSubmit={previewAction}>
                  <label>
                    Destination section
                    <select
                      aria-label="Destination TestRail section"
                      onChange={(event) => {
                        setSectionDestination(event.target.value);
                        setActionPreview(null);
                        setActionApproval(null);
                        setActionExecution(null);
                      }}
                      value={sectionDestination}
                    >
                      {testRailSections.map((section) => (
                        <option key={section.id} value={section.id}>
                          {`${"— ".repeat(section.depth)}${section.name} (S${section.id})`}
                        </option>
                      ))}
                      <option value="new">Create a new section</option>
                    </select>
                  </label>
                  {sectionDestination === "new" && (
                    <label>
                      New section name
                      <input
                        aria-label="New TestRail section name"
                        maxLength={250}
                        onChange={(event) => {
                          setNewSectionName(event.target.value);
                          setActionPreview(null);
                          setActionApproval(null);
                          setActionExecution(null);
                        }}
                        placeholder="Example: Vehicle owner validation"
                        required
                        value={newSectionName}
                      />
                    </label>
                  )}
                  <button
                    className="button button--primary"
                    disabled={actionLoading || !selectedProposal}
                    type="submit"
                  >
                    <Icon name="sparkles" size={17} />
                    {actionLoading ? "Preparing…" : "Review TestRail case"}
                  </button>
                </form>
              )}
            </div>
            {actionError && <p role="alert">Approved action failed: {actionError.message}</p>}
          </article>

          {actionPreview && (
            <article className="card agent-result" aria-label="Approved action preview">
              <div className="traceability-card__heading">
                <div>
                  <span className="page-heading__eyebrow">Immutable preview</span>
                  <h3>{actionPreview.actionType.replaceAll(".", " ")}</h3>
                </div>
                <span className={`badge ${
                  actionPreview.executable ? "badge--ok" : "badge--warn"
                }`}>
                  {actionPreview.executionStatus}
                </span>
              </div>
              <p>{actionPreview.summary}</p>
              <p><strong>Title:</strong> {String(actionPreview.changes.title)}</p>
              <p><strong>Jira reference:</strong> {String(actionPreview.changes.refs)}</p>
              <p>
                <strong>Destination:</strong>{" "}
                {actionPreview.target.newSectionName
                  ? `New section "${String(actionPreview.target.newSectionName)}" in suite S${String(actionPreview.target.suiteId)}`
                  : `Section S${String(actionPreview.target.sectionId)}`}
              </p>
              <details>
                <summary>Review preconditions and steps</summary>
                <pre>{JSON.stringify({
                  preconditions: actionPreview.changes.custom_preconds,
                  steps: actionPreview.changes.custom_steps_separated,
                }, null, 2)}</pre>
              </details>
              {actionPreview.blockReason && (
                <p role="status">
                  <strong>Blocked:</strong> {actionPreview.blockReason.message}
                  {" "}No external system will be called.
                </p>
              )}
              {actionPreview.executable && !actionApproval && (
                <button
                  className="button button--primary"
                  disabled={actionLoading}
                  onClick={approveAction}
                  type="button"
                >
                  Approve case creation
                </button>
              )}
              {actionApproval && !actionExecution && (
                <button
                  className="button button--primary"
                  disabled={actionLoading}
                  onClick={executeAction}
                  type="button"
                >
                  {actionLoading ? "Creating…" : "Create case in TestRail"}
                </button>
              )}
              {actionExecution && (
                <p role="status">
                  {actionExecution.status === "succeeded" && actionExecution.result ? (
                    <>
                      Case C{actionExecution.result.externalId} created successfully.{" "}
                      <a href={actionExecution.result.url} rel="noreferrer" target="_blank">
                        Open in TestRail
                      </a>
                    </>
                  ) : (
                    <>Creation {actionExecution.status}: {actionExecution.reason?.message}</>
                  )}
                </p>
              )}
            </article>
          )}
          </>
          )}
        </div>
    </section>
  );
}

function requestId(prefix: string) {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
}

function KnowledgeCuratorResult({ result }: { result: KnowledgeCuratorAgentRun }) {
  return (
    <article className="card agent-result">
      <div className="traceability-card__heading">
        <div>
          <span className="page-heading__eyebrow">Run {result.runId}</span>
          <h3>{result.workItemId} knowledge curation</h3>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${result.status === "ready-for-review" ? "badge--ok" : "badge--warn"}`}>
            {result.status.replaceAll("-", " ")}
          </span>
          <span className="badge badge--pending">{result.confidence.level} confidence</span>
        </div>
      </div>
      <p>{result.summary}</p>
      <p className="page__hint">{result.confidence.rationale}</p>
      <p>
        <strong>Exact scope:</strong> {result.scope.requirementIds.join(", ") || "not found"}
      </p>

      <h3>Curation findings and action previews</h3>
      {result.proposals.length === 0 ? (
        <p className="page__empty">No conservative curation proposal threshold was met.</p>
      ) : (
        <div className="agent-result__list">
          {result.proposals.map((proposal) => (
            <div key={proposal.id}>
              <div className="traceability-card__badges">
                <span className={`badge ${
                  proposal.disposition === "abstain" ? "badge--warn" : "badge--pending"
                }`}>
                  {proposal.kind.replaceAll("-", " ")}
                </span>
                <span className="badge badge--pending">
                  {proposal.confidence.level} confidence
                </span>
              </div>
              <strong>{proposal.title}</strong>
              <p>{proposal.rationale}</p>
              <p>
                <strong>Action:</strong> {proposal.preview.action.replaceAll("-", " ")}
                {" · "}
                <strong>Disposition:</strong> {proposal.disposition.replaceAll("-", " ")}
              </p>
              <div className="agent-result__diff">
                <div>
                  <strong>Before</strong>
                  <pre>{JSON.stringify(proposal.preview.before, null, 2)}</pre>
                </div>
                <div>
                  <strong>After / action preview</strong>
                  <pre>{JSON.stringify(proposal.preview.after, null, 2)}</pre>
                </div>
              </div>
              <p className="page__hint">
                Evidence IDs: {proposal.evidenceIds.join(", ")}
              </p>
              {proposal.limitations.length > 0 && (
                <ul className="agent-result__limitations">
                  {proposal.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <h3>Human approval</h3>
      <p>
        <strong>Required:</strong> {result.approval.required ? "Yes" : "No"}
        {" · "}
        reviewer role <code>{result.approval.role}</code>
      </p>
      <p className="page__hint">{result.approval.statement}</p>

      <details className="agent-result__evidence">
        <summary>Evidence and citations</summary>
        <ul>
          {result.evidence.citations.map((citation) => (
            <li key={`${citation.source}:${citation.sourceId}:${citation.sourceVersion}`}>
              <strong>{citation.source}</strong> · {citation.sourceId} · version{" "}
              {citation.sourceVersion} · observed {citation.observedAt}
            </li>
          ))}
        </ul>
      </details>
      {result.limitations.length > 0 && (
        <>
          <h3>Known limitations</h3>
          <ul className="agent-result__limitations">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}
    </article>
  );
}

function ReliabilityIntelligenceResult({
  result,
}: {
  result: ReliabilityDefectIntelligenceAgentRun;
}) {
  return (
    <article className="card agent-result">
      <div className="traceability-card__heading">
        <div>
          <span className="page-heading__eyebrow">Run {result.runId}</span>
          <h3>{result.workItemId} reliability intelligence</h3>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${result.status === "ready-for-review" ? "badge--ok" : "badge--warn"}`}>
            {result.status.replaceAll("-", " ")}
          </span>
          <span className="badge badge--pending">{result.confidence.level} confidence</span>
        </div>
      </div>
      <p>{result.summary}</p>
      <p className="page__hint">{result.confidence.rationale}</p>

      <h3>Reliability classifications</h3>
      {result.analyses.length === 0 ? (
        <p className="page__empty">No scoped multi-run execution history is available.</p>
      ) : (
        <div className="agent-result__list">
          {result.analyses.map((analysis) => (
            <div key={analysis.identity.key}>
              <div className="traceability-card__badges">
                <span className={`badge ${
                  analysis.classification === "healthy" ? "badge--ok" : "badge--warn"
                }`}>
                  {analysis.classification.replaceAll("-", " ")}
                </span>
                <span className="badge badge--pending">
                  {analysis.confidence.level} confidence
                </span>
              </div>
              <strong>{analysis.title}</strong>
              <p><code>{analysis.identity.value}</code> ({analysis.identity.type})</p>
              <p>{analysis.rationale}</p>
              <div className="agent-result__stats">
                <Metric label="Independent runs" value={analysis.aggregates.independentRuns} />
                <Metric label="Passed" value={analysis.aggregates.passedRuns} />
                <Metric label="Failed" value={analysis.aggregates.failedRuns} />
                <Metric label="Retries" value={analysis.aggregates.retryRuns} />
              </div>
              <p>
                <strong>Timeline:</strong>{" "}
                {analysis.timeline.map((run) =>
                  `${run.launchId}:${run.status}${run.retryAttemptCount ? ` (+${run.retryAttemptCount} retry)` : ""}`)
                  .join(" → ")}
              </p>
              <p>
                <strong>Trend:</strong> {analysis.aggregates.trend.direction.replaceAll("-", " ")}
                {" · "}
                failure rate{" "}
                {analysis.aggregates.failureRate === null
                  ? "unknown"
                  : `${Math.round(analysis.aggregates.failureRate * 100)}%`}
              </p>
              {analysis.linkedJiraDefects.length > 0 && (
                <p>
                  <strong>Linked Jira defects:</strong>{" "}
                  {analysis.linkedJiraDefects.map((defect) =>
                    `${defect.id.replace("requirement:", "")} (${defect.status ?? "status unknown"})`)
                    .join(", ")}
                </p>
              )}
              {analysis.limitations.length > 0 && (
                <ul className="agent-result__limitations">
                  {analysis.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <h3>Improvement and regression recommendations</h3>
      {result.recommendations.length === 0 ? (
        <p className="page__empty">No recommendation is supported yet.</p>
      ) : (
        <div className="agent-result__list">
          {result.recommendations.map((recommendation) => (
            <div key={recommendation.id}>
              <span className="badge badge--pending">
                {recommendation.kind.replaceAll("-", " ")} · {recommendation.priority}
              </span>
              <strong>{recommendation.action}</strong>
              <p>{recommendation.rationale}</p>
            </div>
          ))}
        </div>
      )}

      <details className="agent-result__evidence">
        <summary>Evidence and citations</summary>
        <ul>
          {result.evidence.citations.map((citation) => (
            <li key={`${citation.source}:${citation.sourceId}:${citation.sourceVersion}`}>
              <strong>{citation.source}</strong> · {citation.sourceId} · version{" "}
              {citation.sourceVersion} · observed {citation.observedAt}
            </li>
          ))}
        </ul>
      </details>
      {result.limitations.length > 0 && (
        <>
          <h3>Known limitations</h3>
          <ul className="agent-result__limitations">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}
    </article>
  );
}

export function AutomationDesignerResult({ result }: { result: AutomationDesignerAgentRun }) {
  return (
    <article className="card agent-result">
      <div className="traceability-card__heading">
        <div>
          <span className="page-heading__eyebrow">Run {result.runId}</span>
          <h3>{result.workItemId} automation proposal</h3>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${result.status === "ready-for-review" ? "badge--ok" : "badge--warn"}`}>
            {result.status.replaceAll("-", " ")}
          </span>
          <span className="badge badge--pending">{result.confidence.level} confidence</span>
        </div>
      </div>
      <p>{result.summary}</p>
      <p className="page__hint">{result.confidence.rationale}</p>
      <p>
        <strong>Code generation:</strong> {result.proposal.codeGeneration.status}
        {" — "}
        {result.proposal.codeGeneration.rationale}
      </p>

      <h3>Where the automated test will live</h3>
      {result.proposal.filePlan.length === 0 ? (
        <p className="page__empty">No grounded target file can be proposed yet.</p>
      ) : (
        <div className="agent-result__list">
          {result.proposal.filePlan.map((item) => (
            <div key={item.id}>
              <span className="badge badge--warn">{item.action.replaceAll("-", " ")}</span>
              <strong>{item.targetPath}</strong>
              <p>{item.rationale}</p>
            </div>
          ))}
        </div>
      )}

      <h3>Proposed automated tests</h3>
      <div className="agent-result__list">
        {result.proposal.codeOutline.map((outline) => (
          <div key={outline.sourceCaseId}>
            <span className="page-heading__eyebrow">Test title</span>
            <strong>{outline.title}</strong>
            <p>
              <strong>Target file:</strong>{" "}
              {result.proposal.filePlan.find((item) =>
                item.sourceCaseIds.includes(outline.sourceCaseId))?.targetPath
                ?? "Select the repository test file after discovery."}
            </p>
            <h4>Step-by-step behavior</h4>
            <ol>
              {outline.sections.setup.map((step, index) => (
                <li key={`setup:${index}`}>
                  <strong>Setup {index + 1}:</strong> {step}
                </li>
              ))}
              {outline.sections.actions.length > 0 ? (
                outline.sections.actions.map((step, index) => (
                  <li key={`action:${index}`}>
                    <strong>Action {index + 1}:</strong> {step}
                  </li>
                ))
              ) : (
                <li><strong>Action:</strong> Reviewer discovery is required.</li>
              )}
              {outline.sections.assertions.length > 0 ? (
                outline.sections.assertions.map((step, index) => (
                  <li key={`assertion:${index}`}>
                    <strong>Expected result {index + 1}:</strong> {step}
                  </li>
                ))
              ) : (
                <li><strong>Expected result:</strong> Reviewer discovery is required.</li>
              )}
            </ol>
            <p className="page__hint">{outline.implementationNote}</p>
          </div>
        ))}
      </div>

      <h3>Reuse candidates</h3>
      {result.proposal.reusableComponents.length === 0 ? (
        <p className="page__empty">No page object, fixture, or utility path is evidenced yet.</p>
      ) : (
        <ul>
          {result.proposal.reusableComponents.map((candidate) => (
            <li key={candidate.path}>
              <strong>{candidate.path}</strong> · {candidate.role} ·{" "}
              {candidate.confidence.level} confidence
            </li>
          ))}
        </ul>
      )}

      <h3>Required test data and validation</h3>
      {result.proposal.requiredTestData.length > 0 && (
        <ul>
          {result.proposal.requiredTestData.map((item) => (
            <li key={item.id}>{item.description}</li>
          ))}
        </ul>
      )}
      {result.proposal.validationCommands.length === 0 ? (
        <p className="page__empty">
          No validation command is asserted without repository manifest evidence.
        </p>
      ) : (
        <ul>
          {result.proposal.validationCommands.map((item) => (
            <li key={`${item.workingDirectory}:${item.command}`}>
              <code>{item.command}</code> from {item.workingDirectory}
            </li>
          ))}
        </ul>
      )}

      <h3>Discovery tasks</h3>
      <ul className="agent-result__limitations">
        {result.proposal.discoveryTasks.map((task) => (
          <li key={task.id}>
            <strong>{task.action}</strong> {task.rationale}
          </li>
        ))}
      </ul>

      <div className="agent-result__stats">
        <Metric label="Manual cases" value={result.evidence.manualCases.length} />
        <Metric label="Repository files" value={result.evidence.repositoryFiles.length} />
        <Metric label="Reuse candidates" value={result.proposal.reusableComponents.length} />
        <Metric label="Citations" value={result.evidence.citations.length} />
      </div>
      <details className="agent-result__evidence">
        <summary>Evidence and citations</summary>
        <ul>
          {result.evidence.citations.map((citation) => (
            <li key={`${citation.source}:${citation.sourceId}:${citation.sourceVersion}`}>
              <strong>{citation.source}</strong> · {citation.sourceId} · version{" "}
              {citation.sourceVersion} · observed {citation.observedAt}
            </li>
          ))}
        </ul>
      </details>
      {result.limitations.length > 0 && (
        <>
          <h3>Known limitations</h3>
          <ul className="agent-result__limitations">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}
    </article>
  );
}

function TestRailImprovementResult({ result }: { result: TestRailImprovementAgentRun }) {
  return (
    <article className="card agent-result">
      <div className="traceability-card__heading">
        <div>
          <span className="page-heading__eyebrow">Run {result.runId}</span>
          <h3>{result.workItemId} TestRail improvements</h3>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${result.status === "ready-for-review" ? "badge--ok" : "badge--warn"}`}>
            {result.status.replaceAll("-", " ")}
          </span>
          <span className="badge badge--pending">{result.confidence.level} confidence</span>
        </div>
      </div>
      <p>{result.summary}</p>
      <p className="page__hint">{result.confidence.rationale}</p>
      {result.proposals.length === 0 ? (
        <p className="page__empty">No grounded case edits or duplicate reviews were proposed.</p>
      ) : (
        <div className="agent-result__list">
          {result.proposals.map((proposal) => (
            <div key={proposal.id}>
              <div className="traceability-card__badges">
                <span className="badge badge--warn">
                  {proposal.disposition.replaceAll("-", " ")}
                </span>
                <span className="badge badge--pending">
                  {proposal.confidence.level} confidence
                </span>
              </div>
              <strong>{proposal.title}</strong>
              <p>{proposal.caseId}</p>
              <ul>
                {proposal.findings.map((finding) => (
                  <li key={finding.id}>
                    <strong>{finding.category.replaceAll("-", " ")}</strong>
                    <span>{finding.detail}</span>
                  </li>
                ))}
              </ul>
              {proposal.fieldDiffs.map((diff) => (
                <section className="agent-diff" key={diff.field}>
                  <strong>{diff.field}</strong>
                  <div>
                    <div>
                      <span>Before</span>
                      <pre>{formatFieldValue(diff.before)}</pre>
                    </div>
                    <div>
                      <span>After</span>
                      <pre>{formatFieldValue(diff.after)}</pre>
                    </div>
                  </div>
                  <p>{diff.rationale}</p>
                </section>
              ))}
              {proposal.duplicateCandidates.length > 0 && (
                <p>
                  Duplicate-intent candidates: {proposal.duplicateCandidates
                    .map((candidate) =>
                      `${candidate.title} (${Math.round(candidate.similarity * 100)}%)`)
                    .join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="agent-result__stats">
        <Metric label="Cases inspected" value={result.evidence.manualTests.length} />
        <Metric label="Edit proposals" value={
          result.proposals.filter((proposal) => proposal.fieldDiffs.length > 0).length
        } />
        <Metric label="Sources" value={result.evidence.sources.length} />
        <Metric label="Citations" value={result.evidence.citations.length} />
      </div>
      <details className="agent-result__evidence">
        <summary>Evidence and citations</summary>
        <ul>
          {result.evidence.citations.map((citation) => (
            <li key={`${citation.source}:${citation.sourceId}:${citation.sourceVersion}`}>
              <strong>{citation.source}</strong> · {citation.sourceId} · version{" "}
              {citation.sourceVersion} · observed {citation.observedAt}
            </li>
          ))}
        </ul>
      </details>
      {result.limitations.length > 0 && (
        <>
          <h3>Known limitations</h3>
          <ul className="agent-result__limitations">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}
    </article>
  );
}

function formatFieldValue(value: unknown) {
  return value === null ? "(not set)" : JSON.stringify(value, null, 2);
}

function TestDesignerResult({
  result,
  selectedProposalId,
  onSelect,
  mode = "manual",
}: {
  result: TestDesignerAgentRun;
  selectedProposalId: string | null;
  onSelect: (proposal: Proposal) => void;
  mode?: "manual" | "automation-ready";
}) {
  return (
    <article className="card agent-result">
      <div className="traceability-card__heading">
        <div>
          <span className="page-heading__eyebrow">Run {result.runId}</span>
          <h3>
            {result.workItemId}{" "}
            {mode === "automation-ready" ? "automation-ready case design" : "test design"}
          </h3>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${result.status === "ready-for-review" ? "badge--ok" : "badge--warn"}`}>
            {result.status.replaceAll("-", " ")}
          </span>
          <span className="badge badge--pending">{result.confidence.level} confidence</span>
        </div>
      </div>
      <p>{result.summary}</p>
      <p className="page__hint">{result.confidence.rationale}</p>
      {result.proposals.length === 0 ? (
        <p className="page__empty">No grounded test drafts could be generated.</p>
      ) : (
        <div className="agent-result__list">
          {result.proposals.map((proposal) => {
            const referenceCase = proposal.referenceCases?.find((candidate) =>
              candidate.id === proposal.automationSuitability?.reusedCaseId)
              ?? proposal.referenceCases?.[0];
            const missingTargetContext =
              mode === "automation-ready"
              && result.evidence.existingManualTests.length === 0;
            return (
            <div key={proposal.id}>
              <span className={`badge ${proposal.disposition === "propose-new" ? "badge--ok" : "badge--warn"}`}>
                {proposal.disposition.replaceAll("-", " ")}
              </span>
              <span className={`badge ${proposal.confidence.level === "high" ? "badge--ok" : "badge--warn"}`}>
                {proposal.confidence.level} confidence
              </span>
              <strong>{proposal.title}</strong>
              <p>{proposal.objective}</p>
              <p className="page__hint">{proposal.confidence.rationale}</p>
              {mode === "automation-ready" && proposal.automationSuitability && (
                <div className="automation-suitability">
                  <span className={`badge ${
                    proposal.automationSuitability.status === "candidate"
                      ? "badge--ok"
                      : "badge--warn"
                  }`}>
                    {proposal.automationSuitability.status.replaceAll("-", " ")}
                  </span>
                  <p>{proposal.automationSuitability.rationale}</p>
                  {proposal.automationSuitability.reusedCaseId && (
                    <p className="page__hint">
                      Workflow structure reused from{" "}
                      <strong>{proposal.automationSuitability.reusedCaseId}</strong>
                      {referenceCase ? ` — ${referenceCase.title}` : ""}.
                    </p>
                  )}
                  {proposal.automationSuitability.blockers.length > 0 && (
                    <ul>
                      {proposal.automationSuitability.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {missingTargetContext && (
                <div className="design-context-warning" role="alert">
                  <strong>This draft did not use the target TestRail section.</strong>
                  <span>
                    Load a suite and section, then generate again. This incomplete result
                    cannot be selected for publication.
                  </span>
                </div>
              )}
              {referenceCase && (
                <details className="reference-case">
                  <summary>
                    Reference workflow · {referenceCase.id.replace("manual-test:testrail:", "C")}
                    {" · "}{referenceCase.steps?.length ?? 0} source steps
                  </summary>
                  <p><strong>{referenceCase.title}</strong></p>
                  {referenceCase.preconditions && (
                    <p><strong>Source preconditions:</strong> {referenceCase.preconditions}</p>
                  )}
                  <TestStepsTable
                    ariaLabel={`Reference steps from ${referenceCase.id}`}
                    steps={(referenceCase.steps ?? []).map((step, index) => ({
                      order: index + 1,
                      action: step.action,
                      expectedResult: step.expectedResult,
                    }))}
                  />
                </details>
              )}
              <details className="proposed-case-steps" open>
                <summary>Proposed TestRail case · {proposal.steps.length} steps</summary>
                <div className="case-preconditions">
                  <strong>Preconditions</strong>
                  <p>{proposal.preconditions.join(" ")}</p>
                </div>
                <TestStepsTable
                  ariaLabel={`Proposed steps for ${proposal.title}`}
                  steps={proposal.steps}
                />
              </details>
              {!missingTargetContext && (
                <button
                  className="button button--primary"
                  onClick={() => onSelect(proposal)}
                  type="button"
                >
                  {selectedProposalId === proposal.id
                    ? "Selected for TestRail"
                    : proposal.disposition === "review-existing"
                      ? "Use grounded draft after review"
                      : "Use this draft"}
                </button>
              )}
              {proposal.duplicateCandidates.length > 0 && (
                <p>
                  Possible duplicates: {proposal.duplicateCandidates
                    .map((candidate) => `${candidate.title} (${Math.round(candidate.similarity * 100)}%)`)
                    .join(", ")}
                </p>
              )}
            </div>
            );
          })}
        </div>
      )}
      <div className="agent-result__metrics">
        <Metric label="Requirements" value={result.evidence.requirements.length} />
        <Metric label="TestRail cases checked" value={result.evidence.existingManualTests.length} />
        <Metric label="Citations" value={result.evidence.citations.length} />
      </div>
      <details>
        <summary>Evidence and citations</summary>
        <ul className="agent-result__citations">
          {result.evidence.citations.map((citation) => (
            <li key={`${citation.source}:${citation.sourceId}:${citation.sourceVersion}`}>
              <strong>{citation.source}</strong> {citation.sourceId} · version{" "}
              {citation.sourceVersion} · observed {citation.observedAt}
            </li>
          ))}
        </ul>
      </details>
      {result.limitations.length > 0 && (
        <>
          <h3>Known limitations</h3>
          <ul className="agent-result__limitations">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}
    </article>
  );
}

function TestStepsTable({
  steps,
  ariaLabel,
}: {
  steps: Array<{ order: number; action: string; expectedResult: string }>;
  ariaLabel: string;
}) {
  return (
    <div
      className="test-steps-table__scroll"
      aria-label={`${ariaLabel} table region`}
      role="region"
      tabIndex={0}
    >
      <table className="test-steps-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Action</th>
            <th scope="col">Expected result</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={`${step.order}:${step.action}`}>
              <th scope="row">{step.order}</th>
              <td>{step.action}</td>
              <td>{step.expectedResult || "Reviewer must define a concrete result."}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentResult({ result }: { result: CoverageContextAgentRun }) {
  return (
    <article className="card agent-result">
      <div className="traceability-card__heading">
        <div>
          <span className="page-heading__eyebrow">Run {result.runId}</span>
          <h3>{result.workItemId} analysis</h3>
        </div>
        <div className="traceability-card__badges">
          <span className={`badge ${result.status === "ready-for-review" ? "badge--ok" : "badge--warn"}`}>
            {result.status.replaceAll("-", " ")}
          </span>
          <span className={`badge ${result.confidence.level === "high" ? "badge--ok" : "badge--warn"}`}>
            {result.confidence.level} confidence
          </span>
        </div>
      </div>
      <p>{result.summary}</p>
      <p className="page__hint">{result.confidence.rationale}</p>

      <div className="agent-result__stats">
        <Metric label="Sources" value={result.evidence.sources.length} />
        <Metric label="Requirements" value={result.evidence.requirements.length} />
        <Metric label="Tests" value={result.evidence.tests.length} />
        <Metric label="Citations" value={result.evidence.citations.length} />
      </div>

      <h3>Findings</h3>
      {result.findings.length === 0 ? (
        <p className="page__empty">No findings were produced for this scope.</p>
      ) : (
        <div className="agent-result__list">
          {result.findings.map((finding) => (
            <div key={finding.id}>
              <span className={`badge ${finding.severity === "high" ? "badge--error" : "badge--warn"}`}>
                {finding.severity}
              </span>
              <strong>{finding.title}</strong>
              <p>{finding.detail}</p>
            </div>
          ))}
        </div>
      )}

      <h3>Recommended next actions</h3>
      <div className="agent-result__list">
        {result.recommendations.map((recommendation) => (
          <div key={recommendation.id}>
            <strong>{recommendation.action}</strong>
            <p>{recommendation.rationale}</p>
          </div>
        ))}
      </div>

      {result.limitations.length > 0 && (
        <>
          <h3>Known limitations</h3>
          <ul className="agent-result__limitations">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </>
      )}

      <details className="agent-result__evidence">
        <summary>Evidence and citations</summary>
        {result.evidence.citations.length === 0 ? (
          <p>No citations are available.</p>
        ) : (
          <ul>
            {result.evidence.citations.map((citation) => (
              <li key={`${citation.source}:${citation.sourceId}:${citation.sourceVersion}`}>
                <strong>{citation.source}</strong> · {citation.sourceId} · version {citation.sourceVersion}
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
