import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Imports the *package entry point* (the bare `@tkl/credential-vault`
// specifier resolved through package.json `exports`), not a relative
// `./store.ts` path — this exercises what a real connector/consumer would
// actually import, catching any drift between `src/index.js`'s re-exports
// and the package's real public surface.
import {
  InMemoryCredentialVault,
  createPersistentCredentialVault,
} from "@tkl/credential-vault";

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "tkl-credential-vault-entry-"));
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("the package entry point exports a working InMemoryCredentialVault", async () => {
  const store = new InMemoryCredentialVault({ tenantId: "solera", productId: "fl-titling" });
  const metadata = await store.upsertConnection({
    tenantId: "solera",
    productId: "fl-titling",
    source: "jira",
    ownerSubject: "qa-lead@example.com",
    config: { baseUrl: "https://jira.example.com" },
    credential: "super-secret-token",
  });

  assert.equal(metadata.status, "validating");
  assert.equal("credential" in metadata, false);
  assert.equal(await store.resolveCredential("solera", "fl-titling", "jira"), "super-secret-token");
});

test("the package entry point exports a working createPersistentCredentialVault that survives a restart", () =>
  withTemporaryDirectory(async (directory) => {
    const key = randomBytes(32);
    const resolveKey = () => key;

    const store = await createPersistentCredentialVault({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: "secret://credential-vault/fl-titling",
      resolveKey,
    });
    await store.upsertConnection({
      tenantId: "solera",
      productId: "fl-titling",
      source: "github",
      ownerSubject: "qa-lead@example.com",
      config: { repositories: ["org/repo"] },
      credential: "gh-token",
    });

    const restarted = await createPersistentCredentialVault({
      dataDirectory: directory,
      tenantId: "solera",
      productId: "fl-titling",
      keyRef: "secret://credential-vault/fl-titling",
      resolveKey,
    });
    assert.equal(restarted.list("solera", "fl-titling").length, 1);
    assert.equal(await restarted.resolveCredential("solera", "fl-titling", "github"), "gh-token");
  }));
