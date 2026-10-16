import test from "node:test";
import assert from "node:assert/strict";
import {
  PolicyError,
  assertAuthorized,
  createCredentialReferenceResolver,
  createIdentityAdapter,
  createStaticTokenResolver,
  createTokenAuthenticator
} from "../src/index.js";

const reader = {
  subject: "carlos",
  roles: ["reader"],
  permissions: ["knowledge:read"],
  productIds: ["fl-titling"]
};

test("authorizes a subject for an assigned product", () => {
  assert.doesNotThrow(() =>
    assertAuthorized(reader, { permission: "knowledge:read", productId: "fl-titling" })
  );
});

test("denies access to an unassigned product", () => {
  assert.throws(
    () => assertAuthorized(reader, { permission: "knowledge:read", productId: "other" }),
    (error) => error instanceof PolicyError && error.code === "product_access_denied"
  );
});

test("enforces tenant isolation when both sides provide tenant context", () => {
  assert.throws(
    () => assertAuthorized({ ...reader, tenantId: "tenant-a" }, {
      permission: "knowledge:read",
      productId: "fl-titling",
      tenantId: "tenant-b"
    }),
    (error) => error instanceof PolicyError && error.code === "tenant_access_denied"
  );
});

test("requires tenant context when authorization is tenant-scoped", () => {
  assert.throws(
    () => assertAuthorized(reader, {
      permission: "knowledge:read",
      productId: "fl-titling",
      tenantId: "tenant-a"
    }),
    (error) => error instanceof PolicyError && error.code === "tenant_access_denied"
  );
});

test("adapts verified identity claims into an authorization context", async () => {
  const authenticator = createTokenAuthenticator({
    identityAdapter: createIdentityAdapter({
      verifyToken: async (token) => ({ sub: token, roles: ["reader"], permissions: ["knowledge:read"], productIds: ["fl-titling"] }),
      mapClaims: (claims) => ({
        subject: claims.sub,
        roles: claims.roles,
        permissions: claims.permissions,
        productIds: claims.productIds
      })
    })
  });
  assert.equal((await authenticator.authenticate("Bearer verified-token")).subject, "verified-token");
});

test("rejects invalid credential references before resolution", async () => {
  const resolver = createCredentialReferenceResolver({ resolve: async () => "secret-value" });
  await assert.rejects(resolver.resolve("raw-token"), /valid credential reference/);
  assert.equal(await resolver.resolve("secret://vault/tkl"), "secret-value");
});

test("authenticates bearer tokens through an injected resolver", async () => {
  const authenticator = createTokenAuthenticator({
    tokenResolver: createStaticTokenResolver({ token: reader })
  });
  assert.deepEqual(await authenticator.authenticate("Bearer token"), reader);
});
