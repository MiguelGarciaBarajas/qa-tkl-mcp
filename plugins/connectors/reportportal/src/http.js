const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Status-aware HTTP error. Carries only the response status, a bounded
 * retry-after hint, and a credential-free URL (path only, no query values
 * that could echo secrets). Never carries response body text or headers
 * that could leak credentials.
 */
export class ConnectorHttpError extends Error {
  constructor(message, { status, retryAfter, url } = {}) {
    super(message);
    this.name = "ConnectorHttpError";
    if (status !== undefined) this.status = status;
    if (Number.isFinite(retryAfter)) this.retryAfter = retryAfter;
    if (url !== undefined) this.url = url;
  }
}

export function normalizeBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export function isHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0 || !URL.canParse(value)) return false;
  return ["http:", "https:"].includes(new URL(value).protocol);
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHostname(hostname) {
  return typeof hostname === "string" && LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Returns true when `value` is safe to use as a credential-bearing base/API
 * URL in production: HTTPS, or (only when explicitly opted in through
 * `allowInsecureLoopback`) plain HTTP restricted to a loopback host, for
 * local development and tests only.
 */
export function isProductionSafeUrl(
  value,
  { allowInsecureLoopback = false, allowInsecureHost = false } = {},
) {
  if (!isHttpUrl(value)) return false;
  const { protocol, hostname } = new URL(value);
  if (protocol === "https:") return true;
  return protocol === "http:" && (
    allowInsecureHost === true
    || (allowInsecureLoopback === true && isLoopbackHostname(hostname))
  );
}

/**
 * Resolves an opaque pagination cursor (or any other outgoing request URL)
 * against the configured base URL and asserts it is safe to send
 * credentials to: same origin as the configured base, and HTTPS (or,
 * only when explicitly opted in, plain HTTP restricted to a loopback
 * host). This must be called, and must succeed, before any credential is
 * resolved for the request, so a malicious or malformed cursor (for
 * example an absolute cross-origin URL returned by a paginated response,
 * or replayed from an untrusted checkpoint) can never cause credentials to
 * be sent cross-origin or over plaintext HTTP.
 */
export function assertSameOriginUrl(
  candidate,
  baseUrl,
  { allowInsecureLoopback = false, allowInsecureHost = false } = {},
) {
  let base;
  let resolved;
  try {
    base = new URL(baseUrl);
    resolved = new URL(candidate, base);
  } catch {
    throw new TypeError("Request URL must be a valid URL");
  }
  const secureScheme = resolved.protocol === "https:"
    || (allowInsecureHost === true && resolved.protocol === "http:")
    || (allowInsecureLoopback === true && resolved.protocol === "http:" && isLoopbackHostname(resolved.hostname));
  if (!secureScheme || resolved.origin !== base.origin) {
    throw new TypeError("Request URL must be HTTPS and same-origin as the configured base URL");
  }
  return resolved.toString();
}

/**
 * Resolves a credential reference (for example "secret://jira/fl-titling")
 * to the raw secret value through an injected resolver function. The
 * resolved value is never logged, cached beyond the current call, or
 * attached to thrown errors.
 */
export async function resolveCredentialValue(resolveCredential, credentialRef) {
  if (typeof resolveCredential !== "function") {
    throw new TypeError("A credential resolver function is required");
  }
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    throw new TypeError("credentialRef is required to resolve a credential");
  }
  const value = await resolveCredential(credentialRef);
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Credential resolver returned an invalid value");
  }
  return value;
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Performs a single JSON HTTP request using an injected fetch implementation,
 * bounding the call with an AbortController timeout. Errors expose only the
 * status code, a bounded retry-after hint, and a query-free URL; the
 * response body and request headers (which may hold credentials) are never
 * attached to the thrown error.
 */
export async function requestJson({
  fetchImpl,
  url,
  method = "GET",
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  try {
    let response;
    try {
      response = await fetchImpl(url, { method, headers, signal: requestSignal });
    } catch {
      signal?.throwIfAborted();
      throw new ConnectorHttpError(
        controller.signal.aborted ? "Request timed out" : "Network request failed",
        { url: safeUrl(url) },
      );
    }

    if (!response.ok) {
      const retryAfterHeader = typeof response.headers?.get === "function"
        ? response.headers.get("retry-after")
        : null;
      const retryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined;
      throw new ConnectorHttpError(`Request failed with status ${response.status}`, {
        status: response.status,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
        url: safeUrl(url),
      });
    }

    let text;
    try {
      text = await response.text();
    } catch {
      signal?.throwIfAborted();
      throw new ConnectorHttpError(
        controller.signal.aborted ? "Request timed out" : "Network request failed",
        { status: response.status, url: safeUrl(url) },
      );
    }
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new ConnectorHttpError("Response body was not valid JSON", {
        status: response.status,
        url: safeUrl(url),
      });
    }
  } finally {
    // The timeout must stay armed through body consumption/parsing above,
    // not just through the initial fetch call, so a slow or hanging body
    // read is still bounded. Clear it exactly once here, on every path.
    clearTimeout(timer);
  }
}
