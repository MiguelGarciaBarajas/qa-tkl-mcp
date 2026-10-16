# @tkl/ingestion

Config-driven registration and composition of the real source connectors (`ING-104`,
owned by the Source Ingestion workstream).

Before this package existed, the source connector packages were production-ready but
not all registered into
the plugin registry/composition root (`@tkl/plugin-registry`, `@tkl/core`, ARCH-104), so
nothing in the repository ever turned validated product configuration
(`config/products/*.json`, ARCH-103) into real connector instances.

## What this provides

- `registerConnectorPlugins(registry?)` — registers the five real connector manifests
  (`connector.jira`, `connector.github`, `connector.testrail`,
  `connector.confluence`, and `connector.reportportal`) with factories that build
  the real HTTP client + connector class from a product's `sources.<id>` configuration.
- `composeConnectors({ configuration, registry?, dependencies })` — thin wrapper over
  `@tkl/core`'s `composeConfiguredPlugins` using the registry above.

Only connectors listed in a product's `enabledPlugins` are ever instantiated; anything
left in `plannedPlugins`, or simply omitted, is never instantiated and its factory is
never invoked. This means each connector is independently disableable purely through
configuration — no code change required.

## What this does not do

- It does not invent configuration. Jira's `allowedProjects`/`allowedJql` and GitHub's
  repository allowlist must already be present in `sources.<id>`; if they are missing
  the corresponding factory fails closed with a specific error naming the missing keys
  instead of guessing or using a permissive default. The checked-in FL Titling
  configuration therefore keeps Jira planned/disabled until its allowlists are approved,
  allowing the independently configured GitHub connector to compose normally.
- It does not publish partially valid connectors. Jira query/issue scope and TestRail
  project/suite identifiers are checked during composition, before a platform is returned.
- It does not resolve credentials itself. `dependencies.resolveCredential` must be
  supplied by the caller (SEC-101 defines the provider-neutral boundary; the concrete
  secret provider is OPS-102, not yet built).
- It does not schedule or run ingestion. Turning composed connectors into a scheduled
  sync loop with durable checkpoints is `OPS-101`.

## TestRail

Per `config/README.md` ("TestRail Phase 2"), TestRail's `baseUrl` and `projectId`
can be resolved indirectly through named environment variables. `suiteScope` defaults
to `all`, which ingests every current and future suite in the project. A `selected`
scope requires explicit `suiteIds` and is intended only for shared projects. Today's
real product configuration keeps `connector.testrail` in `plannedPlugins` with
`configurationStatus: "pending-external-input"`, so it is never composed.
