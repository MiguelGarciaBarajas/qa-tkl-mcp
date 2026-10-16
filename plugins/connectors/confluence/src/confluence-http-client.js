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
const DEFAULT_PAGE_SIZE = 25;
const CONTENT_OPERATION_PATH = "/rest/api/content";
const CONTENT_SEARCH_OPERATION_PATH = "/rest/api/content/search";
const CONTENT_EXPAND = "space,version,body.storage,metadata.labels";

function withQuery(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function normalizeAllowlist(values, label) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    throw new TypeError(`A non-empty ${label} allowlist is required`);
  }
  return normalized;
}

/**
 * Resolves an opaque pagination cursor to the absolute `start` offset to
 * request. Two cursor shapes are accepted:
 *
 * - `{ start: <non-negative integer> }` -- the shape this client emits. It
 *   is an absolute record offset accumulated from the count Confluence
 *   actually returned, which is the only shape that is correct when a page
 *   request returns fewer results than asked for.
 * - `<non-negative integer>` -- a plain page-index/offset cursor, accepted
 *   for the initial call (`0`) and for callers/checkpoints that pass a
 *   raw offset directly.
 */
export function resolvePaginationStart(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor === "object") {
    const { start } = cursor;
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new TypeError("A pagination cursor must carry a non-negative integer start");
    }
    return start;
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError("A pagination cursor must be a non-negative integer start or a { start } cursor");
  }
  return cursor;
}

/**
 * Confirms a `_links.next` value Confluence returned still targets the
 * `rest/api/content` operation this client requested, and is same-origin
 * (HTTPS, or loopback HTTP only when explicitly allowed) with the
 * configured `baseUrl`. This is the "does the provider's own pagination
 * metadata still point at the operation we asked for" check: it is never
 * used to build the next request (that is always rebuilt from trusted
 * values -- see {@link nextPaginationCursor}), only to detect a
 * provider/response that has drifted away from the expected operation or
 * origin, which is treated as a hard failure rather than silently ignored.
 */
function assertNextLinkMatchesContentOperation(
  nextLink,
  baseUrl,
  allowInsecureLoopback,
  operationPath = CONTENT_OPERATION_PATH,
) {
  const safeNextUrl = assertSameOriginUrl(nextLink, baseUrl, { allowInsecureLoopback });
  const basePathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
  const expectedPrefix = `${basePathname}${operationPath}`;
  const nextPathname = new URL(safeNextUrl).pathname;
  if (nextPathname !== expectedPrefix) {
    throw new TypeError("Confluence pagination next link does not match the expected content operation");
  }
}

/**
 * Computes the next pagination cursor from a Confluence `rest/api/content`
 * response using the *cumulative absolute offset* actually returned, never
 * `start + limit`. A misbehaving or capacity-limited Confluence instance
 * can return fewer `results` than the requested `limit`; advancing by the
 * requested limit in that case would skip every record the server
 * withheld.
 *
 * Confluence signals "more pages exist" by including a `_links.next`
 * entry; its presence (after being validated as same-origin and still
 * targeting the `rest/api/content` operation) is the only trusted signal
 * that paging should continue -- its query parameters are never carried
 * forward verbatim. Returns `undefined` (no further pages) whenever the
 * page came back empty, `_links.next` is absent, or advancing would not
 * move the cursor forward, so a malformed response can never turn into an
 * unbounded paging loop.
 */
export function nextPaginationCursor({
  body,
  requestedStart,
  returnedCount,
  baseUrl,
  allowInsecureLoopback,
  operationPath = CONTENT_OPERATION_PATH,
}) {
  if (returnedCount <= 0) return undefined;
  const nextLink = body?._links?.next;
  if (typeof nextLink !== "string" || nextLink.length === 0) return undefined;
  assertNextLinkMatchesContentOperation(
    nextLink,
    baseUrl,
    allowInsecureLoopback,
    operationPath,
  );
  const nextStart = requestedStart + returnedCount;
  if (nextStart <= requestedStart) return undefined;
  return { start: nextStart };
}

/**
 * Creates a dependency-free Confluence REST API HTTP client. Credentials
 * are resolved per-request through the injected `resolveCredential`
 * function (returning the raw API token) and are never stored on the
 * client instance, logged, or embedded in returned data or thrown errors.
 * The client supports HTTP Basic authentication for Atlassian Cloud API
 * tokens and Bearer authentication for self-hosted Confluence personal
 * access tokens. The selected credential is resolved fresh for every request
 * and is never persisted in encoded form.
 *
 * Every request is checked against the configured space-key allowlist
 * before any network call is made, so out-of-scope spaces never leave the
 * process. Pages are collected from the path-prefix-preserving
 * `rest/api/content` endpoint (so a `baseUrl` that itself carries a path
 * prefix, for example `.../wiki`, is preserved rather than overwritten),
 * filtered to `type=page&status=current`, and expanded with
 * `space,version,body.storage,metadata.labels`.
 *
 * Pagination follows Confluence's `_links.next` contract, but the next
 * request URL is always rebuilt from trusted, locally-held values (base
 * URL, the `rest/api/content` operation, and the caller's own allowlisted
 * `spaceKey`) rather than sent verbatim -- only the pagination `start`
 * offset is carried forward, computed from the *actual* number of results
 * returned rather than the requested `limit` (see
 * {@link nextPaginationCursor}), and the previous response's `_links.next`
 * is additionally required to still resolve to a same-origin
 * `rest/api/content` URL before being trusted as a "more pages exist"
 * signal at all.
 */
export function createConfluenceHttpClient({
  fetch: fetchImpl = globalThis.fetch,
  baseUrl,
  username,
  authMode = "basic",
  credentialRef,
  resolveCredential,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  allowedSpaceKeys,
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
  if (typeof username !== "string" || username.trim().length === 0) {
    throw new TypeError("username is required");
  }
  if (!["basic", "bearer"].includes(authMode)) {
    throw new TypeError('authMode must be "basic" or "bearer"');
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new TypeError("pageSize must be a positive integer");

  const spaceKeyAllowlist = normalizeAllowlist(allowedSpaceKeys, "space key");

  function assertSpaceKeyAllowed(spaceKey) {
    if (typeof spaceKey !== "string" || spaceKey.length === 0 || !spaceKeyAllowlist.includes(spaceKey)) {
      throw new TypeError(`Confluence space "${spaceKey}" is not in the configured allowlist`);
    }
  }

  function assertPageId(pageId) {
    const value = typeof pageId === "number" || typeof pageId === "string"
      ? String(pageId).trim()
      : "";
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
      throw new TypeError("Confluence page ID must be a positive integer");
    }
    return BigInt(value).toString();
  }

  function assertPagesBelongToSpace(results, spaceKey) {
    for (const item of results) {
      const returnedSpaceKey = item?.space?.key;
      if (returnedSpaceKey !== undefined && returnedSpaceKey !== spaceKey) {
        throw new TypeError(`Confluence returned a page for space "${returnedSpaceKey}" outside the requested scope`);
      }
    }
  }

  async function authorizedGet(path, params, { signal } = {}) {
    signal?.throwIfAborted();
    const token = await resolveCredentialValue(resolveCredential, credentialRef);
    signal?.throwIfAborted();
    const url = withQuery(`${normalizedBaseUrl}${path}`, params ?? {});
    const safeUrlValue = assertSameOriginUrl(url, normalizedBaseUrl, { allowInsecureLoopback });
    const authorization = authMode === "bearer"
      ? `Bearer ${token}`
      : `Basic ${Buffer.from(`${username}:${token}`, "utf8").toString("base64")}`;
    return requestJson({
      fetchImpl,
      url: safeUrlValue,
      headers: { Authorization: authorization, Accept: "application/json" },
      timeoutMs,
      signal,
    });
  }

  return {
    // Exposed so the connector can build evidence `sourceUrl` links from
    // this client's own explicitly-validated `baseUrl` instead of a
    // hard-coded host, without needing to re-validate it (it was already
    // checked above for HTTPS/loopback safety at construction time).
    baseUrl: normalizedBaseUrl,

    /**
     * Fetches one page of current pages for an allowlisted space. `page` is
     * either the initial value `0`/`undefined`, a plain non-negative
     * integer start offset, or the `{ start }` cursor this client itself
     * returns.
     */
    async fetchSpacePages(spaceKey, page = 0, { signal } = {}) {
      assertSpaceKeyAllowed(spaceKey);
      const start = resolvePaginationStart(page);
      const body = await authorizedGet(CONTENT_OPERATION_PATH, {
        type: "page",
        status: "current",
        spaceKey,
        start,
        limit: pageSize,
        expand: CONTENT_EXPAND,
      }, { signal });
      if (!Array.isArray(body?.results)) {
        throw new TypeError("Confluence returned an invalid page envelope: results must be an array");
      }
      const results = body.results;
      // Fail closed: the requested space is allowlisted, but a
      // misbehaving/misconfigured Confluence instance could still return a
      // page belonging to a different space. Reject the entire page rather
      // than silently dropping or (worse) emitting an out-of-scope result.
      assertPagesBelongToSpace(results, spaceKey);
      return {
        items: results,
        nextPage: nextPaginationCursor({
          body,
          requestedStart: start,
          returnedCount: results.length,
          baseUrl: normalizedBaseUrl,
          allowInsecureLoopback,
        }),
      };
    },

    async fetchPage(spaceKey, pageId, { signal } = {}) {
      assertSpaceKeyAllowed(spaceKey);
      const normalizedPageId = assertPageId(pageId);
      const page = await authorizedGet(
        `${CONTENT_OPERATION_PATH}/${encodeURIComponent(normalizedPageId)}`,
        { status: "current", expand: CONTENT_EXPAND },
        { signal },
      );
      if (!page || String(page.id) !== normalizedPageId) {
        throw new TypeError("Confluence returned an invalid page");
      }
      assertPagesBelongToSpace([page], spaceKey);
      return page;
    },

    async fetchPageTree(spaceKey, rootPageId, page = 0, { signal } = {}) {
      assertSpaceKeyAllowed(spaceKey);
      const normalizedRootPageId = assertPageId(rootPageId);
      const start = resolvePaginationStart(page);
      const escapedSpaceKey = spaceKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const body = await authorizedGet(CONTENT_SEARCH_OPERATION_PATH, {
        cql: `space = "${escapedSpaceKey}" AND type = page AND ancestor = ${normalizedRootPageId}`,
        start,
        limit: pageSize,
        expand: CONTENT_EXPAND,
      }, { signal });
      if (!Array.isArray(body?.results)) {
        throw new TypeError("Confluence returned an invalid page envelope: results must be an array");
      }
      assertPagesBelongToSpace(body.results, spaceKey);
      return {
        items: body.results,
        nextPage: nextPaginationCursor({
          body,
          requestedStart: start,
          returnedCount: body.results.length,
          baseUrl: normalizedBaseUrl,
          allowInsecureLoopback,
          operationPath: CONTENT_SEARCH_OPERATION_PATH,
        }),
      };
    },

    async fetchPagesByText(query, { signal } = {}) {
      const normalizedQuery = typeof query === "string" ? query.trim() : "";
      if (normalizedQuery.length < 3 || normalizedQuery.length > 200) {
        throw new TypeError("query must contain between 3 and 200 characters");
      }
      const escapedQuery = normalizedQuery.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const results = [];
      for (const spaceKey of spaceKeyAllowlist) {
        const escapedSpaceKey = spaceKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const body = await authorizedGet(CONTENT_SEARCH_OPERATION_PATH, {
          cql:
            `space = "${escapedSpaceKey}" AND type = page `
            + `AND (title ~ "${escapedQuery}" OR text ~ "${escapedQuery}")`,
          start: 0,
          limit: pageSize,
          expand: CONTENT_EXPAND,
        }, { signal });
        if (!Array.isArray(body?.results)) {
          throw new TypeError(
            "Confluence returned an invalid page search envelope: results must be an array",
          );
        }
        assertPagesBelongToSpace(body.results, spaceKey);
        results.push(...body.results);
      }
      return results;
    },
  };
}

export { ConnectorHttpError as ConfluenceHttpError };
