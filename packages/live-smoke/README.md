# @tkl/live-smoke

Opt-in, sanitized live-source smoke test harness for `LIVE-101`.

## Why this exists

`LIVE-101` cannot be completed -- exercised against real Jira/GitHub/TestRail
and marked `DONE` with "approved evidence" -- until the External Decisions
Register's "approved access" entries are actually granted (see
`docs/team/TKL-Delivery-Backlog.md`). This package is the prepared harness so
the smoke test can be run the moment access is approved for any source,
without inventing credentials, approvals, or a result that never happened.

## What it does

For each of Jira, GitHub, and TestRail:

- If the source is not yet in `enabledPlugins` (still `plannedPlugins` /
  `pending-external-input` in product configuration), it is reported
  `skipped` and never attempted.
- If the source is enabled, the harness composes the real connector (via
  `@tkl/ingestion`'s `composeConnectors`, ING-104) and performs **one**
  bounded, real read -- enough to prove connectivity, authorization, and
  allowlist enforcement, never a full sync.
- The credential is resolved from an explicit environment variable,
  `LIVE_SMOKE_<SOURCE>_TOKEN` (for example `LIVE_SMOKE_GITHUB_TOKEN`). If
  that variable is not set, the harness fails closed for that source and
  names the missing variable -- it never falls back to a default or
  fabricated credential.

The emitted report contains only sanitized fields: source, status, a
records-sampled count, and the connector's own `health()` output
(`pluginId`/`status`/counts/last checkpoint). It never contains a resolved
credential value, a raw record payload, or an unsanitized error/response
body.

## Running it

```
npm run smoke:live
```

This is **never** run as part of `npm test`, `npm run test:contract`, or
`npm run test:integration`: a live network call against real third-party
systems has no place in the default CI gate (`QA-101`), and a source
skipped for lack of approved access must never be able to manufacture a
passing CI result. Run it explicitly, once you have set the relevant
`LIVE_SMOKE_*_TOKEN` variable(s) for the source(s) whose access has been
approved.

Exit code is `0` only when every enabled source either smoke-tested
successfully or was cleanly skipped as not-yet-approved; it is `1` when an
enabled source could not be reached/authorized.
