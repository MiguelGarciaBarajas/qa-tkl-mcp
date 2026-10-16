# ADR-004: Organizational and Workspace Scope

- **Status:** Accepted for the MVP pilot
- **Date:** 2026-09-13
- **Decision owners:** TKL Project Team

## Context

TKL users belong to organizational teams. Solera has business verticals, each vertical
contains products and teams, and a product can contain subproducts. For the TitleTec
pilot, the known hierarchy is:

```text
Tenant: Solera
  Vertical: Vehicle Solutions
    Product: TitleTec
      Team: Titling
        Subproducts/workspaces:
          GA, VA, MD, Giada, FL, SC, PA, NAT, ELT
```

Some TitleTec capabilities are API automation surfaces rather than state web
applications. The complete enterprise hierarchy, including the unconfirmed fourth
vertical, must come from an approved organizational source and must not be guessed.

The current contracts authorize by `tenantId` and `productId`. They do not yet contain
separate vertical, team, product, and subproduct identifiers.

## Decision

For the MVP:

1. A TKL user is authenticated separately from source-system credentials.
2. The user's TKL authorization assigns one or more workspace IDs through `productIds`.
3. A workspace represents the smallest isolated quality-knowledge scope. During the
   pilot, `fl-titling` represents the TitleTec FL workspace owned by the Titling team.
4. Source credentials are submitted by an authorized connection owner for one workspace.
   Other authorized workspace members consume the synchronized knowledge; they never
   receive or read back that credential.
5. Demo access uses development-only opaque TKL tokens mapped to named users, permissions,
   and workspace IDs. Possessing a Jira or GitHub token alone does not grant access to TKL.
6. Production must replace development tokens with corporate identity and team/workspace
   assignments.

## Access roles

Tokens do not have different formats for users and administrators. Every person receives
an individual TKL token or identity session; its mapped role and permissions determine
what that person can do.

The MVP uses four workspace roles:

| Role | Purpose | Permissions |
|---|---|---|
| `knowledge-reader` | Search and analyze approved workspace knowledge | `knowledge:read`, `coverage:read`, `traceability:read`, `conflicts:read` |
| `quality-reviewer` | Reader who can approve conflict resolutions | Reader permissions plus `conflicts:review` |
| `connection-manager` | Configure and run approved source connections | `connections:read`, `connections:write`, `connections:sync`, plus reader permissions |
| `workspace-admin` | Trusted workspace owner for the local demo and exceptional administration | All current workspace permissions, limited to explicitly assigned workspace IDs |

Infrastructure operators are not a fifth application superuser role. They operate the
runtime, keys, backups, and logs, but should not automatically receive access to product
knowledge or source credentials.

Each user must have an individual identity. Shared team/admin tokens are prohibited
outside a tightly controlled demonstration because they remove attribution from reviews,
connection changes, and audit events.

## Target model

The post-MVP authorization/catalog model should represent:

```text
Tenant -> Vertical -> Product -> Team -> Workspace/Subproduct
```

Users are assigned to teams and granted explicit workspace roles. Source connections,
raw evidence, canonical knowledge, reviews, and sync checkpoints remain isolated at the
workspace boundary.

Suggested stable identifiers should be lowercase and explicit, for example:

- `vehicle-solutions`
- `titletec`
- `titling`
- `titletec-fl`
- `titletec-nat`
- `titletec-elt`

The existing `fl-titling` ID remains valid for the pilot. Renaming it requires a planned
data/configuration migration and must not be done as an undocumented string replacement.

## Consequences

- The local demonstration can assign attendees to the FL workspace without corporate
  identity integration.
- Personal source tokens and TKL access tokens remain different credentials.
- A team member can query workspace knowledge without learning another member's source
  token.
- Full organization browsing and team administration remain a versioned post-MVP
  capability.
