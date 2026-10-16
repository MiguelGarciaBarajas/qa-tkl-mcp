# @tkl/normalizer-reportportal

Owner: Knowledge and Traceability.

Normalizes ReportPortal `reportportal.launch` and `reportportal.test_item` `RawEvidenceRecord`s
into canonical `test-execution` entities using stable provider IDs
(`test-execution:reportportal:launch:{id}` / `test-execution:reportportal:item:{id}`).

Claims are limited to what each payload states explicitly: `name`, `status`, `startedAt`,
`endedAt`, `duration`, and, for test items, `launchId`, `codeRef`, `retry`, `issueType`, and
`externalIssues`. Version `0.2.0` also preserves sanitized test-item `attributes` so
reliability timelines can display synchronized environment, browser, node, or runner context.
Attribute presence is context only and never independently classifies an environment failure.
A `contains` trace link connects a launch entity to each of its test item entities.

A canonical `defect` entity and a `relates_to` trace link from the test item to it are created
**only** when the payload includes an explicit external issue identity (a non-empty `ticketId`
under `issue.externalSystemIssues`). A `FAILED` status or an `issue.issueType` classification
alone never creates a defect entity -- that would be an inference this normalizer must not make.

No raw logs are consumed and no flakiness/root-cause analysis is performed or inferred; this
package only maps evidence that is already explicit in the raw payload.

These types come from the shared `@tkl/contracts` package. This package never calls
ReportPortal directly; it only consumes raw evidence emitted by
`@tkl/connector-reportportal`.

## Run tests

```powershell
npm run test --workspace=@tkl/normalizer-reportportal
```
