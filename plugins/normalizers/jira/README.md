# @tkl/normalizer-jira

Owner: Josue Misael Torres (Knowledge and Traceability).

Normalizes Jira `RawEvidenceRecord`s (stories) into canonical `requirement` entities and
claims (description, acceptance criteria). Consumes only the shared `RawEvidenceRecord`
shape produced by Jorge Santiago's connector — never calls the Jira API directly.

## Run tests

```powershell
npm run test --workspace=@tkl/normalizer-jira
```
