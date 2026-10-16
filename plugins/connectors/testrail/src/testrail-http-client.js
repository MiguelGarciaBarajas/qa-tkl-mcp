import {
  ConnectorHttpError,
  assertSameOriginUrl,
  isHttpUrl,
  isProductionSafeUrl,
  normalizeBaseUrl,
  requestJson,
  resolveCredentialValue,
} from "./http.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 250;

function isPositiveIntegerId(value) {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (!/^\d+$/.test(text)) return false;
  return BigInt(text) > 0n;
}

function operationKey(method) {
  return `/api/v2/${method}`;
}

const OPERATION_MISMATCH_MESSAGE = "Request URL does not match the expected TestRail API operation";

/**
 * Pagination parameters that may be carried forward from a `_links.next`
 * cursor. These are positional only -- they can never widen or redirect the
 * scope of a request (that is decided entirely by the operation segment and
 * the scope parameters, both of which are re-applied from trusted,
 * caller-validated values) -- and each is still validated as a bounded
 * integer before it is reused.
 */
function parseNonNegativeInteger(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Creates a dependency-free TestRail REST API v2 HTTP client. Credentials
 * are resolved per-request through the injected `resolveCredential`
 * function and are never stored on the client instance, logged, or embedded
 * in returned data or thrown errors. `resolveCredential` must return the
 * pre-encoded HTTP Basic Auth token (the base64 encoding of
 * `email:api_key`), so this module never needs to perform base64 encoding
 * of a secret itself.
 *
 * Pagination follows TestRail's native `offset`/`limit` API: paginated
 * endpoints (`get_cases`, `get_runs`, `get_results_for_run`) return a
 * `_links.next` URL that is carried as the next opaque page cursor.
 * TestRail's real responses emit that link in the vendor-relative form
 * `/api/v2/get_cases/128&limit=250&offset=250` (the API-router
 * pseudo-path *without* the `/index.php?` prefix that an actual request
 * needs), so a cursor is normalized back into
 * `${baseUrl}/index.php?${cursor}` before use. A cursor is never trusted
 * for scope: only its `offset`/`limit` are carried forward (each validated
 * as a bounded non-negative integer), while the operation segment and every
 * scope parameter (`suite_id`) are re-applied from the caller's own
 * already-validated identifiers, and the rebuilt URL is then re-validated
 * for same-origin, operation, and scope before any credential is resolved.
 * `get_suites` is not paginated by TestRail and always returns a single
 * page.
 */
export function createTestRailHttpClient({
  fetch: fetchImpl = globalThis.fetch,
  baseUrl,
  credentialRef,
  resolveCredential,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  allowInsecureLoopback = false,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!isHttpUrl(normalizedBaseUrl)) throw new TypeError("baseUrl must be a valid HTTP(S) URL");
  if (!isProductionSafeUrl(normalizedBaseUrl, { allowInsecureLoopback })) {
    throw new TypeError(
      "baseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
      + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
    );
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (typeof resolveCredential !== "function") throw new TypeError("A credential resolver function is required");
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    throw new TypeError("credentialRef is required");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new TypeError("pageSize must be a positive integer");

  function buildOperationUrl(expectedOperationKey, params) {
    const query = Object.entries(params ?? {})
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return `${normalizedBaseUrl}/index.php?${expectedOperationKey}${query ? `&${query}` : ""}`;
  }

  function buildUrl(method, params) {
    return buildOperationUrl(operationKey(method), params);
  }

  const indexPhpPathname = new URL(`${normalizedBaseUrl}/index.php`).pathname;

  /**
   * Normalizes a `_links.next` link (or a cursor replayed from a
   * checkpoint) into an absolute URL string, *without* granting it any
   * trust: the result is still same-origin/operation/scope validated (and
   * rebuilt from trusted values) by `rebuildCursorRequestUrl` before it is
   * ever requested.
   *
   * Three shapes are handled, because real TestRail deployments emit the
   * first and this client's own returned cursors are the second:
   *
   * 1. `"/api/v2/get_cases/128&limit=250&offset=250"` -- the documented
   *    TestRail 6.7+ `_links.next` form. It is the API-router pseudo-path
   *    only, with no `/index.php?` prefix, so resolving it as an ordinary
   *    relative URL would produce `${origin}/api/v2/...` -- a path that is
   *    not the TestRail API entry point at all and that scope validation
   *    would (correctly, but uselessly) reject, breaking every real
   *    paginated sync. Rebuilt here as `${baseUrl}/index.php?${cursor}`.
   * 2. `"/index.php?/api/v2/get_cases/128&limit=250&offset=250"` -- the
   *    already-prefixed form; resolved against the base URL as before.
   * 3. An absolute `http(s)://...` URL -- returned unchanged so the
   *    same-origin check (not this function) decides whether it is
   *    acceptable; a cross-origin or plaintext cursor must still fail
   *    loudly rather than be silently rewritten to look safe.
   */
  function resolveNextUrl(link) {
    if (typeof link !== "string") return undefined;
    const trimmed = link.trim();
    if (trimmed.length === 0) return undefined;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const withoutLeadingQuestionMark = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    if (/^\/?api\/v2\//.test(withoutLeadingQuestionMark)) {
      const pseudoPath = withoutLeadingQuestionMark.startsWith("/")
        ? withoutLeadingQuestionMark
        : `/${withoutLeadingQuestionMark}`;
      return `${normalizedBaseUrl}/index.php?${pseudoPath}`;
    }
    return trimmed.startsWith("/") ? `${normalizedBaseUrl}${trimmed}` : `${normalizedBaseUrl}/${trimmed}`;
  }

  /**
   * Turns an opaque page cursor into the next request URL, rebuilt from
   * trusted values. The cursor is authenticated first (same-origin +
   * HTTPS/loopback, the TestRail API entry pathname, and an operation
   * segment identical to the one the caller asked for), and any scope
   * parameter it *does* carry must match the caller's own identifier
   * exactly -- a cursor that switches project, suite, run, or operation is
   * rejected, never silently corrected. Only then is the URL rebuilt:
   * `${baseUrl}/index.php?${trusted operation}` plus the caller's trusted
   * scope parameters plus the cursor's validated `offset`/`limit`.
   *
   * Rebuilding (rather than forwarding the cursor verbatim) matters for two
   * reasons. TestRail legitimately *omits* scope parameters from
   * `_links.next` -- the documented `get_cases` link carries only
   * `limit`/`offset`, not the `suite_id` the original request was scoped to
   * -- so a verbatim cursor would drop the suite scope and silently widen
   * the query to the whole project. And any parameter the cursor adds that
   * this client did not itself send is dropped rather than forwarded, so a
   * tampered or malformed link can never smuggle extra filters into a
   * credentialed request.
   */
  function rebuildCursorRequestUrl(cursor, expectedOperationKey, scopeParams, paginationDefaults) {
    const safeUrl = assertSameOriginUrl(
      // Normalize first: a cursor may arrive raw from a durable checkpoint
      // in any of the shapes TestRail emits, not only pre-resolved from a
      // response this client just read.
      resolveNextUrl(cursor) ?? cursor,
      normalizedBaseUrl,
      { allowInsecureLoopback },
    );
    const parsed = new URL(safeUrl);
    if (parsed.pathname !== indexPhpPathname) throw new TypeError(OPERATION_MISMATCH_MESSAGE);
    const rawQuery = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
    const [operationSegment, ...restSegments] = rawQuery.split("&");
    if (operationSegment !== expectedOperationKey) throw new TypeError(OPERATION_MISMATCH_MESSAGE);

    const cursorParams = new URLSearchParams(restSegments.join("&"));
    for (const [key, value] of Object.entries(scopeParams ?? {})) {
      const carried = cursorParams.get(key);
      if (carried !== null && carried !== String(value)) throw new TypeError(OPERATION_MISMATCH_MESSAGE);
    }

    const offset = parseNonNegativeInteger(cursorParams.get("offset"));
    if (offset === null) throw new TypeError("Pagination cursor offset must be a non-negative integer");
    const limit = parseNonNegativeInteger(cursorParams.get("limit"));
    if (limit === null || limit === 0) throw new TypeError("Pagination cursor limit must be a positive integer");

    return buildOperationUrl(expectedOperationKey, {
      ...scopeParams,
      offset,
      // The server may cap `limit` below what was asked for; never page with
      // more than this client's own configured page size either way.
      limit: limit === undefined ? paginationDefaults?.limit : Math.min(limit, pageSize),
    });
  }

  /**
   * Confirms a resolved (same-origin) request URL still targets the exact
   * TestRail operation and resource IDs the caller requested. TestRail's
   * REST API v2 encodes the operation and its positional ID as a
   * pseudo-path segment inside the query string (for example
   * `?/api/v2/get_cases/128`), with any further identifying scope --
   * `suite_id` for `get_cases` -- carried as an ordinary query parameter.
   * Same-origin alone would let a tampered `_links.next` cursor (or a
   * replayed/forged checkpoint) silently swap to a different project,
   * suite, or run while still resolving to the configured TestRail host, so
   * this check must run, and must succeed, before any credential is
   * resolved for the request.
   */
  function assertMatchesOperation(url, expectedOperationKey, requiredParams = {}) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError("Request URL must be a valid URL");
    }
    if (parsed.pathname !== indexPhpPathname) {
      throw new TypeError("Request URL does not match the expected TestRail API operation");
    }
    const rawQuery = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
    const [operationSegment, ...restSegments] = rawQuery.split("&");
    if (operationSegment !== expectedOperationKey) {
      throw new TypeError("Request URL does not match the expected TestRail API operation");
    }
    const params = new URLSearchParams(restSegments.join("&"));
    for (const [key, value] of Object.entries(requiredParams)) {
      if (params.get(key) !== String(value)) {
        throw new TypeError("Request URL does not match the expected TestRail API operation");
      }
    }
  }

  async function authorizedGet(url, expectedOperationKey, requiredParams, { signal } = {}) {
    // Every outgoing URL -- freshly built or an opaque `_links.next` cursor
    // resumed from a prior response or a checkpoint -- must be validated as
    // HTTPS and same-origin with the configured baseUrl *before* resolving
    // the credential, so TestRail (or a tampered checkpoint) can never
    // redirect credentials to a different origin.
    const safeUrl = assertSameOriginUrl(url, normalizedBaseUrl, { allowInsecureLoopback });
    assertMatchesOperation(safeUrl, expectedOperationKey, requiredParams);
    signal?.throwIfAborted();
    const token = await resolveCredentialValue(resolveCredential, credentialRef);
    signal?.throwIfAborted();
    return requestJson({
      fetchImpl,
      url: safeUrl,
      headers: { Authorization: `Basic ${token}`, Accept: "application/json" },
      timeoutMs,
      signal,
    });
  }

  async function authorizedPost(
    url,
    expectedOperationKey,
    requiredParams,
    payload,
    { signal } = {},
  ) {
    const safeUrl = assertSameOriginUrl(url, normalizedBaseUrl, { allowInsecureLoopback });
    assertMatchesOperation(safeUrl, expectedOperationKey, requiredParams);
    signal?.throwIfAborted();
    const token = await resolveCredentialValue(resolveCredential, credentialRef);
    signal?.throwIfAborted();
    return requestJson({
      fetchImpl,
      url: safeUrl,
      method: "POST",
      headers: {
        Authorization: `Basic ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs,
      signal,
    });
  }

  async function paginatedFetch(
    page,
    buildInitialUrl,
    itemsKey,
    expectedOperationKey,
    scopeParams,
    paginationDefaults,
    signal,
  ) {
    const url = typeof page === "string" && page.trim().length > 0
      ? rebuildCursorRequestUrl(page, expectedOperationKey, scopeParams, paginationDefaults)
      : buildInitialUrl();
    const body = await authorizedGet(url, expectedOperationKey, scopeParams, { signal });
    const items = Array.isArray(body) ? body : (Array.isArray(body?.[itemsKey]) ? body[itemsKey] : []);
    const nextPage = Array.isArray(body) ? undefined : resolveNextUrl(body?._links?.next);
    return { items, nextPage };
  }

  return {
    // Exposed so the connector can build evidence `sourceUrl` links from
    // this client's own explicitly-validated `baseUrl` instead of a
    // hard-coded host, without needing to re-validate it (it was already
    // checked above for HTTPS/loopback safety at construction time).
    baseUrl: normalizedBaseUrl,

    async fetchCase(caseId, { signal } = {}) {
      if (!isPositiveIntegerId(caseId)) {
        throw new TypeError("caseId must be a positive integer");
      }
      const normalizedCaseId = BigInt(String(caseId).trim()).toString();
      const expectedOperation = operationKey(`get_case/${normalizedCaseId}`);
      const item = await authorizedGet(
        buildUrl(`get_case/${normalizedCaseId}`),
        expectedOperation,
        {},
        { signal },
      );
      if (
        !item
        || typeof item !== "object"
        || !isPositiveIntegerId(item.id)
        || BigInt(String(item.id).trim()).toString() !== normalizedCaseId
      ) {
        throw new TypeError("TestRail returned a case that does not match the requested ID");
      }
      return item;
    },

    async createCase(sectionId, fields, { signal } = {}) {
      if (!isPositiveIntegerId(sectionId)) {
        throw new TypeError("sectionId must be a positive integer");
      }
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new TypeError("fields must be an object");
      }
      if (typeof fields.title !== "string" || fields.title.trim().length === 0) {
        throw new TypeError("fields.title is required");
      }
      const normalizedSectionId = BigInt(String(sectionId).trim()).toString();
      const expectedOperation = operationKey(`add_case/${normalizedSectionId}`);
      const item = await authorizedPost(
        buildUrl(`add_case/${normalizedSectionId}`),
        expectedOperation,
        {},
        fields,
        { signal },
      );
      if (!item || typeof item !== "object" || !isPositiveIntegerId(item.id)) {
        throw new TypeError("TestRail did not return the created case ID");
      }
      return item;
    },

    async createSection(projectId, fields, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) {
        throw new TypeError("projectId must be a positive integer");
      }
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new TypeError("fields must be an object");
      }
      if (!isPositiveIntegerId(fields.suite_id)) {
        throw new TypeError("fields.suite_id must be a positive integer");
      }
      if (typeof fields.name !== "string" || fields.name.trim().length === 0) {
        throw new TypeError("fields.name is required");
      }
      if (fields.parent_id !== undefined && !isPositiveIntegerId(fields.parent_id)) {
        throw new TypeError("fields.parent_id must be a positive integer");
      }
      const normalizedProjectId = BigInt(String(projectId).trim()).toString();
      const expectedOperation = operationKey(`add_section/${normalizedProjectId}`);
      const item = await authorizedPost(
        buildUrl(`add_section/${normalizedProjectId}`),
        expectedOperation,
        {},
        fields,
        { signal },
      );
      if (!item || typeof item !== "object" || !isPositiveIntegerId(item.id)) {
        throw new TypeError("TestRail did not return the created section ID");
      }
      return item;
    },

    /** `get_suites` is not paginated by TestRail; always returns one page. */
    async fetchSuites(projectId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) throw new TypeError("projectId must be a positive integer");
      return paginatedFetch(
        page,
        () => buildUrl(`get_suites/${projectId}`),
        "suites",
        operationKey(`get_suites/${projectId}`),
        undefined,
        undefined,
        signal,
      );
    },

    async fetchSections(projectId, suiteId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) throw new TypeError("projectId must be a positive integer");
      if (!isPositiveIntegerId(suiteId)) throw new TypeError("suiteId must be a positive integer");
      return paginatedFetch(
        page,
        () => buildUrl(`get_sections/${projectId}`, {
          suite_id: suiteId,
          limit: pageSize,
        }),
        "sections",
        operationKey(`get_sections/${projectId}`),
        { suite_id: suiteId },
        { limit: pageSize },
        signal,
      );
    },

    async fetchCases(projectId, suiteId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) throw new TypeError("projectId must be a positive integer");
      if (!isPositiveIntegerId(suiteId)) throw new TypeError("suiteId must be a positive integer");
      return paginatedFetch(
        page,
        () => buildUrl(`get_cases/${projectId}`, { suite_id: suiteId, limit: pageSize }),
        "cases",
        operationKey(`get_cases/${projectId}`),
        { suite_id: suiteId },
        { limit: pageSize },
        signal,
      );
    },

    async fetchCasesInSection(projectId, suiteId, sectionId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) throw new TypeError("projectId must be a positive integer");
      if (!isPositiveIntegerId(suiteId)) throw new TypeError("suiteId must be a positive integer");
      if (!isPositiveIntegerId(sectionId)) throw new TypeError("sectionId must be a positive integer");
      return paginatedFetch(
        page,
        () => buildUrl(`get_cases/${projectId}`, {
          suite_id: suiteId,
          section_id: sectionId,
          limit: pageSize
        }),
        "cases",
        operationKey(`get_cases/${projectId}`),
        { suite_id: suiteId, section_id: sectionId },
        { limit: pageSize },
        signal,
      );
    },

    async fetchCasesByReference(projectId, suiteId, reference, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) throw new TypeError("projectId must be a positive integer");
      if (!isPositiveIntegerId(suiteId)) throw new TypeError("suiteId must be a positive integer");
      if (typeof reference !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(reference)) {
        throw new TypeError("reference must be a valid issue key");
      }
      return paginatedFetch(
        page,
        () => buildUrl(`get_cases/${projectId}`, {
          suite_id: suiteId,
          refs: reference.toUpperCase(),
          limit: pageSize
        }),
        "cases",
        operationKey(`get_cases/${projectId}`),
        { suite_id: suiteId, refs: reference.toUpperCase() },
        { limit: pageSize },
        signal,
      );
    },

    async fetchRuns(projectId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(projectId)) throw new TypeError("projectId must be a positive integer");
      return paginatedFetch(
        page,
        () => buildUrl(`get_runs/${projectId}`, { limit: pageSize }),
        "runs",
        operationKey(`get_runs/${projectId}`),
        {},
        { limit: pageSize },
        signal,
      );
    },

    async fetchResults(runId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(runId)) throw new TypeError("runId must be a positive integer");
      return paginatedFetch(
        page,
        () => buildUrl(`get_results_for_run/${runId}`, { limit: pageSize }),
        "results",
        operationKey(`get_results_for_run/${runId}`),
        {},
        { limit: pageSize },
        signal,
      );
    },
  };
}

export { ConnectorHttpError as TestRailHttpError };
