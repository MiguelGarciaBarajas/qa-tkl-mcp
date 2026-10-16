import type { ProductConfiguration } from "@tkl/contracts";
import { PluginRegistry } from "@tkl/plugin-registry";
import {
  composeConfiguredPlugins,
  TklApplicationService,
} from "../src/index.js";
import {
  createDeprecatedJiraQueryAdapter,
  LEGACY_JIRA_QUERY_DEPRECATION_NOTICE,
  type DeprecatedJiraQueryAdapter,
} from "../src/legacy-jira-queries.js";

const configuration = {
  configVersion: "0.1",
  tenantId: "tenant-test",
  productId: "fl-titling",
  enabledPlugins: [],
  plannedPlugins: [],
  credentialRefs: {},
  sources: {},
} satisfies ProductConfiguration;

const platform = composeConfiguredPlugins({
  configuration,
  registry: new PluginRegistry(),
});
const service = new TklApplicationService();
const ingest: typeof service.ingest = service.ingest.bind(service);

// ARCH-106: the Jira-specific query helpers are removed from the primary 0.3 surface.
// @ts-expect-error removed in @tkl/core 0.3; use @tkl/core/legacy-jira-queries
void service.getStoryTestContext;
// @ts-expect-error removed in @tkl/core 0.3; use @tkl/core/legacy-jira-queries
void service.analyzeRequirementCoverage;
// @ts-expect-error removed in @tkl/core 0.3; use @tkl/core/legacy-jira-queries
void service.explainTraceability;
// @ts-expect-error removed in @tkl/core 0.3; use @tkl/core/legacy-jira-queries
void service.listKnowledgeConflicts;

// The deprecated compatibility adapter still declares the 0.2 helper signatures.
const legacy: DeprecatedJiraQueryAdapter = createDeprecatedJiraQueryAdapter(service, {
  emitDeprecationWarning: false,
});
const storyKey: string = legacy.getStoryTestContext("STT-3731").storyKey;
const linkedArtifacts: number = legacy.analyzeRequirementCoverage("STT-3731").linkedArtifacts;
const explained = legacy.explainTraceability("STT-3731");
const conflicts = legacy.listKnowledgeConflicts().conflicts;
const notice: string = LEGACY_JIRA_QUERY_DEPRECATION_NOTICE;

void platform.listPlugins();
void ingest;
void storyKey;
void linkedArtifacts;
void explained.links;
void conflicts;
void notice;
