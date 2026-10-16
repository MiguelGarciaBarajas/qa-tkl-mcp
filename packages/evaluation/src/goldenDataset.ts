import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { RawEvidenceRecord } from "@tkl/contracts";

const DATASET_ROOT = fileURLToPath(new URL("../../../tests/fixtures/golden-dataset/", import.meta.url));

export interface GoldenDatasetManifest {
  datasetVersion: string;
  productId: string;
  asOf: string;
  description: string;
  categories: Record<string, string>;
  tickets: Array<{ key: string; category: string }>;
}

export interface ExpectedTicketOutcome {
  ticketKey: string;
  category: string;
  requirementId: string;
  hasJiraConflictRevision: boolean;
  expectedDenominator: number;
  expectedExplicitTraceLinkCount: number;
  expectedCovered: boolean;
  expectedConflict: boolean;
  notes: string;
}

export interface GoldenTicket {
  key: string;
  category: string;
  requirementId: string;
  /** Jira raw evidence records for this ticket, in the order they should be normalized (initial version first). */
  jiraRecords: RawEvidenceRecord[];
  /** GitHub raw evidence records for this ticket (both explicit and prose-only references). */
  githubRecords: RawEvidenceRecord[];
  expected: ExpectedTicketOutcome;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Loads the committed golden-dataset manifest and metadata (no fixture I/O). */
export function loadManifest(): GoldenDatasetManifest {
  return readJson<GoldenDatasetManifest>(join(DATASET_ROOT, "manifest.json"));
}

/** Loads every ticket's raw evidence and hand-labeled expected outcome from the committed golden dataset. */
export function loadGoldenDataset(): { manifest: GoldenDatasetManifest; tickets: GoldenTicket[] } {
  const manifest = loadManifest();
  const tickets = manifest.tickets.map(({ key }) => loadTicket(key));
  return { manifest, tickets };
}

function loadTicket(key: string): GoldenTicket {
  const ticketDir = join(DATASET_ROOT, "tickets", key);
  const files = readdirSync(ticketDir);
  const expected = readJson<ExpectedTicketOutcome>(join(ticketDir, "expected.json"));

  const jiraRecords = files
    .filter((file) => file.startsWith("jira") && file.endsWith(".json"))
    .sort()
    .map((file) => readJson<RawEvidenceRecord>(join(ticketDir, file)));

  const githubRecords = files
    .filter((file) => file.startsWith("github") && file.endsWith(".json"))
    .sort()
    .map((file) => readJson<RawEvidenceRecord>(join(ticketDir, file)));

  return {
    key,
    category: expected.category,
    requirementId: expected.requirementId,
    jiraRecords,
    githubRecords,
    expected,
  };
}
