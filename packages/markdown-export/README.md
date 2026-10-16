# @tkl/markdown-export

Owner: Josue Misael Torres (Knowledge and Traceability).

Renders canonical knowledge to Markdown for human review/export. Per ADR-001, Markdown
is a generated artifact of *approved* canonical knowledge only — never the operational
source of truth. `renderEntityToMarkdown` refuses to render an entity that has no
approved claims and silently omits pending/rejected claims.

`renderApprovedTestRailKnowledgeToMarkdown` produces a deterministic combined export
for approved TestRail suites, manual cases, runs, and results. Entities with only
pending or rejected claims are omitted.

## Run tests

```powershell
npm run test --workspace=@tkl/markdown-export
```
