import {
  ConnectorHttpError,
  assertSameOriginUrl,
  isHttpUrl,
  isProductionSafeUrl,
  normalizeBaseUrl,
  parseLinkHeader,
  requestJsonPage,
  resolveCredentialValue,
} from "./http.js";

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
export const DEFAULT_GITHUB_WEB_URL = "https://github.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 50;
const GITHUB_API_VERSION = "2022-11-28";

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a matcher for the *literal* `owner/repo` path of the specific
 * operation and repository/PR requested. Only this exact literal path is
 * ever dereferenced for a pagination cursor; anything else -- a different
 * repository, a different pull request's files, or an unrelated endpoint
 * entirely -- is rejected outright (see `resolvePaginatedUrl`, which
 * handles GitHub's numeric `repositories/{id}` cursor shape separately and
 * never fetches it directly).
 */
function literalOperationPath(apiPathPrefix, { repository, suffix }) {
  return `${apiPathPrefix}/repos/${repository}${suffix}`;
}

/**
 * Matches GitHub's documented numeric `repositories/{id}` cursor shape for
 * the given operation suffix. The numeric id is opaque -- it cannot be
 * verified, without an extra API call, to reference the allowlisted
 * repository -- so a URL matching this pattern must never be dereferenced.
 * Only its trusted pagination query parameters are ever used (see
 * `resolvePaginatedUrl`).
 */
function numericIdOperationPattern(apiPathPrefix, { suffix }) {
  return new RegExp(`^${escapeRegExp(apiPathPrefix)}/repositories/\\d+${escapeRegExp(suffix)}$`);
}

/**
 * Extracts only the trusted, well-formed pagination query parameters
 * (`page`, `per_page`) from an untrusted cursor URL. Every other part of
 * the cursor -- host, path, and any other query parameter -- is discarded;
 * it must never influence which resource is actually requested.
 */
function extractPaginationParams(cursorUrl) {
  const params = {};
  const page = cursorUrl.searchParams.get("page");
  const perPage = cursorUrl.searchParams.get("per_page");
  if (page !== null) {
    if (!/^[1-9]\d*$/.test(page)) throw new TypeError("Pagination cursor's page parameter must be a positive integer");
    params.page = page;
  }
  if (perPage !== null) {
    if (!/^[1-9]\d*$/.test(perPage)) throw new TypeError("Pagination cursor's per_page parameter must be a positive integer");
    params.per_page = perPage;
  }
  return params;
}

/**
 * Creates a dependency-free GitHub REST HTTP client. Credentials are
 * resolved per-request through the injected `resolveCredential` function and
 * are never stored on the client instance, logged, or embedded in returned
 * data or thrown errors. Every request is checked against the configured
 * repository allowlist before any network call is made, so out-of-scope
 * repositories never leave the process. Requests use only the
 * least-privilege headers required for read-only pull request and file
 * access.
 */
export function createGitHubHttpClient({
  fetch: fetchImpl = globalThis.fetch,
  apiUrl = DEFAULT_GITHUB_API_URL,
  webBaseUrl,
  credentialRef,
  resolveCredential,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  allowedRepositories,
  userAgent = "tkl-connector-github",
  allowInsecureLoopback = false,
} = {}) {
  const normalizedApiUrl = normalizeBaseUrl(apiUrl);
  if (!isHttpUrl(normalizedApiUrl)) throw new TypeError("apiUrl must be a valid HTTP(S) URL");
  if (!isProductionSafeUrl(normalizedApiUrl, { allowInsecureLoopback })) {
    throw new TypeError(
      "apiUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
      + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
    );
  }
  // `webBaseUrl` is the browsable GitHub Enterprise Server (or github.com)
  // host used only to build human-facing evidence `sourceUrl` links; it is
  // never sent a credential. It cannot be derived from `apiUrl` (GHES
  // serves its API from the same host under a `/api/v3` path, while
  // github.com serves its API from a distinct `api.github.com` host), so it
  // must be explicitly configured for Enterprise Server. When omitted, it
  // defaults to `undefined` here and the connector falls back to
  // `DEFAULT_GITHUB_WEB_URL` (github.com) for backward compatibility.
  let normalizedWebBaseUrl;
  if (webBaseUrl !== undefined) {
    normalizedWebBaseUrl = normalizeBaseUrl(webBaseUrl);
    if (!isHttpUrl(normalizedWebBaseUrl)) throw new TypeError("webBaseUrl must be a valid HTTP(S) URL");
    if (!isProductionSafeUrl(normalizedWebBaseUrl, { allowInsecureLoopback })) {
      throw new TypeError(
        "webBaseUrl must use HTTPS in production; set allowInsecureLoopback: true only for local "
        + "loopback (localhost/127.0.0.1/[::1]) development or test HTTP endpoints",
      );
    }
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (typeof resolveCredential !== "function") throw new TypeError("A credential resolver function is required");
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    throw new TypeError("credentialRef is required");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new TypeError("pageSize must be a positive integer");

  const apiPathPrefix = new URL(normalizedApiUrl).pathname.replace(/\/+$/, "");
  const repositoryAllowlist = normalizeAllowlist(allowedRepositories, "repository").map((value) => value.toLowerCase());

  function assertRepositoryAllowed(repository) {
    if (typeof repository !== "string" || repository.length === 0 || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new TypeError("repository must be an \"owner/name\" string");
    }
    if (!repositoryAllowlist.includes(repository.toLowerCase())) {
      throw new TypeError(`Repository "${repository}" is not in the configured allowlist`);
    }
  }

  /**
   * Resolves the URL to actually request for a paginated operation, given
   * the caller-supplied `page` (either the initial `0`, or an opaque cursor
   * resumed from a previous response's `Link: rel="next"` header or a
   * persisted checkpoint). `repository` and `suffix` describe the specific
   * allowlisted operation this call requested (already verified by
   * `assertRepositoryAllowed`); `buildUrl(params)` builds a same-origin URL
   * for that exact operation from trusted query parameters.
   *
   * A cursor is only ever handled in one of two ways:
   *  - if its path is the *literal* `owner/repo` path for this exact
   *    operation, it is used as-is (this is what real Link-header
   *    pagination returns for the overwhelming majority of requests);
   *  - if its path matches GitHub's documented numeric `repositories/{id}`
   *    cursor shape for this exact operation, its host and path are
   *    discarded entirely -- the numeric id can never be verified to
   *    reference the allowlisted repository -- and only its trusted
   *    `page`/`per_page` query parameters are extracted and merged onto a
   *    freshly rebuilt URL for the *already-allowlisted* repository/PR, so
   *    an arbitrary numeric id can never redirect the request elsewhere.
   * Any other path (a different repository, a different pull request, or
   * an unrelated endpoint entirely) is rejected outright.
   */
  function resolvePaginatedUrl(page, { repository, suffix, defaultParams, buildUrl }) {
    if (typeof page !== "string" || page.length === 0) return buildUrl(defaultParams);
    // Every outgoing URL -- freshly built or an opaque "next page" cursor
    // resumed from a prior response or a checkpoint -- must be validated as
    // HTTPS and same-origin with the configured apiUrl *before* resolving
    // the credential, so a cross-origin or insecure cursor can never cause
    // credentials to be sent to an unexpected destination.
    const safeUrl = assertSameOriginUrl(page, normalizedApiUrl, { allowInsecureLoopback });
    const cursorUrl = new URL(safeUrl);
    if (cursorUrl.pathname === literalOperationPath(apiPathPrefix, { repository, suffix })) {
      return safeUrl;
    }
    if (numericIdOperationPattern(apiPathPrefix, { suffix }).test(cursorUrl.pathname)) {
      return buildUrl({ ...defaultParams, ...extractPaginationParams(cursorUrl) });
    }
    throw new TypeError("Request URL does not match the expected GitHub API operation");
  }

  async function authorizedGetPage(url, expectedPath, { signal, itemsKey } = {}) {
    // Defense in depth: `resolvePaginatedUrl` above already guarantees
    // `url` is same-origin and targets the exact expected literal path --
    // either because it built the URL itself, or because it verified the
    // cursor matched that literal path exactly. Re-checking here means a
    // future change to `resolvePaginatedUrl` can never silently regress
    // into dereferencing an unverified path.
    const safeUrl = assertSameOriginUrl(url, normalizedApiUrl, { allowInsecureLoopback });
    if (new URL(safeUrl).pathname !== expectedPath) {
      throw new TypeError("Request URL does not match the expected GitHub API operation");
    }
    signal?.throwIfAborted();
    const token = await resolveCredentialValue(resolveCredential, credentialRef);
    signal?.throwIfAborted();
    const { body, link } = await requestJsonPage({
      fetchImpl,
      url: safeUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": userAgent,
      },
      timeoutMs,
      signal,
    });
    const items = Array.isArray(body)
      ? body
      : (itemsKey && Array.isArray(body?.[itemsKey]) ? body[itemsKey] : []);
    const { next } = parseLinkHeader(link);
    return {
      items,
      nextPage: next,
      ...(itemsKey ? { incompleteResults: body?.incomplete_results === true } : {})
    };
  }

  return {
    // Exposed so the connector can build evidence `sourceUrl` links from
    // this client's explicitly-validated configuration instead of a
    // hard-coded host; `undefined` when not configured, so the connector
    // can apply its own github.com default.
    webBaseUrl: normalizedWebBaseUrl,

    /**
     * Lists pull requests for the allowlisted repository. `page` is either
     * the initial value `0` or an opaque `Link: rel="next"` URL returned by
     * a previous call, so pagination cursors are never reconstructed by
     * hand.
     */
    async fetchPullRequests(repository, page = 0, { signal } = {}) {
      assertRepositoryAllowed(repository);
      const suffix = "/pulls";
      const buildUrl = (params) => withQuery(`${normalizedApiUrl}/repos/${repository}${suffix}`, params);
      const url = resolvePaginatedUrl(page, {
        repository,
        suffix,
        defaultParams: { state: "all", sort: "updated", direction: "desc", per_page: pageSize, page: 1 },
        buildUrl,
      });
      return authorizedGetPage(
        url,
        literalOperationPath(apiPathPrefix, { repository, suffix }),
        { signal },
      );
    },

    async fetchChangedFiles(repository, pullNumber, page = 0, { signal } = {}) {
      assertRepositoryAllowed(repository);
      if (pullNumber === undefined || pullNumber === null || String(pullNumber).length === 0) {
        throw new TypeError("pullNumber is required");
      }
      const encodedNumber = encodeURIComponent(String(pullNumber));
      const suffix = `/pulls/${encodedNumber}/files`;
      const buildUrl = (params) => withQuery(`${normalizedApiUrl}/repos/${repository}${suffix}`, params);
      const url = resolvePaginatedUrl(page, {
        repository,
        suffix,
        defaultParams: { per_page: pageSize, page: 1 },
        buildUrl,
      });
      return authorizedGetPage(
        url,
        literalOperationPath(apiPathPrefix, { repository, suffix }),
        { signal },
      );
    },

    async searchPullRequestsByIssue(repository, issueKey, page = 0, { signal } = {}) {
      assertRepositoryAllowed(repository);
      if (typeof issueKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) {
        throw new TypeError("issueKey must be a valid Jira issue key");
      }
      const suffix = "/search/issues";
      const expectedPath = `${apiPathPrefix}${suffix}`;
      const buildUrl = (params) => withQuery(`${normalizedApiUrl}${suffix}`, {
        q: `repo:${repository} is:pr "${issueKey.toUpperCase()}"`,
        per_page: pageSize,
        ...params,
      });
      let url = buildUrl({ page: 1 });
      if (typeof page === "string" && page.length > 0) {
        const safeCursor = assertSameOriginUrl(page, normalizedApiUrl, { allowInsecureLoopback });
        const cursorUrl = new URL(safeCursor);
        if (cursorUrl.pathname !== expectedPath) {
          throw new TypeError("Request URL does not match the expected GitHub API operation");
        }
        url = buildUrl(extractPaginationParams(cursorUrl));
      }
      return authorizedGetPage(url, expectedPath, { signal, itemsKey: "items" });
    },
  };
}

export { ConnectorHttpError as GitHubHttpError };
