import { ConnectorHttpError, isHttpUrl, isProductionSafeUrl, normalizeBaseUrl, requestJson, resolveCredentialValue } from "./http.js";

export const DEFAULT_JIRA_BASE_URL = "https://jira.app.solera.com/jira";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 50;

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

function projectKeyOf(issueKey) {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(String(issueKey ?? "").trim());
  return match ? match[1].toUpperCase() : null;
}

function namedFieldId(names, expectedName) {
  if (!names || typeof names !== "object") return undefined;
  return Object.entries(names).find(([, name]) =>
    typeof name === "string" && name.trim().toLowerCase() === expectedName.toLowerCase())?.[0];
}

/**
 * Resolves a pagination cursor to the absolute `startAt` offset to request.
 *
 * Two cursor shapes are accepted, so a checkpoint written by any version of
 * this connector keeps resuming correctly:
 *
 * - `{ startAt: <non-negative integer> }` -- the current shape. It is an
 *   *absolute* record offset accumulated from what the server actually
 *   returned, which is the only shape that is correct when Jira caps
 *   `maxResults` below the requested page size.
 * - `<non-negative integer>` -- the legacy page-index shape (multiplied by
 *   the configured page size). Kept for checkpoints written before the
 *   cursor shape changed. It is only correct while the server honors the
 *   requested page size exactly, which is why it is no longer emitted.
 */
export function resolvePaginationStartAt(cursor, pageSize) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor === "object") {
    const { startAt } = cursor;
    if (!Number.isSafeInteger(startAt) || startAt < 0) {
      throw new TypeError("A pagination cursor must carry a non-negative integer startAt");
    }
    return startAt;
  }
  const page = typeof cursor === "string" && /^\d+$/.test(cursor.trim()) ? Number(cursor.trim()) : cursor;
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new TypeError("A pagination cursor must be a non-negative integer page or a { startAt } cursor");
  }
  return page * pageSize;
}

/**
 * Computes the next cursor from a Jira paged response using the *cumulative
 * absolute offset* the server itself reported, never `page * pageSize`.
 *
 * Jira caps `maxResults` server-side (`jira.search.views.default.max` and
 * friends), so a request for 100 records routinely returns 50. Advancing by
 * the requested page size in that case skips every record the server
 * silently withheld -- a silent, permanent evidence gap. Advancing by
 * `startAt + <records actually returned>` (preferring the `startAt` the
 * response echoes back over the one that was requested) closes that gap
 * whatever cap the server applies.
 *
 * Returns `undefined` (no further pages) when the response reports it is the
 * last page, when the page came back empty, when the cursor would not move
 * forward, when the cumulative offset has reached the reported `total`, or
 * when the response carries no `total`/`isLast` to prove more records exist
 * -- the same fail-closed behavior as before, so a response shape this
 * client cannot reason about never turns into an unbounded paging loop.
 */
export function nextPaginationCursor({ body, requestedStartAt, returnedCount }) {
  if (returnedCount <= 0) return undefined;
  if (body?.isLast === true) return undefined;
  const echoedStartAt = Number.isSafeInteger(body?.startAt) && body.startAt >= 0 ? body.startAt : requestedStartAt;
  const nextStartAt = echoedStartAt + returnedCount;
  // A server that echoes a startAt behind the requested one (or that
  // returns fewer records than it skipped) must never produce a cursor that
  // stalls or moves backward, which would re-request the same page forever.
  if (nextStartAt <= requestedStartAt) return undefined;
  const total = Number.isFinite(body?.total) ? body.total : undefined;
  if (total === undefined) return body?.isLast === false ? { startAt: nextStartAt } : undefined;
  return nextStartAt < total ? { startAt: nextStartAt } : undefined;
}

/**
 * Creates a dependency-free Jira REST v2 HTTP client. Credentials are
 * resolved per-request through the injected `resolveCredential` function and
 * are never stored on the client instance, logged, or embedded in returned
 * data or thrown errors. Every request is checked against the configured
 * project and JQL allowlists before any network call is made, so
 * out-of-scope requests never leave the process.
 *
 * Pagination uses Jira's `startAt`/`maxResults` contract and advances by a
 * *cumulative absolute offset* derived from each response (see
 * {@link nextPaginationCursor}), so a server-side `maxResults` cap can never
 * open a gap in the collected records. Cursors are returned as
 * `{ startAt }`; legacy numeric page-index cursors from older checkpoints
 * are still accepted (see {@link resolvePaginationStartAt}).
 */
export function createJiraHttpClient({
  fetch: fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_JIRA_BASE_URL,
  credentialRef,
  resolveCredential,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_PAGE_SIZE,
  allowedProjects,
  allowedJql,
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

  const projectAllowlist = normalizeAllowlist(allowedProjects, "project").map((value) => value.toUpperCase());
  const jqlAllowlist = normalizeAllowlist(allowedJql, "JQL");

  function assertIssueKeyAllowed(issueKey) {
    const projectKey = projectKeyOf(issueKey);
    if (!projectKey || !projectAllowlist.includes(projectKey)) {
      throw new TypeError(`Jira project for issue "${issueKey}" is not in the configured allowlist`);
    }
  }

  function assertJqlAllowed(jql) {
    const trimmed = typeof jql === "string" ? jql.trim() : "";
    if (trimmed.length === 0 || !jqlAllowlist.includes(trimmed)) {
      throw new TypeError("The requested JQL is not in the configured allowlist");
    }
    return trimmed;
  }

  async function authorizedGet(path, params, { signal } = {}) {
    signal?.throwIfAborted();
    const token = await resolveCredentialValue(resolveCredential, credentialRef);
    signal?.throwIfAborted();
    const url = withQuery(`${normalizedBaseUrl}${path}`, params ?? {});
    return requestJson({
      fetchImpl,
      url,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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

    /** Legacy single-issue fetch, preserved for backward compatibility. */
    async fetchIssue(issueKey, { signal } = {}) {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("issueKey is required");
      }
      assertIssueKeyAllowed(issueKey);
      return authorizedGet(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, undefined, { signal });
    },

    async fetchIssueWithinJql(issueKey, jql, { signal } = {}) {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("issueKey is required");
      }
      assertIssueKeyAllowed(issueKey);
      const allowedJqlValue = assertJqlAllowed(jql);
      const body = await authorizedGet("/rest/api/2/search", {
        jql: `(${allowedJqlValue}) AND key = "${issueKey}"`,
        startAt: 0,
        maxResults: 1,
        expand: "names",
      }, { signal });
      const issue = Array.isArray(body?.issues) ? body.issues[0] : undefined;
      if (!issue || String(issue.key).toUpperCase() !== issueKey.toUpperCase()) {
        return undefined;
      }
      assertIssueKeyAllowed(issue.key);
      const epicLinkFieldId = namedFieldId(body?.names, "Epic Link");
      const epicKey = epicLinkFieldId ? issue?.fields?.[epicLinkFieldId] : undefined;
      const parentKey = issue?.fields?.parent?.key;
      return {
        ...issue,
        ...(typeof epicKey === "string" && epicKey.trim() ? { epicKey: epicKey.trim() } : {}),
        ...(typeof parentKey === "string" && parentKey.trim() ? { parentKey: parentKey.trim() } : {}),
      };
    },

    async fetchComments(issueKey, page = 0, { signal } = {}) {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("issueKey is required");
      }
      assertIssueKeyAllowed(issueKey);
      const startAt = resolvePaginationStartAt(page, pageSize);
      const body = await authorizedGet(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, {
        startAt,
        maxResults: pageSize,
      }, { signal });
      const comments = Array.isArray(body?.comments) ? body.comments : [];
      return {
        items: comments,
        nextPage: nextPaginationCursor({ body, requestedStartAt: startAt, returnedCount: comments.length }),
      };
    },

    async searchIssues(jql, page = 0, { signal } = {}) {
      const allowedJqlValue = assertJqlAllowed(jql);
      const startAt = resolvePaginationStartAt(page, pageSize);
      const body = await authorizedGet("/rest/api/2/search", {
        jql: allowedJqlValue,
        startAt,
        maxResults: pageSize,
        expand: "names",
      }, { signal });
      const epicLinkFieldId = namedFieldId(body?.names, "Epic Link");
      const issues = (Array.isArray(body?.issues) ? body.issues : []).map((issue) => {
        const epicKey = epicLinkFieldId ? issue?.fields?.[epicLinkFieldId] : undefined;
        const parentKey = issue?.fields?.parent?.key;
        return {
          ...issue,
          ...(typeof epicKey === "string" && epicKey.trim() ? { epicKey: epicKey.trim() } : {}),
          ...(typeof parentKey === "string" && parentKey.trim() ? { parentKey: parentKey.trim() } : {}),
        };
      });
      // Fail closed: the configured JQL is itself allowlisted, but a
      // misbehaving/misconfigured Jira instance could still return an
      // issue outside the approved project scope, or one missing a valid
      // key. Reject the entire page rather than silently dropping or
      // (worse) emitting an out-of-scope result.
      for (const issue of issues) {
        assertIssueKeyAllowed(issue?.key);
      }
      return {
        items: issues,
        nextPage: nextPaginationCursor({ body, requestedStartAt: startAt, returnedCount: issues.length }),
      };
    },
  };
}

export { ConnectorHttpError as JiraHttpError };
