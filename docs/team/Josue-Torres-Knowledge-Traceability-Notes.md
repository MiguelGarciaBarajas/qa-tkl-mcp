# Knowledge and Traceability — Implementation Notes

Owner: Josue Misael Torres.

## Purpose

This note documents what has been built for the Knowledge and Traceability workstream,
the assumptions made to avoid blocking on other workstreams, and open items that need
sign-off from other contract owners before this code is considered final.

## What exists

| Package | Role |
|---|---|
| `packages/knowledge-store` | Canonical entity/claim/trace-link/conflict types + in-memory `KnowledgeStore` reference implementation |
| `plugins/normalizers/jira` | `RawEvidenceRecord` (Jira story) -> `requirement` entity + claims |
| `plugins/normalizers/github` | `RawEvidenceRecord` (GitHub PR) -> `test` entity + `verifies` trace link |
| `plugins/analyzers/coverage` | Requirement coverage: numerator, denominator, link confidence |
| `plugins/analyzers/conflicts` | Detects and persists open conflicts between disagreeing claims |
| `packages/markdown-export` | Renders Markdown from *approved* claims only; refuses entities with none |
| `tests/fixtures/jira`, `tests/fixtures/github` | Sanitized sample `RawEvidenceRecord`s used by unit/contract tests |
| `tests/contract/knowledge-traceability.contract.test.ts` | End-to-end vertical slice using only this workstream's own components |

The packages use Node 22+'s native TypeScript execution and built-in test runner
(`node --test`). They now integrate with the approved `@tkl/contracts`, core,
connector, API, and MCP workspaces merged from the first platform PR. Run any package's
tests with:

```powershell
npm run test --workspace=@tkl/<package-name>
```

Run the full workstream + vertical slice with:

```powershell
npm run test --workspaces --if-present
npm run test:contract
```

## Integration status and remaining assumptions

1. **Approved shared contracts**: the normalizers now call
   `@tkl/contracts/assertRawEvidenceRecord`, package manifests depend on
   `@tkl/contracts`, and package entry points preserve the approved JavaScript API. The
   shared package now exports the typed domain model, and the former
   `packages/knowledge-store/src/contracts.local.ts` mirror has been removed.
2. **Approved connector payloads**: Jira normalization supports the connector's flattened
   `jira.issue` payload as well as the earlier nested fixture shape. GitHub normalization
   supports the connector's `ticketKey` relation and the earlier `referencedIssues`
   fixture. Tests cover both shapes.
3. **Knowledge-store compatibility**: the in-memory store supports both the approved
   core service methods (`upsert`, `findBySource`, `findLinks`, `conflicts`) and the
   Knowledge and Traceability query methods used by analyzers and Markdown export.
4. **Coverage definition**: numerator = count of `verifies` trace links (capped at the
   acceptance-criteria count), denominator = count of acceptance-criteria claims. This is
   a starting definition, not a final one — open to review once Clemente Herrera's golden
   dataset is available to validate precision/recall.
5. **Conflict detection**: currently only flags claims on the *same entity* with the
   *same attribute* but different values. Cross-entity or cross-source conflicts are out
   of scope for this first pass.

## Explicitly out of scope here (owned elsewhere)

- Fetching from Jira/GitHub APIs (Jorge Santiago).
- Any persistent `KnowledgeStore` backend — the in-memory implementation is for tests and
  early integration only, not production storage.
- Exposing this data via the TKL Application API or MCP gateway (Carlos Ramirez).
- Dashboard rendering of coverage/conflict/traceability views (Clemente Herrera).
