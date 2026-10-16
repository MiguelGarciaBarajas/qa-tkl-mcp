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
const DEFAULT_PAGE_SIZE = 50;
const PROJECT_PATTERN = /^[A-Za-z0-9_-]+$/;
// Fixed, deterministic sort orders so repeated syncs observe pages in a
// stable order rather than whatever order the server happens to apply by
// default.
const LAUNCH_SORT = "startTime,ASC";
const TEST_ITEM_SORT = "startTime,ASC";
const TEST_ITEM_HISTORY_SORT = "startTime,DESC";
const TARGETED_LAUNCH_LIMIT = 5;

function withQuery(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function isPositiveIntegerId(value) {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (!/^\d+$/.test(text)) return false;
  return BigInt(text) > 0n;
}

function normalizeTestIdentity(value) {
  const identity = typeof value === "string" ? value.trim() : "";
  if (identity.length === 0 || identity.length > 500) {
    throw new TypeError("identity must be between 1 and 500 characters");
  }
  if (!/^https?:\/\//i.test(identity)) return { identity };
  const url = new URL(identity);
  const launchId = url.hash.match(/\/launches\/all\/(\d+)/i)?.[1];
  const hashQuery = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : "";
  const hashParams = new URLSearchParams(hashQuery);
  const nestedParams = new URLSearchParams(hashParams.get("item0Params") ?? "");
  const extractedIdentity =
    nestedParams.get("filter.eq.uniqueId")
    ?? nestedParams.get("filter.eq.codeRef")
    ?? hashParams.get("filter.eq.uniqueId")
    ?? hashParams.get("filter.eq.codeRef");
  if (!extractedIdentity) {
    throw new TypeError("ReportPortal URL must include a uniqueId or codeRef filter");
  }
  return { identity: extractedIdentity, ...(launchId ? { launchId } : {}) };
}

/**
 * Resolves an opaque pagination cursor to the zero-based page index to
 * request. Only a plain non-negative integer is accepted -- ReportPortal's
 * page API carries no HATEOAS links to normalize, so there is nothing to
 * rebuild from an untrusted response; the page index is always supplied by
 * the caller (or a `nextPage` this client itself previously returned) and
 * the request URL is always rebuilt locally from the configured `baseUrl`,
 * project, and (for test items) launch ID.
 */
export function resolvePageIndex(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError("A pagination cursor must be a non-negative integer page index");
  }
  return cursor;
}

/**
 * Computes the next zero-based page index from a ReportPortal `content` +
 * `page` response. Only ever advances when the page actually returned
 * records (so an empty or malformed page can never turn into an unbounded
 * paging loop) and when the response's own `page.number`/`page.totalPages`
 * metadata proves another page exists; a response missing that metadata
 * fails closed (no next page) rather than guessing.
 */
export function nextPaginationCursor({ page, returnedCount }) {
  if (returnedCount <= 0) return undefined;
  const number = Number.isSafeInteger(page?.number) && page.number >= 0 ? page.number : undefined;
  const totalPages = Number.isSafeInteger(page?.totalPages) && page.totalPages >= 0 ? page.totalPages : undefined;
  if (number === undefined || totalPages === undefined) return undefined;
  const next = number + 1;
  return next < totalPages ? next : undefined;
}

/**
 * Creates a dependency-free ReportPortal REST API HTTP client. Credentials
 * are resolved per-request through the injected `resolveCredential`
 * function (returning the raw API token) and are never stored on the
 * client instance, logged, or embedded in returned data or thrown errors.
 * The client sends `Authorization: Bearer <token>`, matching this
 * codebase's existing convention for bearer-token sources (Jira, GitHub).
 *
 * Every request is scoped to the configured `project` (embedded directly in
 * the request path); `resolvePageIndex`/`nextPaginationCursor` never trust
 * anything from the response except the `content` array and `page`
 * metadata used to decide whether another page exists -- every request URL
 * is rebuilt locally from the caller's own trusted `baseUrl`, `project`,
 * and (for test items) `launchId`, never from a URL supplied by the
 * server.
 */
export function createReportPortalHttpClient({
  fetch: fetchImpl = globalThis.fetch,
  baseUrl,
  project,
  credentialRef,
  resolveCredential,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  allowInsecureLoopback = false,
  allowInsecureHost = false,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!isHttpUrl(normalizedBaseUrl)) throw new TypeError("baseUrl must be a valid HTTP(S) URL");
  if (!isProductionSafeUrl(normalizedBaseUrl, { allowInsecureLoopback, allowInsecureHost })) {
    throw new TypeError(
      "baseUrl must use HTTPS unless this exact internal host or a local loopback "
      + "development endpoint was explicitly approved",
    );
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (typeof resolveCredential !== "function") throw new TypeError("A credential resolver function is required");
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    throw new TypeError("credentialRef is required");
  }
  if (typeof project !== "string" || !PROJECT_PATTERN.test(project)) {
    throw new TypeError("project must be a non-empty alphanumeric identifier");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new TypeError("pageSize must be a positive integer");

  async function authorizedGet(path, params, { signal } = {}) {
    signal?.throwIfAborted();
    const token = await resolveCredentialValue(resolveCredential, credentialRef);
    signal?.throwIfAborted();
    const url = withQuery(`${normalizedBaseUrl}${path}`, params ?? {});
    // Defense in depth: the URL above is always built locally from the
    // validated `baseUrl`, so this can never actually fail for a
    // legitimate call, but it keeps this client consistent with every
    // other connector's guarantee that no credentialed request leaves the
    // process without an explicit same-origin/HTTPS check first.
    const safeUrlValue = assertSameOriginUrl(url, normalizedBaseUrl, {
      allowInsecureLoopback,
      allowInsecureHost,
    });
    return requestJson({
      fetchImpl,
      url: safeUrlValue,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs,
      signal,
    });
  }

  return {
    // Exposed so the connector can build evidence `sourceUrl` links from
    // this client's own explicitly-validated `baseUrl` instead of a
    // hard-coded host, without needing to re-validate it.
    baseUrl: normalizedBaseUrl,
    project,

    /** Lists launches for the configured project, most-recently-started first is not assumed; sort is fixed and deterministic. */
    async fetchLaunches(page = 0, { signal } = {}) {
      const pageIndex = resolvePageIndex(page);
      const body = await authorizedGet(`/api/v1/${encodeURIComponent(project)}/launch`, {
        "page.page": pageIndex,
        "page.size": pageSize,
        "page.sort": LAUNCH_SORT,
      }, { signal });
      if (!Array.isArray(body?.content)) {
        throw new TypeError("ReportPortal returned an invalid launch page envelope: content must be an array");
      }
      const content = body.content;
      return {
        items: content,
        nextPage: nextPaginationCursor({ page: body?.page, returnedCount: content.length }),
      };
    },

    /** Lists test items for one launch, scoped to the configured project. */
    async fetchTestItems(launchId, page = 0, { signal } = {}) {
      if (!isPositiveIntegerId(launchId)) throw new TypeError("launchId must be a positive integer");
      const pageIndex = resolvePageIndex(page);
      const body = await authorizedGet(`/api/v1/${encodeURIComponent(project)}/launch/${encodeURIComponent(String(launchId))}/testItem`, {
        "page.page": pageIndex,
        "page.size": pageSize,
        "page.sort": TEST_ITEM_SORT,
      }, { signal });
      if (!Array.isArray(body?.content)) {
        throw new TypeError("ReportPortal returned an invalid test item page envelope: content must be an array");
      }
      const content = body.content;
      // Fail closed: a misbehaving/misconfigured ReportPortal instance
      // could still return a test item belonging to a different launch.
      // Reject the entire page rather than silently dropping or (worse)
      // emitting an out-of-scope result.
      for (const item of content) {
        const returnedLaunchId = item?.launchId;
        if (returnedLaunchId !== undefined && String(returnedLaunchId) !== String(launchId)) {
          throw new TypeError(`ReportPortal returned a test item for launch "${returnedLaunchId}" outside the requested scope`);
        }
      }
      return {
        items: content,
        nextPage: nextPaginationCursor({ page: body?.page, returnedCount: content.length }),
      };
    },

    /**
     * Retrieves a bounded execution history for one ReportPortal test
     * identity. ReportPortal may expose the stable identity as either
     * `uniqueId` or `codeRef`, so both exact filters are queried and merged.
     */
    async fetchTestItemsByIdentity(identity, { signal } = {}) {
      const normalized = normalizeTestIdentity(identity);
      const results = [];
      const seen = new Set();
      let launchIds = normalized.launchId ? [normalized.launchId] : [];
      if (launchIds.length === 0) {
        const launches = await authorizedGet(`/api/v1/${encodeURIComponent(project)}/launch`, {
          "page.page": 0,
          "page.size": TARGETED_LAUNCH_LIMIT,
          "page.sort": TEST_ITEM_HISTORY_SORT,
        }, { signal });
        if (!Array.isArray(launches?.content)) {
          throw new TypeError("ReportPortal returned an invalid launch search envelope");
        }
        launchIds = launches.content
          .map((launch) => launch?.id)
          .filter(isPositiveIntegerId)
          .map(String);
      }
      for (const launchId of launchIds) {
        const identityFilters = normalized.identity.startsWith("auto:")
          ? ["filter.eq.uniqueId"]
          : ["filter.eq.uniqueId", "filter.eq.codeRef"];
        for (const filter of identityFilters) {
          const body = await authorizedGet(`/api/v1/${encodeURIComponent(project)}/item`, {
            "filter.eq.launchId": launchId,
            [filter]: normalized.identity,
            "page.page": 0,
            "page.size": pageSize,
            "page.sort": TEST_ITEM_HISTORY_SORT,
          }, { signal });
          if (!Array.isArray(body?.content)) {
            throw new TypeError(
              "ReportPortal returned an invalid test item search envelope: content must be an array",
            );
          }
          for (const item of body.content) {
            const id = item?.id === undefined || item?.id === null ? "" : String(item.id);
            if (!isPositiveIntegerId(id) || seen.has(id)) continue;
            if (item.launchId !== undefined && String(item.launchId) !== launchId) {
              throw new TypeError("ReportPortal returned a test item outside the requested launch");
            }
            seen.add(id);
            results.push(item);
          }
        }
      }
      return results;
    },

    async fetchLogs(itemId, { signal } = {}) {
      if (!isPositiveIntegerId(itemId)) throw new TypeError("itemId must be a positive integer");
      const body = await authorizedGet(`/api/v1/${encodeURIComponent(project)}/log`, {
        "filter.eq.item": itemId,
        "page.page": 0,
        "page.size": pageSize,
        "page.sort": "logTime,ASC",
      }, { signal });
      if (!Array.isArray(body?.content)) {
        throw new TypeError("ReportPortal returned an invalid log page envelope");
      }
      return body.content;
    },
  };
}

export { ConnectorHttpError as ReportPortalHttpError };
