# @tkl/normalizer-github

Owner: Josue Misael Torres (Knowledge and Traceability).

Normalizes GitHub `RawEvidenceRecord`s (pull requests) into canonical `test` entities and
`verifies` trace links back to the Jira requirements they reference. Consumes only the
shared `RawEvidenceRecord` shape produced by Jorge Santiago's connector — never calls the
GitHub API directly.

## Run tests

```powershell
npm run test --workspace=@tkl/normalizer-github
```
