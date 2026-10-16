# @tkl/normalizer-testrail

Owner: Josue Misael Torres (Knowledge and Traceability).

Normalizes TestRail `RawEvidenceRecord`s into canonical `test-suite`, `manual-test`, and
`test-execution` entities. A valid case without `suite_id` is still normalized as a manual
test, but it creates a `contains` trace link only when its payload explicitly provides
that identifier; membership is never inferred from titles or collection order.
Case normalization also retains well-formed `custom_preconds`, `custom_steps_separated`
(`content` and `expected`), and `custom_expected` values as explicit provenance-backed
claims so read-only quality agents can inspect current case detail.

Runs and results are normalized as test-execution entities. Result status IDs are preserved as
explicit claims, but their business meaning is `unknown` until FL Titling QA/product
owners approve the status mapping. Run-to-result and manual-test-to-result links are created
only when raw payloads provide explicit `run_id` and `case_id` values.

These types come from the shared `@tkl/contracts` package delivered in `ARCH-101`. This
package never calls TestRail directly; it only consumes raw evidence emitted by the
Source Ingestion workstream.

## Run tests

```powershell
npm run test --workspace=@tkl/normalizer-testrail
```
