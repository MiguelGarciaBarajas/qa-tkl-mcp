import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertRawEvidenceRecord, sha256 } from "@tkl/contracts";

/**
 * Generates the golden dataset of synthetic, sanitized FL Titling tickets used by the
 * evaluation harness (`@tkl/evaluation`). Every raw evidence record and expected label
 * committed to `tests/fixtures/golden-dataset/` is produced by this script so the
 * dataset's construction rules are auditable and reproducible - re-running this script
 * must always regenerate byte-identical output.
 *
 * Owner: Clemente Herrera (Dashboard and Evaluation). Regenerate with:
 *   npm run generate-dataset --workspace=@tkl/evaluation
 * Review the diff before committing - this script is the single source of truth for
 * the dataset; do not hand-edit the generated fixture/expected JSON files.
 */

const TENANT_ID = "solera";
const PRODUCT_ID = "fl-titling";
const AS_OF = "2026-09-15T00:00:00.000Z";
const OUT_DIR = fileURLToPath(new URL("../../../tests/fixtures/golden-dataset/", import.meta.url));

interface TicketSpec {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string[];
  observedAt: string;
  /** Second Jira evidence version with a conflicting claim value, if this ticket exercises conflict detection. */
  conflictingRevision?: { description?: string; acceptanceCriteria?: string[]; observedAt: string; sourceVersion: string };
  /** GitHub PRs that structurally reference this ticket key via `referencedIssues`/`ticketKey` (explicit, normalizer-visible). */
  explicitPrs?: Array<{ number: number; title: string; observedAt: string }>;
  /** GitHub PRs that only mention the ticket key in free-text title/body - the current normalizer cannot see these. */
  proseOnlyPrs?: Array<{ number: number; title: string; body: string; observedAt: string }>;
  /** Whether a human reviewer, given all real-world evidence (including prose-only PR mentions), would consider this requirement verified. */
  expectedCovered: boolean;
  category: string;
  notes: string;
}

function jiraRecord(ticket: TicketSpec, sourceVersion: string, observedAt: string, overrides?: { description?: string; acceptanceCriteria?: string[] }) {
  const payload = {
    key: ticket.key,
    fields: {
      issuetype: { name: "Story" },
      summary: ticket.summary,
      description: overrides?.description ?? ticket.description,
      acceptanceCriteria: overrides?.acceptanceCriteria ?? ticket.acceptanceCriteria,
      status: { name: "Done" },
    },
  };
  const record = {
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    source: "jira",
    sourceId: ticket.key,
    sourceVersion,
    sourceUrl: `https://example.atlassian.net/browse/${ticket.key}`,
    observedAt,
    contentType: "application/vnd.jira.issue+json",
    contentHash: sha256({ key: ticket.key, sourceVersion, payload }),
    classification: "internal",
    payload,
  };
  return assertRawEvidenceRecord(record);
}

function githubRecord(ticket: TicketSpec, pr: { number: number; title: string; observedAt: string; body?: string }, explicit: boolean) {
  const payload: Record<string, unknown> = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? `Implements ${ticket.key}.`,
    changedFiles: [`tests/e2e/${ticket.key.toLowerCase()}.spec.ts`],
    state: "merged",
  };
  if (explicit) {
    payload.referencedIssues = [ticket.key];
  }
  const record = {
    tenantId: TENANT_ID,
    productId: PRODUCT_ID,
    source: "github",
    sourceId: `Solera-Engineering/fl-titling#${pr.number}`,
    sourceVersion: sha256(`${pr.number}:${pr.observedAt}`).slice(0, 40),
    sourceUrl: `https://github.com/Solera-Engineering/fl-titling/pull/${pr.number}`,
    observedAt: pr.observedAt,
    contentType: "application/vnd.github.pull-request+json",
    contentHash: sha256({ number: pr.number, payload }),
    classification: "internal",
    payload,
  };
  return assertRawEvidenceRecord(record);
}

const tickets: TicketSpec[] = [];

// Category A - clean-single-pr: one Jira story, one GitHub PR that explicitly
// references it, fully covering every acceptance criterion via one verifies link.
const cleanSingle: Array<[string, string, string[]]> = [
  ["FLT-2001", "As a clerk I can submit a title application with a valid VIN", [
    "Given a valid 17-character VIN, the application is accepted.",
    "Given an invalid VIN checksum, the application is rejected with an error.",
  ]],
  ["FLT-2002", "As a clerk I can record a lien holder on a title application", [
    "Given a valid lien holder ID, the lien is attached to the title.",
    "Given a duplicate lien holder, a warning is shown but the record still saves.",
  ]],
  ["FLT-2003", "As a clerk I can transfer title ownership between two parties", [
    "Given both parties sign the transfer, ownership updates immediately.",
    "Given only one party signs, the transfer remains pending.",
  ]],
  ["FLT-2004", "As a clerk I can flag a title as salvage", [
    "Given an insurance total-loss code, the title is marked salvage.",
    "Given a salvage title, it cannot be re-issued as clean without an inspection record.",
  ]],
  ["FLT-2005", "As a clerk I can process an out-of-state title conversion", [
    "Given a valid out-of-state title document, a new in-state title is generated.",
    "Given an expired out-of-state title, the conversion is rejected.",
  ]],
  ["FLT-2006", "As a clerk I can void a duplicate title request", [
    "Given an active duplicate request, voiding it cancels the pending printing job.",
    "Given no active request, voiding returns a not-found error.",
  ]],
  ["FLT-2007", "As a system I can notify the electronic lien holder on release", [
    "Given a lien release event, the ELT holder receives a notification within 24 hours.",
    "Given a failed notification, the event is retried up to 3 times.",
  ]],
  ["FLT-2008", "As a clerk I can correct a VIN typo on an issued title", [
    "Given a documented clerical error, the VIN can be corrected without re-titling fees.",
    "Given no supporting documentation, the correction request is rejected.",
  ]],
  ["FLT-2009", "As a clerk I can register a repossessed vehicle title", [
    "Given a valid repossession affidavit, the title transfers to the lender.",
    "Given a missing affidavit, the transfer is blocked.",
  ]],
  ["FLT-2010", "As a clerk I can apply a court order to a disputed title", [
    "Given a valid court order document, the disputed hold is lifted.",
  ]],
  ["FLT-2011", "As a clerk I can issue a title for a homemade trailer", [
    "Given a completed weight-and-dimension affidavit, the trailer title is issued.",
    "Given a missing affidavit, the request is held for additional information.",
  ]],
  ["FLT-2012", "As a clerk I can process a title for a vehicle donated to charity", [
    "Given a signed donation acknowledgment, ownership transfers to the charity.",
  ]],
];

for (const [key, summary, acceptanceCriteria] of cleanSingle) {
  tickets.push({
    key,
    summary,
    description: `${summary}. Evidence is fully traceable via one referencing pull request.`,
    acceptanceCriteria,
    observedAt: "2026-08-01T09:00:00.000Z",
    explicitPrs: [{ number: 5000 + tickets.length, title: `Cover ${key} acceptance criteria`, observedAt: "2026-08-02T09:00:00.000Z" }],
    expectedCovered: true,
    category: "clean-single-pr",
    notes: "One explicit PR reference; coverage should be fully detected.",
  });
}

// Category B - clean-multi-pr: two GitHub PRs both explicitly reference the same
// ticket (e.g. a follow-up fix PR); numerator is capped at the acceptance-criteria denominator.
const cleanMulti: Array<[string, string, string[]]> = [
  ["FLT-2013", "As a clerk I can split a joint title into two individual titles", [
    "Given a signed split agreement, two new titles are issued.",
    "Given only one signature, the split request stays pending.",
    "Given conflicting VINs, the split is rejected.",
  ]],
  ["FLT-2014", "As a clerk I can reinstate a suspended title after fee payment", [
    "Given full fee payment, the suspension is lifted within one business day.",
    "Given partial payment, the suspension remains active.",
  ]],
  ["FLT-2015", "As a clerk I can process a manufacturer buy-back title", [
    "Given a signed buy-back agreement, the title is re-issued to the manufacturer.",
    "Given a missing agreement, the buy-back request is rejected.",
  ]],
];

for (const [key, summary, acceptanceCriteria] of cleanMulti) {
  const base = 5100 + tickets.length;
  tickets.push({
    key,
    summary,
    description: `${summary}. Two pull requests, an initial implementation and a follow-up fix, both explicitly reference this ticket.`,
    acceptanceCriteria,
    observedAt: "2026-08-03T09:00:00.000Z",
    explicitPrs: [
      { number: base, title: `Implement ${key}`, observedAt: "2026-08-04T09:00:00.000Z" },
      { number: base + 1, title: `Fix edge case for ${key}`, observedAt: "2026-08-10T09:00:00.000Z" },
    ],
    expectedCovered: true,
    category: "clean-multi-pr",
    notes: "Two explicit PR references; numerator should be capped at the denominator, not double-counted.",
  });
}

// Category C - no-evidence: Jira story only, no test evidence has been recorded yet.
const noEvidence: Array<[string, string, string[]]> = [
  ["FLT-2016", "As a clerk I can attach a power of attorney to a title application", [
    "Given a notarized power of attorney, the application proceeds without the owner's signature.",
    "Given an unnotarized document, the application is rejected.",
  ]],
  ["FLT-2017", "As a clerk I can register a custom-built kit vehicle", [
    "Given a completed kit manufacturer affidavit, a new title is issued.",
  ]],
  ["FLT-2018", "As a clerk I can process a title for an abandoned vehicle claim", [
    "Given a completed abandonment hold period, the title transfers to the claimant.",
    "Given an active dispute, the transfer is blocked.",
  ]],
];

for (const [key, summary, acceptanceCriteria] of noEvidence) {
  tickets.push({
    key,
    summary,
    description: `${summary}. No test evidence has been linked yet.`,
    acceptanceCriteria,
    observedAt: "2026-08-05T09:00:00.000Z",
    expectedCovered: false,
    category: "no-evidence",
    notes: "No GitHub evidence exists at all; coverage should correctly report zero.",
  });
}

// Category D - prose-only-reference: the referencing pull request mentions the ticket
// key only in free-text title/body, not in the structured `referencedIssues`/`ticketKey`
// fields the normalizer inspects. A human reviewer would recognize the reference; the
// current normalizer cannot, so this deliberately exposes a recall gap.
const proseOnly: Array<[string, string, string[]]> = [
  ["FLT-2019", "As a clerk I can void an erroneous title fee charge", [
    "Given a documented billing error, the fee is voided and refunded.",
    "Given no documentation, the void request is rejected.",
  ]],
  ["FLT-2020", "As a clerk I can apply an odometer discrepancy hold", [
    "Given conflicting odometer readings, a hold is placed on the title.",
  ]],
  ["FLT-2021", "As a clerk I can process a title for a leased vehicle buy-out", [
    "Given a signed buy-out agreement, the lessor is removed as lienholder.",
    "Given a missing agreement, the lienholder remains on record.",
  ]],
  ["FLT-2022", "As a clerk I can record a name change on an existing title", [
    "Given a legal name-change document, the title reflects the new name without re-titling fees.",
  ]],
];

for (const [key, summary, acceptanceCriteria] of proseOnly) {
  const number = 5200 + tickets.length;
  tickets.push({
    key,
    summary,
    description: `${summary}. The verifying pull request only mentions this ticket in free text.`,
    acceptanceCriteria,
    observedAt: "2026-08-06T09:00:00.000Z",
    proseOnlyPrs: [
      {
        number,
        title: `Add regression coverage (see ${key} in Jira)`,
        body: `This closes out the remaining work discussed in ${key}, no structured issue link was set on this PR.`,
        observedAt: "2026-08-07T09:00:00.000Z",
      },
    ],
    expectedCovered: true,
    category: "prose-only-reference",
    notes: "PR references the ticket only in prose; current GitHubNormalizer cannot detect this - expected FN.",
  });
}

// Category E - conflicting-claims: the same Jira issue was independently re-scraped
// with a materially different acceptance-criteria/description value, and both versions
// were approved by different reviewers before the conflict was caught.
const conflicting: Array<[string, string, string[], { description?: string; acceptanceCriteria?: string[] }]> = [
  ["FLT-2023", "As a clerk I can set a title's brand designation", [
    "Given a flood-damage inspection report, the title is branded 'flood'.",
  ], { acceptanceCriteria: ["Given a flood-damage inspection report, the title is branded 'flood damage' with a distinct visual marker."] }],
  ["FLT-2024", "As a clerk I can apply a mileage exemption to an antique vehicle title", [
    "Given a vehicle older than 20 model years, the odometer disclosure is exempt.",
  ], { description: "As a clerk I can apply a mileage exemption to an antique vehicle title. Exemption threshold is 25 model years per the revised statute." }],
  ["FLT-2025", "As a clerk I can reject a title application with a stop-sale hold", [
    "Given an active stop-sale hold, the application is rejected with an explanation.",
  ], { acceptanceCriteria: ["Given an active stop-sale hold, the application is rejected silently for audit review."] }],
];

for (const [key, summary, acceptanceCriteria, conflictOverrides] of conflicting) {
  const number = 5300 + tickets.length;
  tickets.push({
    key,
    summary,
    description: `${summary}. Two independently reviewed evidence versions disagree.`,
    acceptanceCriteria,
    observedAt: "2026-08-08T09:00:00.000Z",
    conflictingRevision: { ...conflictOverrides, observedAt: "2026-08-12T09:00:00.000Z", sourceVersion: "2" },
    explicitPrs: [{ number, title: `Cover ${key} acceptance criteria`, observedAt: "2026-08-09T09:00:00.000Z" }],
    expectedCovered: true,
    category: "conflicting-claims",
    notes: "A second, independently-approved Jira revision disagrees with the first - the conflict analyzer must flag it.",
  });
}

// --- write output ---

// Only clear the generated `tickets/` subdirectory and `manifest.json` - never the
// whole dataset directory, which also holds the hand-written README.md.
rmSync(join(OUT_DIR, "tickets"), { recursive: true, force: true });
mkdirSync(join(OUT_DIR, "tickets"), { recursive: true });

const manifestTickets: Array<{ key: string; category: string }> = [];

for (const ticket of tickets) {
  const ticketDir = join(OUT_DIR, "tickets", ticket.key);
  mkdirSync(ticketDir, { recursive: true });

  const jira = jiraRecord(ticket, "1", ticket.observedAt);
  writeFileSync(join(ticketDir, "jira.raw.json"), `${JSON.stringify(jira, null, 2)}\n`);

  if (ticket.conflictingRevision) {
    const revision = jiraRecord(ticket, ticket.conflictingRevision.sourceVersion, ticket.conflictingRevision.observedAt, {
      description: ticket.conflictingRevision.description,
      acceptanceCriteria: ticket.conflictingRevision.acceptanceCriteria,
    });
    writeFileSync(join(ticketDir, "jira.revision-2.raw.json"), `${JSON.stringify(revision, null, 2)}\n`);
  }

  const githubFiles: string[] = [];
  for (const pr of ticket.explicitPrs ?? []) {
    const record = githubRecord(ticket, pr, true);
    const file = `github-${pr.number}.raw.json`;
    writeFileSync(join(ticketDir, file), `${JSON.stringify(record, null, 2)}\n`);
    githubFiles.push(file);
  }
  for (const pr of ticket.proseOnlyPrs ?? []) {
    const record = githubRecord(ticket, pr, false);
    const file = `github-${pr.number}.raw.json`;
    writeFileSync(join(ticketDir, file), `${JSON.stringify(record, null, 2)}\n`);
    githubFiles.push(file);
  }

  const denominator = ticket.acceptanceCriteria.length;
  const explicitLinkCount = ticket.explicitPrs?.length ?? 0;
  const expected = {
    ticketKey: ticket.key,
    category: ticket.category,
    requirementId: `requirement:${ticket.key}`,
    hasJiraConflictRevision: Boolean(ticket.conflictingRevision),
    expectedDenominator: denominator,
    expectedExplicitTraceLinkCount: explicitLinkCount,
    expectedCovered: ticket.expectedCovered,
    expectedConflict: Boolean(ticket.conflictingRevision),
    notes: ticket.notes,
  };
  writeFileSync(join(ticketDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);

  manifestTickets.push({ key: ticket.key, category: ticket.category });
}

const manifest = {
  datasetVersion: "2026.09-fl-titling-golden-v1",
  productId: PRODUCT_ID,
  asOf: AS_OF,
  description:
    "Synthetic, sanitized FL Titling tickets used to evaluate the knowledge/traceability pipeline (normalizers + coverage/conflict analyzers). Regenerate via packages/evaluation/scripts/generate-golden-dataset.ts.",
  categories: {
    "clean-single-pr": "One Jira story fully covered by one explicitly-referencing GitHub PR.",
    "clean-multi-pr": "One Jira story covered by two explicitly-referencing GitHub PRs.",
    "no-evidence": "Jira story with no GitHub evidence recorded yet.",
    "prose-only-reference":
      "GitHub PR mentions the ticket only in free text, not in structured referencedIssues/ticketKey fields - exposes a normalizer recall gap.",
    "conflicting-claims": "A second, independently-approved Jira revision disagrees with the first, so the conflict analyzer must flag it.",
  },
  tickets: manifestTickets,
};
writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Generated ${tickets.length} golden-dataset tickets under ${OUT_DIR}`);
