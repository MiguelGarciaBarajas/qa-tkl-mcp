# Applications

Deployable entry points:

- `api`: TKL Application API.
- `mcp-gateway`: thin, read-only MCP interface for the MVP.
- `dashboard`: connector health, traceability, gaps, conflicts, and evaluation.

Applications depend on shared packages and plugin contracts. They must not contain source
connector or normalization logic.
