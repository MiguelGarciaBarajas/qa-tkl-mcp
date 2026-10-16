import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONNECTOR_MANIFESTS,
  composeConnectors,
  registerConnectorPlugins,
} from "../src/index.js";
import { JiraConnector } from "@tkl/connector-jira";
import { GitHubConnector } from "@tkl/connector-github";
import { TestRailConnector } from "@tkl/connector-testrail";
import { ConfluenceConnector } from "@tkl/connector-confluence";
import { ReportPortalConnector } from "@tkl/connector-reportportal";
import { PluginRegistry } from "@tkl/plugin-registry";

const REAL_PRODUCT_CONFIG_PATH = fileURLToPath(
  new URL("../../../config/products/fl-titling.json", import.meta.url),
);

function readRealProductConfiguration() {
  return JSON.parse(readFileSync(REAL_PRODUCT_CONFIG_PATH, "utf8"));
}

function fixtureConfiguration(overrides = {}) {
  return {
    configVersion: "0.1",
    tenantId: "solera",
    productId: "fl-titling",
    enabledPlugins: ["connector.jira", "connector.github"],
    plannedPlugins: ["connector.testrail"],
    credentialRefs: {
      "connector.jira": "secret://jira/fl-titling",
      "connector.github": "secret://github/fl-titling",
      "connector.testrail": "secret://testrail/fl-titling",
    },
    sources: {
      jira: {
        enabled: true,
        configurationStatus: "ready",
        baseUrl: "https://jira.app.solera.com/jira",
        allowedProjects: ["FLT"],
        allowedJql: ["project = FLT ORDER BY updated DESC"],
        jql: "project = FLT ORDER BY updated DESC",
      },
      github: {
        enabled: true,
        configurationStatus: "ready",
        repository: "Solera-Engineering/qa-tkl-mcp-f5",
      },
      testrail: {
        enabled: false,
        configurationStatus: "pending-external-input",
        baseUrlEnv: "TESTRAIL_BASE_URL",
        projectIdEnv: "TESTRAIL_PROJECT_ID",
        suiteIdsEnv: "TESTRAIL_SUITE_IDS",
      },
    },
    ...overrides,
  };
}

const resolveCredential = async () => "fixture-token";
const fetchStub = async () => {
  throw new Error("no network access is expected in these tests");
};

test("registers every real connector manifest exactly once", () => {
  const registry = registerConnectorPlugins();
  assert.equal(registry.list().length, CONNECTOR_MANIFESTS.length);
  for (const manifest of CONNECTOR_MANIFESTS) {
    assert.equal(registry.get(manifest.id)?.manifest.id, manifest.id);
  }
  // Registering into an already-populated registry must not throw or duplicate entries.
  registerConnectorPlugins(registry);
  assert.equal(registry.list().length, CONNECTOR_MANIFESTS.length);
});

test("composes Confluence and ReportPortal from explicit workspace scope", () => {
  const base = fixtureConfiguration({
    enabledPlugins: ["connector.confluence", "connector.reportportal"],
    plannedPlugins: [],
  });
  const configuration = {
    ...base,
    credentialRefs: {
      ...base.credentialRefs,
      "connector.confluence": "secret://confluence/fl-titling",
      "connector.reportportal": "secret://reportportal/fl-titling",
    },
    sources: {
      ...base.sources,
      confluence: {
        enabled: true,
        configurationStatus: "ready",
        baseUrl: "https://confluence.example/wiki",
        username: "qa@example.com",
        spaceKeys: ["QA"],
      },
      reportportal: {
        enabled: true,
        configurationStatus: "ready",
        baseUrl: "https://reportportal.example",
        project: "fl_titling",
        incrementalLookbackSeconds: 300,
      },
    },
  };
  const platform = composeConnectors({
    configuration,
    dependencies: {
      "connector.confluence": { resolveCredential, fetch: fetchStub },
      "connector.reportportal": { resolveCredential, fetch: fetchStub },
    },
  });

  assert.ok(platform.getPlugin("connector.confluence") instanceof ConfluenceConnector);
  const reportportal = platform.getPlugin("connector.reportportal");
  assert.ok(reportportal instanceof ReportPortalConnector);
  assert.equal(reportportal.incrementalLookbackSeconds, 300);
});

test("composes real Jira and GitHub connectors from validated product configuration", () => {
  const configuration = fixtureConfiguration();
  configuration.sources.jira.incrementalLookbackSeconds = 600;
  configuration.sources.github.incrementalLookbackSeconds = 900;
  const platform = composeConnectors({
    configuration,
    dependencies: {
      "connector.jira": { resolveCredential, fetch: fetchStub },
      "connector.github": { resolveCredential, fetch: fetchStub },
    },
  });

  const jira = platform.getPlugin("connector.jira");
  const github = platform.getPlugin("connector.github");
  assert.ok(jira instanceof JiraConnector);
  assert.ok(github instanceof GitHubConnector);
  assert.equal(jira.productId, "fl-titling");
  assert.equal(jira.credentialRef, "secret://jira/fl-titling");
  assert.equal(jira.incrementalLookbackSeconds, 600);
  assert.equal(github.repository, "Solera-Engineering/qa-tkl-mcp-f5");
  assert.equal(github.incrementalLookbackSeconds, 900);
  assert.equal(platform.listPlugins().length, 2);
});

test("keeps each connector independently disableable through configuration only", () => {
  const registry = registerConnectorPlugins();
  let jiraCreateCalls = 0;
  const jiraRegistration = registry.get("connector.jira");
  registry.plugins.set("connector.jira", Object.freeze({
    manifest: jiraRegistration.manifest,
    create: (context) => {
      jiraCreateCalls += 1;
      return jiraRegistration.create(context);
    },
  }));

  const platform = composeConnectors({
    configuration: fixtureConfiguration({ enabledPlugins: ["connector.github"] }),
    registry,
    dependencies: {
      "connector.github": { resolveCredential, fetch: fetchStub },
    },
  });

  assert.equal(jiraCreateCalls, 0, "disabling jira must never invoke its factory");
  assert.ok(platform.getPlugin("connector.github") instanceof GitHubConnector);
  assert.equal(platform.getPlugin("connector.jira"), undefined);
});

test("never instantiates a planned/disabled connector such as testrail today", () => {
  const platform = composeConnectors({
    configuration: fixtureConfiguration(),
    dependencies: {
      "connector.jira": { resolveCredential, fetch: fetchStub },
      "connector.github": { resolveCredential, fetch: fetchStub },
    },
  });

  assert.equal(platform.getPlugin("connector.testrail"), undefined);
});

function testrailEnabledConfiguration() {
  const base = fixtureConfiguration({
    enabledPlugins: ["connector.testrail"],
    plannedPlugins: [],
  });
  return {
    ...base,
    sources: {
      ...base.sources,
      testrail: { ...base.sources.testrail, enabled: true, configurationStatus: "ready" },
    },
  };
}

test("composes a real TestRail connector once its env-indirected configuration resolves", () => {
  const platform = composeConnectors({
    configuration: testrailEnabledConfiguration(),
    dependencies: {
      "connector.testrail": {
        resolveCredential,
        fetch: fetchStub,
        env: {
          TESTRAIL_BASE_URL: "https://testrail.app.solera.com",
          TESTRAIL_PROJECT_ID: "128",
          TESTRAIL_SUITE_IDS: "1,2,3",
        },
      },
    },
  });

  const testrail = platform.getPlugin("connector.testrail");
  assert.ok(testrail instanceof TestRailConnector);
  assert.equal(testrail.projectId, "128");
  assert.deepEqual(testrail.suiteIds.sort(), ["1", "2", "3"]);
});

test("fails closed, naming the missing keys, when TestRail configuration cannot resolve", () => {
  assert.throws(
    () => composeConnectors({
      configuration: testrailEnabledConfiguration(),
      dependencies: {
        "connector.testrail": { resolveCredential, fetch: fetchStub, env: {} },
      },
    }),
    /baseUrl\/baseUrlEnv and projectId\/projectIdEnv/,
  );
});

test("keeps Jira planned until its approved allowlist is available", () => {
  const realConfiguration = readRealProductConfiguration();
  assert.equal(realConfiguration.enabledPlugins.includes("connector.jira"), false);
  assert.equal(realConfiguration.plannedPlugins.includes("connector.jira"), true);
  assert.equal(realConfiguration.sources.jira.enabled, false);
  assert.equal(realConfiguration.sources.jira.configurationStatus, "pending-external-input");
  assert.equal(realConfiguration.sources.jira.allowedProjects, undefined);
  assert.equal(realConfiguration.sources.jira.allowedJql, undefined);
});

test("composes today's real product configuration without pending connectors blocking GitHub", () => {
  const realConfiguration = readRealProductConfiguration();
  const platform = composeConnectors({
    configuration: realConfiguration,
    dependencies: {
      "connector.github": { resolveCredential, fetch: fetchStub },
    },
  });

  const github = platform.getPlugin("connector.github");
  assert.ok(github instanceof GitHubConnector);
  assert.equal(github.repository, realConfiguration.sources.github.repository);
  assert.equal(platform.getPlugin("connector.jira"), undefined);
  assert.equal(platform.getPlugin("connector.testrail"), undefined);
});

test("rejects Jira configuration that is marked ready without an allowlisted query or issue", () => {
  const withoutQuery = fixtureConfiguration();
  delete withoutQuery.sources.jira.jql;
  assert.throws(
    () => composeConnectors({
      configuration: withoutQuery,
      dependencies: {
        "connector.jira": { resolveCredential, fetch: fetchStub },
        "connector.github": { resolveCredential, fetch: fetchStub },
      },
    }),
    /must define either issueKey or jql/,
  );

  assert.throws(
    () => composeConnectors({
      configuration: fixtureConfiguration({
        sources: {
          ...fixtureConfiguration().sources,
          jira: {
            ...fixtureConfiguration().sources.jira,
            jql: "project = OTHER",
          },
        },
      }),
      dependencies: {
        "connector.jira": { resolveCredential, fetch: fetchStub },
        "connector.github": { resolveCredential, fetch: fetchStub },
      },
    }),
    /jql is not allowlisted/,
  );
});

test("normalizes Jira allowlists consistently with the connector client", () => {
  const configuration = fixtureConfiguration();
  configuration.sources.jira.allowedProjects = [" flt_qa "];
  configuration.sources.jira.allowedJql = [" project = FLT ORDER BY updated DESC "];
  configuration.sources.jira.issueKey = "flt_qa-123";
  delete configuration.sources.jira.jql;

  const platform = composeConnectors({
    configuration,
    dependencies: {
      "connector.jira": { resolveCredential, fetch: fetchStub },
      "connector.github": { resolveCredential, fetch: fetchStub },
    },
  });

  assert.ok(platform.getPlugin("connector.jira") instanceof JiraConnector);
});

test("rejects TestRail configuration without valid suite scope during composition", () => {
  const configuration = testrailEnabledConfiguration();
  configuration.sources.testrail.suiteScope = "selected";
  assert.throws(
    () => composeConnectors({
      configuration,
      dependencies: {
        "connector.testrail": {
          resolveCredential,
          fetch: fetchStub,
          env: {
            TESTRAIL_BASE_URL: "https://testrail.app.solera.com",
            TESTRAIL_PROJECT_ID: "128",
            TESTRAIL_SUITE_IDS: "",
          },
        },
      },
    }),
    /selected suite scope requires at least one positive integer suite ID/,
  );
});

test("normalizes TestRail IDs consistently with the connector", () => {
  const platform = composeConnectors({
    configuration: testrailEnabledConfiguration(),
    dependencies: {
      "connector.testrail": {
        resolveCredential,
        fetch: fetchStub,
        env: {
          TESTRAIL_BASE_URL: "https://testrail.app.solera.com",
          TESTRAIL_PROJECT_ID: " 0128 ",
          TESTRAIL_SUITE_IDS: " 012 ",
        },
      },
    },
  });
  const connector = platform.getPlugin("connector.testrail");

  assert.ok(connector instanceof TestRailConnector);
  assert.equal(connector.projectId, "128");
  assert.deepEqual(connector.suiteIds, ["12"]);
});

test("rejects a conflicting connector registration instead of preserving it", () => {
  const registry = new PluginRegistry();
  const jiraManifest = CONNECTOR_MANIFESTS.find((manifest) => manifest.id === "connector.jira");
  registry.register({
    manifest: jiraManifest,
    create: () => ({ fake: true }),
  });

  assert.throws(
    () => registerConnectorPlugins(registry),
    /already registered with a different manifest or factory/,
  );
});

test("rejects an unregistered plugin registry gracefully (does not require ingestion's own registry)", () => {
  const registry = new PluginRegistry();
  assert.throws(
    () => composeConnectors({ configuration: fixtureConfiguration(), registry }),
    /is not registered/,
  );
});
