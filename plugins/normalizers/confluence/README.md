# @tkl/normalizer-confluence

Owner: Knowledge and Traceability.

Normalizes Confluence `confluence.page` `RawEvidenceRecord`s into canonical
`requirement` entities. Only a page that explicitly carries a `requirement` label
(case-insensitive, matched against `metadata.labels.results[].name`) is normalized into
an entity and claims; every other supported page record still normalizes successfully
but produces an empty, valid result (no entities, claims, or trace links) rather than an
error, since a missing label is a legitimate "out of scope" outcome, not a malformed
payload.

Claims are limited to what the raw payload states explicitly:

- `description` -- deterministic, safe plain-text extraction from the page's
  storage-format (XHTML) body. Extraction never parses, renders, or executes the
  markup; it only strips tags and decodes a fixed, safe set of named/numeric character
  entities via string replacement.
- `label` -- one claim per page label.

This normalizer never infers a trace link to a requirement, test, or defect from a
Confluence page's content or labels.

These types come from the shared `@tkl/contracts` package. This package never calls
Confluence directly; it only consumes raw evidence emitted by
`@tkl/connector-confluence`.

## Run tests

```powershell
npm run test --workspace=@tkl/normalizer-confluence
```
