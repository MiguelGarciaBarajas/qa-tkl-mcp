export class PolicyError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const CREDENTIAL_REFERENCE_PATTERN = /^(?:secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPermission(authContext, permission) {
  return authContext.permissions.includes(permission) || authContext.roles.includes("admin");
}

export function assertAuthenticated(authContext) {
  if (
    !isRecord(authContext) ||
    typeof authContext.subject !== "string" ||
    authContext.subject.length === 0
  ) {
    throw new PolicyError(401, "unauthenticated", "Authentication is required.");
  }
  if (!Array.isArray(authContext.roles) || !Array.isArray(authContext.permissions)) {
    throw new PolicyError(401, "invalid_auth_context", "The authentication context is invalid.");
  }
  if (
    authContext.tenantId !== undefined &&
    (typeof authContext.tenantId !== "string" || authContext.tenantId.length === 0)
  ) {
    throw new PolicyError(401, "invalid_auth_context", "The authentication tenant is invalid.");
  }
}

export function assertAuthorized(authContext, { permission, productId, tenantId }) {
  assertAuthenticated(authContext);

  if (!hasPermission(authContext, permission)) {
    throw new PolicyError(403, "forbidden", "The subject is not allowed to use this capability.", {
      permission
    });
  }

  if (
    !Array.isArray(authContext.productIds) ||
    (!authContext.productIds.includes("*") && !authContext.productIds.includes(productId))
  ) {
    throw new PolicyError(403, "product_access_denied", "The subject cannot access this product.", {
      productId
    });
  }
  if (
    tenantId !== undefined &&
    authContext.tenantId !== tenantId
  ) {
    throw new PolicyError(403, "tenant_access_denied", "The subject cannot access this tenant.", {
      tenantId
    });
  }
}

export function createTokenAuthenticator({
  tokenResolver = async () => undefined,
  identityAdapter = undefined
} = {}) {
  return {
    async authenticate(authorizationHeader) {
      if (typeof authorizationHeader !== "string" || !authorizationHeader.startsWith("Bearer ")) {
        throw new PolicyError(401, "unauthenticated", "A Bearer token is required.");
      }
      const token = authorizationHeader.slice("Bearer ".length).trim();
      if (!token) {
        throw new PolicyError(401, "unauthenticated", "A Bearer token is required.");
      }
      const authContext = identityAdapter
        ? await identityAdapter.authenticate(token)
        : await tokenResolver(token);
      assertAuthenticated(authContext);
      return authContext;
    }
  };
}

export function createIdentityAdapter({ verifyToken, mapClaims = (claims) => claims } = {}) {
  if (typeof verifyToken !== "function") {
    throw new TypeError("verifyToken must be a function");
  }
  return {
    async authenticate(token) {
      const claims = await verifyToken(token);
      if (!isRecord(claims)) {
        throw new PolicyError(401, "unauthenticated", "The identity token is invalid.");
      }
      const authContext = await mapClaims(claims);
      assertAuthenticated(authContext);
      return authContext;
    }
  };
}

export function createCredentialReferenceResolver({ resolve } = {}) {
  if (typeof resolve !== "function") {
    throw new TypeError("resolve must be a function");
  }
  return {
    async resolve(reference) {
      if (typeof reference !== "string" || !CREDENTIAL_REFERENCE_PATTERN.test(reference)) {
        throw new TypeError("A valid credential reference is required");
      }
      return resolve(reference);
    }
  };
}

export function createStaticTokenResolver(tokenMap) {
  if (!isRecord(tokenMap)) {
    throw new Error("tokenMap must be an object.");
  }
  return async (token) => tokenMap[token];
}
