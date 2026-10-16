# Local TKL Demonstration

## Purpose

Run the real dashboard and Application API locally without production identity or cloud
infrastructure. The demonstration uses development-only, per-user TKL access tokens. Source
credentials are still entered individually through **Source Connections** and remain
encrypted on disk.

This procedure is for a trusted local demonstration only. Do not reuse its static TKL
token mechanism in a deployed environment.

## Prerequisites

- Node.js `>=22.18.0`
- Dependencies already installed with the repository lockfile
- A user-authorized source token for every provider that will be demonstrated
- The exact source hostnames that the API is allowed to contact

The pilot workspace is:

```text
Solera -> Vehicle Solutions -> TitleTec -> Titling -> FL
productId: fl-titling
```

## Terminal 1: start the API

From the repository root, run:

```powershell
$adminToken = [Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
$vaultKey = [Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
$evidenceKey = [Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)

$tokenMap = @{}
$tokenMap[$adminToken] = @{
  subject = "demo-titling-user"
  roles = @("workspace-admin")
  permissions = @(
    "knowledge:read",
    "ask:read",
    "coverage:read",
    "traceability:read",
    "conflicts:read",
    "conflicts:review",
    "connections:read",
    "connections:write",
    "connections:sync"
  )
  productIds = @("fl-titling")
  tenantId = "solera"
}

$env:NODE_ENV = "development"
$env:TKL_TENANT_ID = "solera"
$env:TKL_AUTH_TOKENS = $tokenMap | ConvertTo-Json -Compress -Depth 6
$env:TKL_CREDENTIAL_VAULT_KEY = $vaultKey
$env:TKL_RAW_EVIDENCE_KEY = $evidenceKey
$env:TKL_CREDENTIAL_VAULT_DATA_DIR = ".\data\connections"
$env:TKL_RAW_EVIDENCE_DATA_DIR = ".\data\raw"
$env:TKL_KNOWLEDGE_DATA_DIR = ".\data\knowledge"
$env:TKL_KNOWLEDGE_SQLITE_BUSY_TIMEOUT_MS = "5000"
$env:TKL_SOURCE_ALLOWED_HOSTS = "jira.example,github.example,testrail.example,confluence.example,reportportal.example"
$env:TKL_QA_BRAIN_PATH = "C:\path\to\trusted-qa-brain"

Write-Host "Copy this demo TKL token into Terminal 2: $adminToken"
npm run start --workspace @tkl/api
```

Replace the example hostnames with the exact hosts used in the demonstration. Do not use
wildcards. The generated vault and evidence keys must remain unchanged while the local
data directories are reused; changing them makes the encrypted snapshots unreadable.

`TKL_QA_BRAIN_PATH` is optional and reads only the curated allowlist under `skills/` plus
the supported workflow mapping JSON files. It is a local knowledge source, not a credentialed
connector: `.auth`, `.env`, certificates, test data, binaries, reports, logs, screenshots,
attachments, and generated artifacts are never ingested. Every accepted chunk retains its
relative path, line range or stable JSON entry ID, content hash, and source version.

## Terminal 2: start the dashboard

Copy the `$adminToken` value printed by Terminal 1:

```powershell
$env:VITE_TKL_API_BASE_URL = "http://localhost:5173"
$env:VITE_TKL_API_TOKEN = "<same-admin-token>"
$env:VITE_TKL_PRODUCT_ID = "fl-titling"
$env:TKL_API_PROXY_TARGET = "http://127.0.0.1:3000"
npm run dev --workspace @tkl/dashboard
```

Open `http://localhost:5173`. Vite proxies `/v1` and `/health` to the local API, preserving
the same-origin browser model used by the deployment architecture.

## Demonstration flow

1. Open **Source Connections**.
2. Select a source and enter its approved URL/scope plus the current user's source token.
3. Click **Connect** and verify the status changes to **Connected**.
4. Click **Test connection**. Do not start a broad synchronization.
5. Open **Investigate**, search for one exact Jira key, TestRail case ID, or
   ReportPortal identity, and review the bounded evidence retrieved on demand.
6. Review connector health, traceability, coverage, provenance, and conflicts.
7. Stop both processes with `Ctrl+C`.

The dashboard never displays a saved source credential. The TKL demo token controls access
to the local application; the Jira/GitHub/TestRail/Confluence/ReportPortal credentials
control access to those external systems.

For an authorization demonstration, generate additional tokens in `$tokenMap` with the
role bundles documented in
[`ADR-004`](../architecture/ADR-004-Organizational-Workspace-Scope.md):
`knowledge-reader`, `quality-reviewer`, and `connection-manager`. Never reuse the admin
token as a shared team credential.

## Resetting local demonstration data

Stop the API before removing data. The ignored directories are:

```text
data/connections
data/raw
data/knowledge
```

Remove only those three directories when an intentional clean demo reset is required.

If knowledge search is behind after a storage or projection failure, preserve the
knowledge database and follow
[`knowledge-serving-projections.md`](knowledge-serving-projections.md). Pending
projection work is durable and should be drained or rebuilt, not deleted manually.
