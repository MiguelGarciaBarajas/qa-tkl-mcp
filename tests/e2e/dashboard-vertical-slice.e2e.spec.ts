import { expect, test } from "./support/fixtures";

/**
 * INT-102 - browser/dashboard vertical slice.
 *
 * A real Chromium browser drives the real dashboard against a real local TKL Application
 * API whose knowledge store was seeded with committed, sanitized Jira, GitHub, and
 * TestRail fixtures. Nothing in this file stubs the application layer: every assertion is
 * about content a stakeholder can see, produced by an actual HTTP round trip.
 *
 * Stakeholder flow under test:
 *   connector health -> story traceability and provenance -> coverage -> conflict review
 *   through the approved review endpoint -> the reviewed state observed after a reload.
 */

const COVERED_REQUIREMENT_ID = "requirement:FLT-2001";
const COVERED_REQUIREMENT_TITLE = "As a clerk I can submit a title application with a valid VIN";
const REVIEWED_CONFLICT_ENTITY = "requirement:FLT-2023";
const REMAINING_CONFLICT_ENTITY = "requirement:FLT-2024";

test.describe.configure({ mode: "serial" });

test("stakeholder reviews connector health, traceability, provenance, and coverage", async ({
  page,
}) => {
  await page.goto("/#/sources/health");

  await expect(page.getByRole("heading", { name: "TKL Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connector Health", level: 2 })).toBeVisible();

  const healthTable = page.getByRole("table");
  for (const connectorId of ["jira", "github", "testrail"]) {
    const row = healthTable.getByRole("row").filter({ hasText: connectorId });
    await expect(row).toContainText("Healthy");
    await expect(row).toContainText("valid");
  }
  // The dashboard shows credential status only - never a credential value or reference.
  await expect(page.locator("body")).not.toContainText("secret://");

  await page.getByRole("link", { name: "Quality Insights" }).click();
  await page.getByRole("link", { name: "Traceability" }).click();
  await expect(page.getByRole("heading", { name: "Story Traceability", level: 2 })).toBeVisible();

  const story = page
    .locator("article")
    .filter({
      hasText: `${COVERED_REQUIREMENT_ID.replace("requirement:", "")} — ${COVERED_REQUIREMENT_TITLE}`,
    });
  await expect(story).toBeVisible();

  const automatedRow = story.getByRole("row").filter({ hasText: "Cover FLT-2001 acceptance criteria" });
  await expect(automatedRow).toContainText(COVERED_REQUIREMENT_TITLE);
  await expect(automatedRow).toContainText("Automated");
  await expect(automatedRow).toContainText("GitHub (v");
  await expect(automatedRow).toContainText("Explicit");

  const manualRow = story.getByRole("row").filter({ hasText: "Verify a linked title workflow" });
  await expect(manualRow).toContainText("Manual");
  await expect(manualRow).toContainText("TestRail (v");
  await expect(manualRow).toContainText("Explicit");

  await page.getByRole("link", { name: "Coverage" }).click();
  await expect(page.getByRole("heading", { name: "Coverage Gaps", level: 2 })).toBeVisible();

  const coverageRow = page.getByRole("row").filter({ hasText: COVERED_REQUIREMENT_TITLE });
  await expect(coverageRow).toContainText("1/1");
  await expect(coverageRow).toContainText("explicit");
});

test("a connection owner connects and validates a JIT source without credential readback", async ({
  page,
}) => {
  await page.goto("/#/sources/connections");
  const testRailCard = page.locator("article").filter({ hasText: "TestRail" });
  await expect(testRailCard.getByText("Not connected")).toBeVisible();

  await testRailCard.getByLabel("TestRail URL").fill("https://testrail.example.com");
  await testRailCard.getByLabel("Account email").fill("qa@example.com");
  await testRailCard.getByLabel("Project ID").fill("12");
  await testRailCard.getByLabel("Credential").fill("synthetic-e2e-source-token");
  await expect(testRailCard.getByRole("radio", { name: /All suites/ })).toBeChecked();

  const connectResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/source-connections/testrail")
      && response.request().method() === "PUT",
  );
  await testRailCard.getByRole("button", { name: "Connect" }).click();
  expect((await connectResponse).status()).toBe(200);

  await expect(testRailCard.getByText("Connected")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("synthetic-e2e-source-token");
  await expect(testRailCard.getByLabel("New credential (required to rotate)")).toHaveValue("");

  const testResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/source-connections/testrail/test")
      && response.request().method() === "POST",
  );
  await testRailCard.getByRole("button", { name: "Test connection" }).click();
  expect((await testResponse).status()).toBe(200);
  await expect(testRailCard.getByRole("button", { name: "Sync now" })).toHaveCount(0);

  await page.reload();
  await expect(testRailCard.getByText("Connected")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("synthetic-e2e-source-token");
});

test("Knowledge Curator proposes an abstaining conflict review without mutating knowledge", async ({
  page,
}) => {
  await page.goto("/#/reviews/proposals");
  await expect(page.getByRole("heading", { name: "Agent Proposals", level: 2 })).toBeVisible();
  await page.getByRole("combobox", { name: "Proposal workflow" })
    .selectOption({ label: "Review knowledge conflicts" });

  await page
    .getByRole("textbox", { name: "Knowledge Curator Jira ticket or epic" })
    .fill("FLT-2023");
  const curatorResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/agents/knowledge-curator/runs")
      && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Propose curation reviews" }).click();
  expect((await curatorResponse).status()).toBe(200);

  const result = page.locator("article").filter({ hasText: "FLT-2023 knowledge curation" });
  await expect(result).toBeVisible();
  await expect(result).toContainText("conflict resolution");
  await expect(result).toContainText("abstain");
  await expect(result).toContainText("After / action preview");
  await expect(result).toContainText("knowledge-reviewer");

  await page.getByRole("link", { name: "Conflicts" }).click();
  const unchangedConflict = page.locator("article").filter({ hasText: REVIEWED_CONFLICT_ENTITY });
  await expect(unchangedConflict.getByText("Open")).toBeVisible();
});

test("Ask TKL combines Jira and cross-platform quality evidence", async ({ page }) => {
  await page.goto("/#/investigate/ask");
  await expect(page.getByRole("heading", { name: "Ask TKL", level: 2 })).toBeVisible();

  await page
    .getByRole("textbox", { name: "Ask TKL question" })
    .fill("What should QA know about FLT-2001?");
  const askResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/ask")
      && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Ask TKL" }).click();
  expect((await askResponse).status()).toBe(200);

  const answer = page.locator("article.ask-tkl__message--assistant");
  await expect(answer).toContainText("ticket intelligence");
  await expect(answer).toContainText("Cross-platform evidence");
  await expect(answer).toContainText("TestRail");
  await expect(answer).toContainText("GitHub");
  await expect(answer).toContainText("confidence");
  await expect(answer.getByRole("link", { name: /\[S1\]/ })).toBeVisible();
  await expect(answer).not.toContainText("I cannot answer this from grounded TKL evidence");
});

test("approved conflict review is recorded through the real API and survives a reload", async ({
  page,
  context,
  stack,
}) => {
  // Deliberately slow the real response (the request is still served by the API, nothing
  // is stubbed) so the loading state is observable without a race.
  const conflictsListRequest = (url: URL) => url.pathname === "/v1/knowledge/conflicts";
  await page.route(conflictsListRequest, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });

  await page.goto("/#/reviews/conflicts");
  await expect(page.getByText(/Loading knowledge conflicts/)).toBeVisible();

  const conflictCard = page.locator("article").filter({ hasText: REVIEWED_CONFLICT_ENTITY });
  await expect(conflictCard).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await expect(conflictCard).toContainText('claims disagree on "acceptanceCriteria"');
  await expect(conflictCard.getByText("Open")).toBeVisible();

  // A second tab loaded before the review, used later to prove the decision is durable.
  const stalePage = await context.newPage();
  await stalePage.goto(`${stack.dashboard.url}/#/reviews/conflicts`);
  const staleCard = stalePage.locator("article").filter({ hasText: REVIEWED_CONFLICT_ENTITY });
  await expect(staleCard.getByRole("button", { name: "Submit review" })).toBeVisible();

  // Approving without selecting a claim must be refused by the UI before any request.
  await conflictCard.getByRole("button", { name: "Submit review" }).click();
  await expect(conflictCard.getByRole("alert")).toContainText("Select at least one claim");

  // Approve the superseding revision's claim (the only claim id carrying a version suffix).
  const supersedingClaim = conflictCard.getByRole("checkbox", { name: /@/ });
  await expect(supersedingClaim).toBeVisible();
  await supersedingClaim.check();
  await conflictCard
    .getByRole("textbox", { name: /Note/ })
    .fill("Approved the latest Jira revision during the INT-102 stakeholder review.");

  const reviewResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/knowledge/conflicts/review") && response.request().method() === "POST",
  );
  await conflictCard.getByRole("button", { name: "Submit review" }).click();
  expect((await reviewResponse).status()).toBe(200);

  await expect(conflictCard.getByText("Reviewed")).toBeVisible();
  await expect(conflictCard.getByRole("checkbox")).toHaveCount(0);

  // Reloading refetches from the API: the reviewed conflict is no longer open, and the
  // untouched conflict is still waiting for a human decision.
  await page.reload();
  await expect(page.locator("article").filter({ hasText: REMAINING_CONFLICT_ENTITY })).toBeVisible();
  await expect(page.locator("article").filter({ hasText: REVIEWED_CONFLICT_ENTITY })).toHaveCount(0);

  // The stale tab still offers the review; the API - not the UI - rejects the duplicate.
  // Today the Application API answers a second review with 404 `conflict_not_found`
  // (`listOpenConflicts` no longer returns the reviewed conflict) rather than 409
  // `conflict_already_reviewed`; either way the durable decision wins and the stale tab
  // cannot overwrite it. The assertion accepts both wordings so a future API refinement
  // does not break this flow.
  await staleCard.getByRole("checkbox", { name: /@/ }).check();
  await staleCard.getByRole("button", { name: "Submit review" }).click();
  await expect(staleCard.getByRole("alert")).toContainText(
    /already been reviewed|does not exist/,
  );
  await expect(staleCard.getByText("Reviewed")).toHaveCount(0);
  await stalePage.close();

  // Same state, read straight from the Application API over HTTP.
  const conflicts = await page.request.get(
    `${stack.api.url}/v1/knowledge/conflicts?productId=fl-titling`,
    { headers: { Authorization: `Bearer ${stack.api.token}` } },
  );
  expect(conflicts.status()).toBe(200);
  const body = (await conflicts.json()) as { conflicts: Array<{ id: string; entityId: string }> };
  expect(body.conflicts.map((conflict) => conflict.entityId)).not.toContain(REVIEWED_CONFLICT_ENTITY);
  expect(body.conflicts.map((conflict) => conflict.entityId)).toContain(REMAINING_CONFLICT_ENTITY);
});

test("the API refuses unauthenticated and out-of-scope requests", async ({ page, stack }) => {
  const unauthenticated = await page.request.get(
    `${stack.api.url}/v1/knowledge/conflicts?productId=fl-titling`,
  );
  expect(unauthenticated.status()).toBe(401);

  const otherProduct = await page.request.get(
    `${stack.api.url}/v1/knowledge/conflicts?productId=another-product`,
    { headers: { Authorization: `Bearer ${stack.api.token}` } },
  );
  expect(otherProduct.status()).toBe(403);
  expect((await otherProduct.json()).error.code).toBe("product_access_denied");
});

test("a selected test draft produces an approvable immutable TestRail preview", async ({
  page,
}) => {
  await page.goto("/#/reviews/proposals");
  await page.getByRole("textbox", { name: "Test Designer Jira ticket or epic" })
    .fill("FLT-2023");
  await page.getByRole("button", { name: "Generate test drafts" }).click();
  await page.getByRole("button", { name: "Use this draft" }).first().click();
  await page.getByRole("textbox", { name: "TestRail suite ID or URL" })
    .fill("https://testrail.example/index.php?/suites/view/128");
  await page.getByRole("button", { name: "Load sections" }).click();
  await expect(page.getByRole("combobox", { name: "Destination TestRail section" }))
    .toHaveValue("1201");
  await page.getByRole("button", { name: "Review TestRail case" }).click();

  const preview = page.getByRole("article", { name: "Approved action preview" });
  await expect(preview.getByText("Immutable preview")).toBeVisible();
  await expect(preview).toContainText("testrail case create");
  await expect(preview).toContainText("ready");
  await expect(preview).toContainText("FLT-2023");
  await expect(
    preview.getByRole("button", { name: "Approve case creation" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Approve case creation" }).click();
  await preview.getByRole("button", { name: "Create case in TestRail" }).click();
  await expect(preview.getByRole("status")).toContainText(
    "Case C9001 created successfully",
  );
  await expect(preview.getByRole("link", { name: "Open in TestRail" })).toHaveAttribute(
    "href",
    "https://testrail.example/index.php?/cases/view/9001",
  );
});

test("a dashboard configured with a rejected token shows an authorization error", async ({
  page,
  unauthorizedDashboard,
}) => {
  await page.goto(`${unauthorizedDashboard.url}/#/reviews/conflicts`);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Failed to load conflicts");
  await expect(page.locator("article")).toHaveCount(0);
});
