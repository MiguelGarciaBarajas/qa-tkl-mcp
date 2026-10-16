# TKL Observability

This package provides structured audit events for the Application API and MCP gateway.
Events include a correlation ID, operation, subject when known, product when known,
outcome, status, and duration. Sensitive-looking keys such as authorization, token,
secret, password, credential, and API key are recursively redacted before reaching the
sink.

The sink is injected so deployments can connect approved observability infrastructure
without coupling application code to a vendor. Audit sink failures are surfaced to the
caller rather than silently discarded.

`createHealthRegistry()` correlates health/metrics reported by connectors, the
application composition, the API, and the MCP gateway into a single redacted report
(`{ correlationId, status, components }`). Each caller calls `record(component, health)`
with an already-computed health snapshot (for example a connector's `health()` result);
the registry never calls a source system itself, it only aggregates values it is given.
`report()` derives an overall `healthy`/`degraded`/`unknown` status from the recorded
components. The API's `GET /health` and the MCP gateway's `health()` both use this
registry so operators can correlate status across the stack from one shared shape.
