import { createPublicKey, verify as verifySignature } from "node:crypto";
import { PolicyError } from "../../policy/src/index.js";

const SUPPORTED_ALGORITHMS = new Map([
  ["RS256", "RSA-SHA256"],
  ["RS384", "RSA-SHA384"],
  ["RS512", "RSA-SHA512"],
]);
const DEFAULT_JWKS_CACHE_TTL_SECONDS = 300;
const DEFAULT_JWKS_REFRESH_COOLDOWN_SECONDS = 30;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_METADATA_LENGTH = 524_288;
const CLAIM_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configurationError(message) {
  return new Error(`Invalid production identity configuration: ${message}`);
}

function authenticationError() {
  return new PolicyError(401, "unauthenticated", "The identity token is invalid.");
}

function identityProviderUnavailable() {
  return new PolicyError(
    503,
    "identity_provider_unavailable",
    "Authentication is temporarily unavailable.",
  );
}

function requireHttpsUrl(value, field, { preserveExact = false, allowQuery = true } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configurationError(`${field} is required`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw configurationError(`${field} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || (!allowQuery && url.search)
  ) {
    throw configurationError(`${field} must be an absolute HTTPS URL without credentials or a fragment`);
  }
  return preserveExact ? value.trim() : url.toString();
}

function parsePositiveInteger(value, fallback, field) {
  if (value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw configurationError(`${field} must be a positive integer`);
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw configurationError(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseAudience(value) {
  if (typeof value !== "string") {
    throw configurationError("TKL_IDENTITY_AUDIENCE is required");
  }
  const audiences = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (
    audiences.length === 0
    || audiences.length > 20
    || audiences.some((audience) => audience.length > 512)
    || new Set(audiences).size !== audiences.length
  ) {
    throw configurationError("TKL_IDENTITY_AUDIENCE must contain unique comma-separated values");
  }
  return audiences;
}

function parseAlgorithms(value) {
  const algorithms = (value ?? "RS256").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (
    algorithms.length === 0
    || new Set(algorithms).size !== algorithms.length
    || algorithms.some((algorithm) => !SUPPORTED_ALGORITHMS.has(algorithm))
  ) {
    throw configurationError(
      `TKL_IDENTITY_ALLOWED_ALGORITHMS must contain unique supported values: ${[...SUPPORTED_ALGORITHMS.keys()].join(", ")}`,
    );
  }
  return new Set(algorithms);
}

function decodeJsonSegment(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw authenticationError();
  }
  try {
    const decoded = Buffer.from(segment, "base64url").toString("utf8");
    const value = JSON.parse(decoded);
    if (!isRecord(value)) {
      throw authenticationError();
    }
    return value;
  } catch (error) {
    if (error instanceof PolicyError) {
      throw error;
    }
    throw authenticationError();
  }
}

function parseJwt(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw authenticationError();
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw authenticationError();
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    throw authenticationError();
  }
  return {
    header: decodeJsonSegment(encodedHeader),
    payload: decodeJsonSegment(encodedPayload),
    signingInput: Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function validateAudience(actual, expected) {
  const actualAudiences =
    typeof actual === "string"
      ? [actual]
      : Array.isArray(actual) && actual.every((entry) => typeof entry === "string")
        ? actual
        : [];
  return expected.some((audience) => actualAudiences.includes(audience));
}

function validateClaims(payload, { issuer, audiences, nowSeconds, clockToleranceSeconds }) {
  if (payload.iss !== issuer || !validateAudience(payload.aud, audiences)) {
    throw authenticationError();
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw authenticationError();
  }
  if (payload.exp < nowSeconds - clockToleranceSeconds) {
    throw authenticationError();
  }
  if (
    payload.nbf !== undefined
    && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + clockToleranceSeconds)
  ) {
    throw authenticationError();
  }
  if (
    payload.iat !== undefined
    && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || payload.iat > nowSeconds + clockToleranceSeconds)
  ) {
    throw authenticationError();
  }
}

async function fetchJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw identityProviderUnavailable();
  }
  if (!response?.ok) {
    throw identityProviderUnavailable();
  }
  try {
    const declaredLength = Number.parseInt(response.headers?.get?.("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_LENGTH) {
      await response.body?.cancel?.();
      throw new Error();
    }
    let body;
    if (typeof response.body?.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalLength += value.byteLength;
        if (totalLength > MAX_METADATA_LENGTH) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks, totalLength).toString("utf8");
    } else {
      body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_METADATA_LENGTH) {
        throw new Error();
      }
    }
    const value = JSON.parse(body);
    if (!isRecord(value)) {
      throw new Error();
    }
    return value;
  } catch {
    throw identityProviderUnavailable();
  }
}

function validateJwks(value) {
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 100) {
    throw identityProviderUnavailable();
  }
  return value.keys.filter((key) => isRecord(key));
}

function selectVerificationKey(keys, { alg, kid }) {
  const matches = keys.filter(
    (key) =>
      key.kid === kid
      && key.kty === "RSA"
      && (key.use === undefined || key.use === "sig")
      && (key.alg === undefined || key.alg === alg)
      && (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))),
  );
  if (matches.length !== 1) {
    return undefined;
  }
  if (
    typeof matches[0].n !== "string"
    || Buffer.from(matches[0].n, "base64url").byteLength < 256
  ) {
    throw identityProviderUnavailable();
  }
  try {
    return createPublicKey({ key: matches[0], format: "jwk" });
  } catch {
    throw identityProviderUnavailable();
  }
}

/**
 * Creates a standards-based OIDC JWT verifier. Configuration is deployment-owned:
 * the repository does not embed an issuer, audience, key, or tenant. If no identity
 * configuration is present, this returns undefined so production startup still fails
 * closed. Partial or malformed configuration throws before the server listens.
 */
export function createIdentityVerifier({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!isRecord(env)) {
    throw new TypeError("env must be an object");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  const issuerValue = env?.TKL_IDENTITY_ISSUER;
  const audienceValue = env?.TKL_IDENTITY_AUDIENCE;
  const jwksValue = env?.TKL_IDENTITY_JWKS_URI;
  if (issuerValue === undefined && audienceValue === undefined && jwksValue === undefined) {
    return undefined;
  }
  if (typeof fetchImpl !== "function") {
    throw configurationError("a fetch implementation is required");
  }

  const issuer = requireHttpsUrl(issuerValue, "TKL_IDENTITY_ISSUER", {
    preserveExact: true,
    allowQuery: false,
  });
  const audiences = parseAudience(audienceValue);
  const configuredJwksUri =
    jwksValue === undefined ? undefined : requireHttpsUrl(jwksValue, "TKL_IDENTITY_JWKS_URI");
  const allowedAlgorithms = parseAlgorithms(env.TKL_IDENTITY_ALLOWED_ALGORITHMS);
  const cacheTtlMs =
    parsePositiveInteger(
      env.TKL_IDENTITY_JWKS_CACHE_TTL_SECONDS,
      DEFAULT_JWKS_CACHE_TTL_SECONDS,
      "TKL_IDENTITY_JWKS_CACHE_TTL_SECONDS",
    ) * 1_000;
  const refreshCooldownMs =
    parsePositiveInteger(
      env.TKL_IDENTITY_JWKS_REFRESH_COOLDOWN_SECONDS,
      DEFAULT_JWKS_REFRESH_COOLDOWN_SECONDS,
      "TKL_IDENTITY_JWKS_REFRESH_COOLDOWN_SECONDS",
    ) * 1_000;
  const clockToleranceSeconds = parsePositiveInteger(
    env.TKL_IDENTITY_CLOCK_TOLERANCE_SECONDS,
    DEFAULT_CLOCK_TOLERANCE_SECONDS,
    "TKL_IDENTITY_CLOCK_TOLERANCE_SECONDS",
  );

  let cachedKeys;
  let cachedJwksUri;
  let jwksUriExpiresAt = 0;
  let cacheExpiresAt = 0;
  let pendingKeys;
  let lastKeyFetchAt = Number.NEGATIVE_INFINITY;
  let lastKeyFetchFailureAt = Number.NEGATIVE_INFINITY;

  async function resolveJwksUri() {
    if (configuredJwksUri !== undefined) {
      return configuredJwksUri;
    }
    if (cachedJwksUri !== undefined && now() < jwksUriExpiresAt) {
      return cachedJwksUri;
    }
    const discoveryUrl = new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : `${issuer}/`);
    const metadata = await fetchJson(discoveryUrl.toString(), fetchImpl);
    if (metadata.issuer !== issuer) {
      throw identityProviderUnavailable();
    }
    try {
      cachedJwksUri = requireHttpsUrl(metadata.jwks_uri, "discovery jwks_uri");
      jwksUriExpiresAt = now() + cacheTtlMs;
      return cachedJwksUri;
    } catch {
      throw identityProviderUnavailable();
    }
  }

  async function loadKeys({ force = false } = {}) {
    const currentTime = now();
    if (!force && cachedKeys !== undefined && currentTime < cacheExpiresAt) {
      return cachedKeys;
    }
    if (pendingKeys !== undefined) {
      return pendingKeys;
    }
    if (
      force
      && cachedKeys !== undefined
      && (
        currentTime - lastKeyFetchAt < refreshCooldownMs
        || currentTime - lastKeyFetchFailureAt < refreshCooldownMs
      )
    ) {
      return cachedKeys;
    }
    if (currentTime - lastKeyFetchFailureAt < refreshCooldownMs) {
      throw identityProviderUnavailable();
    }
    const request = (async () => {
      try {
        const jwksUri = await resolveJwksUri();
        const jwks = await fetchJson(jwksUri, fetchImpl);
        const keys = validateJwks(jwks);
        cachedKeys = keys;
        lastKeyFetchAt = now();
        cacheExpiresAt = lastKeyFetchAt + cacheTtlMs;
        return keys;
      } catch (error) {
        lastKeyFetchFailureAt = now();
        throw error;
      }
    })();
    pendingKeys = request;
    try {
      return await request;
    } finally {
      if (pendingKeys === request) {
        pendingKeys = undefined;
      }
    }
  }

  return async function verifyIdentityToken(token) {
    const { header, payload, signingInput, signature } = parseJwt(token);
    if (
      typeof header.alg !== "string"
      || !allowedAlgorithms.has(header.alg)
      || typeof header.kid !== "string"
      || header.kid.length === 0
      || header.crit !== undefined
    ) {
      throw authenticationError();
    }

    validateClaims(payload, {
      issuer,
      audiences,
      nowSeconds: Math.floor(now() / 1_000),
      clockToleranceSeconds,
    });

    let keys = await loadKeys();
    let key = selectVerificationKey(keys, header);
    if (key === undefined) {
      keys = await loadKeys({ force: true });
      key = selectVerificationKey(keys, header);
    }
    if (key === undefined) {
      throw authenticationError();
    }

    const valid = verifySignature(
      SUPPORTED_ALGORITHMS.get(header.alg),
      signingInput,
      key,
      signature,
    );
    if (!valid) {
      throw authenticationError();
    }
    return payload;
  };
}

function claimName(env, variable, fallback) {
  const value = env?.[variable] ?? fallback;
  if (typeof value !== "string" || !CLAIM_NAME_PATTERN.test(value)) {
    throw configurationError(`${variable} must be a valid claim name`);
  }
  return value;
}

function collectionClaim(value, field, { splitPattern = /,/u, rejectWildcard = false } = {}) {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    value = value.split(splitPattern).map((entry) => entry.trim()).filter(Boolean);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    const normalized = value.map((entry) => entry.trim());
    if (rejectWildcard && normalized.includes("*")) {
      throw new PolicyError(
        401,
        "invalid_auth_context",
        `Verified claim "${field}" must contain explicit product identifiers, not wildcard access.`,
      );
    }
    return normalized;
  }
  throw new PolicyError(
    401,
    "invalid_auth_context",
    `Verified claim "${field}" must be a string or an array of non-empty strings.`,
  );
}

/**
 * Maps verified OIDC/Entra claims to the provider-neutral authorization contract.
 * Claim names are explicit deployment configuration and no role, permission, tenant,
 * or product access is invented when a claim is absent.
 */
export function createIdentityClaimsMapper({ env = process.env } = {}) {
  if (!isRecord(env)) {
    throw new TypeError("env must be an object");
  }
  const subjectClaim = claimName(env, "TKL_IDENTITY_SUBJECT_CLAIM", "sub");
  const rolesClaim = claimName(env, "TKL_IDENTITY_ROLES_CLAIM", "roles");
  const permissionsClaim = claimName(env, "TKL_IDENTITY_PERMISSIONS_CLAIM", "scp");
  const productsClaim = claimName(env, "TKL_IDENTITY_PRODUCTS_CLAIM", "tkl_products");
  const tenantClaim = claimName(env, "TKL_IDENTITY_TENANT_CLAIM", "tid");

  return function mapIdentityClaims(claims) {
    if (!isRecord(claims)) {
      throw authenticationError();
    }
    return {
      subject: claims[subjectClaim],
      roles: collectionClaim(claims[rolesClaim], rolesClaim),
      permissions: collectionClaim(claims[permissionsClaim], permissionsClaim, { splitPattern: /[\s,]+/u }),
      productIds: collectionClaim(claims[productsClaim], productsClaim, { rejectWildcard: true }),
      ...(claims[tenantClaim] !== undefined ? { tenantId: claims[tenantClaim] } : {}),
    };
  };
}
