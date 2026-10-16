const DEFAULT_TIMEOUT_MS = 10_000;

function normalizePositiveInteger(value, parameter) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw new SourceConnectionValidationError(
      "invalid_source_configuration",
      "configuration",
      `${parameter} must be a positive integer.`
    );
  }
  return BigInt(text).toString();
}
const DEFAULT_GITHUB_API_URL = "https://api.github.com";

export class SourceConnectionValidationError extends Error {
  constructor(code, category, message, status = "error") {
    super(message);
    this.name = "SourceConnectionValidationError";
    this.code = code;
    this.category = category;
    this.connectionStatus = status;
  }
}

export function createSourceConnectionValidator({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  allowedHosts = [],
  allowedInsecureHosts = [],
  allowInsecureLoopback = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const hostAllowlist = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const insecureHostAllowlist = new Set(
    allowedInsecureHosts.map((host) => host.toLowerCase())
  );

  return async function validateConnection({ source, config, credential }) {
    if (source === "confluence" && config.contentScope !== "space") {
      await validateConfluenceRootPages({
        config,
        credential,
        fetchImpl,
        hostAllowlist,
        allowInsecureLoopback,
        timeoutMs
      });
      return { validatedAt: new Date().toISOString() };
    }
    if (source === "jira") {
      await validateJiraConnection({
        config,
        credential,
        fetchImpl,
        hostAllowlist,
        insecureHostAllowlist,
        allowInsecureLoopback,
        timeoutMs
      });
      return { validatedAt: new Date().toISOString() };
    }
    const request = buildValidationRequest(
      source,
      config,
      credential,
      hostAllowlist,
      insecureHostAllowlist,
      allowInsecureLoopback
    );
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await fetchImpl(request.url, {
        method: "GET",
        headers: request.headers,
        redirect: "error",
        signal: abortController.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new SourceConnectionValidationError(
          "source_authorization_failed",
          "authorization",
          request.authorizationMessage ?? "The source rejected the supplied credential.",
          "authorization-expired"
        );
      }
      if (source === "github" && response.status === 404) {
        throw new SourceConnectionValidationError(
          "github_repository_not_accessible",
          "authorization",
          "GitHub could not access this repository. Verify the repository URL, token repository access, and organization SSO or approval."
        );
      }
      if (!response.ok) {
        throw new SourceConnectionValidationError(
          "source_validation_failed",
          "provider",
          `The source validation request failed with status ${response.status}.`
        );
      }
      return { validatedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof SourceConnectionValidationError) throw error;
      throw new SourceConnectionValidationError(
        "source_unavailable",
        "network",
        error?.name === "AbortError"
          ? "The source validation request timed out."
          : source === "jira"
            ? "Jira could not be reached. Verify the Jira base URL and corporate VPN connection."
            : "The source could not be reached."
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function validateJiraConnection({
  config,
  credential,
  fetchImpl,
  hostAllowlist,
  insecureHostAllowlist,
  allowInsecureLoopback,
  timeoutMs
}) {
  const baseUrl = validateBaseUrl(config.baseUrl, hostAllowlist, {
    allowedInsecureHosts: insecureHostAllowlist,
    allowInsecureLoopback
  });
  if (
    baseUrl.hostname.toLowerCase() === "jira.app.solera.com"
    && !baseUrl.pathname.toLowerCase().startsWith("/jira")
  ) {
    throw new SourceConnectionValidationError(
      "invalid_source_url",
      "configuration",
      "Use https://jira.app.solera.com/jira as the Jira base URL."
    );
  }
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${credential}`
  };
  await fetchSourceStatus({
    fetchImpl,
    url: new URL("rest/api/2/myself", ensureTrailingSlash(baseUrl)).toString(),
    headers,
    timeoutMs,
    authorizationMessage:
      "Jira rejected the personal access token. Verify that the PAT is active and belongs to your Jira account."
  });
  await fetchSourceStatus({
    fetchImpl,
    url: new URL(
      `rest/api/2/project/${encodeURIComponent(config.allowedProjects[0])}`,
      ensureTrailingSlash(baseUrl)
    ).toString(),
    headers,
    timeoutMs,
    notFoundMessage:
      `Jira authenticated the token, but project "${config.allowedProjects[0]}" was not found or the account lacks Browse Projects permission.`
  });
}

async function fetchSourceStatus({
  fetchImpl,
  url,
  headers,
  timeoutMs,
  authorizationMessage,
  notFoundMessage
}) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: abortController.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new SourceConnectionValidationError(
        "source_authorization_failed",
        "authorization",
        authorizationMessage,
        "authorization-expired"
      );
    }
    if (response.status === 404 && notFoundMessage) {
      throw new SourceConnectionValidationError(
        "source_project_not_accessible",
        "configuration",
        notFoundMessage
      );
    }
    if (!response.ok) {
      throw new SourceConnectionValidationError(
        "source_validation_failed",
        "provider",
        `The source validation request failed with status ${response.status}.`
      );
    }
  } catch (error) {
    if (error instanceof SourceConnectionValidationError) throw error;
    throw new SourceConnectionValidationError(
      "source_unavailable",
      "network",
      error?.name === "AbortError"
        ? "The source validation request timed out."
        : "Jira could not be reached. Verify the Jira base URL and corporate VPN connection."
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function createTestRailSuiteDiscoverer({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  allowedHosts = [],
  allowInsecureLoopback = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const hostAllowlist = new Set(allowedHosts.map((host) => host.toLowerCase()));

  return async function discoverTestRailSuites({ config, credential }) {
    const baseUrl = validateBaseUrl(config.baseUrl, hostAllowlist, { allowInsecureLoopback });
    const url = new URL("index.php", ensureTrailingSlash(baseUrl));
    url.search = `/api/v2/get_suites/${encodeURIComponent(config.projectId)}`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: basicHeaders(config.username, credential),
        redirect: "error",
        signal: abortController.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new SourceConnectionValidationError(
          "source_authorization_failed",
          "authorization",
          "TestRail rejected the supplied account email or API key.",
          "authorization-expired"
        );
      }
      if (!response.ok) {
        throw new SourceConnectionValidationError(
          "source_validation_failed",
          "provider",
          `TestRail suite discovery failed with status ${response.status}.`
        );
      }
      const body = typeof response.json === "function"
        ? await response.json()
        : JSON.parse(await response.text());
      const suites = Array.isArray(body) ? body : body?.suites;
      if (!Array.isArray(suites)) {
        throw new SourceConnectionValidationError(
          "source_response_invalid",
          "provider",
          "TestRail returned an invalid suite list."
        );
      }
      return suites
        .filter((suite) =>
          suite
          && (typeof suite.id === "number" || typeof suite.id === "string")
          && /^\d+$/.test(String(suite.id))
          && typeof suite.name === "string"
          && suite.name.trim().length > 0
        )
        .map((suite) => ({
          id: String(suite.id),
          name: suite.name.trim(),
          isCompleted: suite.is_completed === true
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (error instanceof SourceConnectionValidationError) throw error;
      throw new SourceConnectionValidationError(
        "source_unavailable",
        "network",
        error?.name === "AbortError"
          ? "TestRail suite discovery timed out."
          : "TestRail suites could not be loaded."
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createTestRailSectionDiscoverer({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  allowedHosts = [],
  allowInsecureLoopback = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const hostAllowlist = new Set(allowedHosts.map((host) => host.toLowerCase()));

  return async function discoverTestRailSections({ config, credential, suiteId }) {
    const baseUrl = validateBaseUrl(config.baseUrl, hostAllowlist, { allowInsecureLoopback });
    const normalizedSuiteId = normalizePositiveInteger(suiteId, "suiteId");
    const url = new URL("index.php", ensureTrailingSlash(baseUrl));
    url.search = `/api/v2/get_sections/${encodeURIComponent(config.projectId)}`
      + `&suite_id=${encodeURIComponent(normalizedSuiteId)}`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: basicHeaders(config.username, credential),
        redirect: "error",
        signal: abortController.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new SourceConnectionValidationError(
          "source_authorization_failed",
          "authorization",
          "TestRail rejected the stored account email or API key.",
          "authorization-expired"
        );
      }
      if (!response.ok) {
        throw new SourceConnectionValidationError(
          "source_validation_failed",
          "provider",
          `TestRail section discovery failed with status ${response.status}.`
        );
      }
      const body = typeof response.json === "function"
        ? await response.json()
        : JSON.parse(await response.text());
      const sections = Array.isArray(body) ? body : body?.sections;
      if (!Array.isArray(sections)) {
        throw new SourceConnectionValidationError(
          "source_response_invalid",
          "provider",
          "TestRail returned an invalid section list."
        );
      }
      return sections
        .filter((section) =>
          section
          && (typeof section.id === "number" || typeof section.id === "string")
          && /^\d+$/.test(String(section.id))
          && typeof section.name === "string"
          && section.name.trim().length > 0
        )
        .map((section) => ({
          id: String(section.id),
          suiteId: String(section.suite_id ?? normalizedSuiteId),
          parentId: section.parent_id === null || section.parent_id === undefined
            ? null
            : String(section.parent_id),
          depth: Number.isSafeInteger(section.depth) && section.depth >= 0 ? section.depth : 0,
          name: section.name.trim()
        }));
    } catch (error) {
      if (error instanceof SourceConnectionValidationError) throw error;
      throw new SourceConnectionValidationError(
        "source_unavailable",
        "network",
        error?.name === "AbortError"
          ? "TestRail section discovery timed out."
          : "TestRail sections could not be loaded."
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createConfluencePageDiscoverer({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  allowedHosts = [],
  allowInsecureLoopback = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const hostAllowlist = new Set(allowedHosts.map((host) => host.toLowerCase()));

  return async function discoverConfluencePages({ config, credential }) {
    const pageUrls = Array.isArray(config.rootPageUrls) ? config.rootPageUrls : [];
    const parsedPages = pageUrls.map((pageUrl) =>
      parseConfluencePageUrl(pageUrl, hostAllowlist, allowInsecureLoopback)
    );
    const baseUrl = parsedPages[0]?.baseUrl;
    if (!baseUrl || parsedPages.some((page) => page.baseUrl !== baseUrl)) {
      throw new SourceConnectionValidationError(
        "invalid_source_url",
        "configuration",
        "All Confluence root pages must belong to the same Confluence instance."
      );
    }
    const authMode = config.authMode ?? inferConfluenceAuthMode(baseUrl);

    const roots = [];
    for (const page of parsedPages) {
      const url = page.pageId
        ? new URL(
          `rest/api/content/${encodeURIComponent(page.pageId)}`,
          ensureTrailingSlash(baseUrl)
        )
        : new URL("rest/api/content", ensureTrailingSlash(baseUrl));
      url.searchParams.set("expand", "space,version");
      if (!page.pageId) {
        url.searchParams.set("spaceKey", page.spaceKey);
        url.searchParams.set("title", page.title);
      }
      const body = await fetchSourceJson({
        fetchImpl,
        url: url.toString(),
        headers: confluenceHeaders(authMode, config.username, credential),
        timeoutMs,
        sourceLabel: "Confluence",
        authorizationMessage: confluenceAuthorizationMessage(authMode)
      });
      const resolved = page.pageId ? body : body?.results?.[0];
      if (
        !resolved
        || !/^\d+$/.test(String(resolved.id))
        || typeof resolved.title !== "string"
        || typeof resolved.space?.key !== "string"
      ) {
        throw new SourceConnectionValidationError(
          "source_page_not_found",
          "configuration",
          "Confluence could not resolve one of the configured root pages."
        );
      }
      roots.push({
        id: String(resolved.id),
        title: resolved.title,
        spaceKey: resolved.space.key,
        url: page.originalUrl
      });
    }
    return { baseUrl, authMode, roots };
  };
}

function parseConfluencePageUrl(value, allowedHosts, allowInsecureLoopback) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SourceConnectionValidationError(
      "invalid_source_url",
      "configuration",
      "The Confluence page URL is invalid."
    );
  }
  if (url.username || url.password || url.hash) {
    throw new SourceConnectionValidationError(
      "invalid_source_url",
      "configuration",
      "The Confluence page URL cannot contain credentials or a fragment."
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const displayIndex = segments.findIndex((segment) => segment.toLowerCase() === "display");
  const spacesIndex = segments.findIndex((segment) => segment.toLowerCase() === "spaces");
  const pagesIndex = segments.findIndex((segment) => segment.toLowerCase() === "pages");
  let pageId = url.searchParams.get("pageId");
  let baseSegments;
  let spaceKey;
  let title;
  if (displayIndex >= 0 && segments.length > displayIndex + 2) {
    baseSegments = segments.slice(0, displayIndex);
    spaceKey = decodeURIComponent(segments[displayIndex + 1]);
    title = decodeURIComponent(segments.slice(displayIndex + 2).join("/").replaceAll("+", " "));
  } else if (
    spacesIndex >= 0
    && pagesIndex === spacesIndex + 2
    && segments.length > pagesIndex + 1
  ) {
    baseSegments = segments.slice(0, spacesIndex);
    spaceKey = decodeURIComponent(segments[spacesIndex + 1]);
    pageId = decodeURIComponent(segments[pagesIndex + 1]);
  } else if (pagesIndex >= 0 && pageId) {
    baseSegments = segments.slice(0, pagesIndex);
  } else {
    throw new SourceConnectionValidationError(
      "invalid_source_url",
      "configuration",
      "Enter a Confluence page URL, not only the Confluence base URL."
    );
  }
  const baseUrl = new URL(url.origin);
  baseUrl.pathname = baseSegments.length > 0 ? `/${baseSegments.join("/")}` : "/";
  validateBaseUrl(baseUrl.toString(), allowedHosts, { allowInsecureLoopback });
  return {
    originalUrl: url.toString(),
    baseUrl: baseUrl.toString().replace(/\/+$/, ""),
    ...(pageId ? { pageId } : {}),
    ...(spaceKey ? { spaceKey } : {}),
    ...(title ? { title } : {})
  };
}

async function fetchSourceJson({
  fetchImpl,
  url,
  headers,
  timeoutMs,
  sourceLabel,
  authorizationMessage
}) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: abortController.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new SourceConnectionValidationError(
        "source_authorization_failed",
        "authorization",
        authorizationMessage ?? `${sourceLabel} rejected the supplied credential.`,
        "authorization-expired"
      );
    }
    if (!response.ok) {
      throw new SourceConnectionValidationError(
        "source_validation_failed",
        "provider",
        `${sourceLabel} validation failed with status ${response.status}.`
      );
    }
    return typeof response.json === "function"
      ? await response.json()
      : JSON.parse(await response.text());
  } catch (error) {
    if (error instanceof SourceConnectionValidationError) throw error;
    throw new SourceConnectionValidationError(
      "source_unavailable",
      "network",
      error?.name === "AbortError"
        ? `${sourceLabel} request timed out.`
        : `${sourceLabel} could not be reached.`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function validateConfluenceRootPages({
  config,
  credential,
  fetchImpl,
  hostAllowlist,
  allowInsecureLoopback,
  timeoutMs
}) {
  const baseUrl = validateBaseUrl(config.baseUrl, hostAllowlist, { allowInsecureLoopback });
  const allowedSpaces = new Set(config.spaceKeys);
  for (const rootPageRef of config.rootPageRefs) {
    const [pageId, spaceKey] = rootPageRef.split(":");
    if (!allowedSpaces.has(spaceKey)) {
      throw new SourceConnectionValidationError(
        "source_page_not_allowed",
        "configuration",
        "A Confluence root page belongs to a space outside the configured scope."
      );
    }
    const url = new URL(
      `rest/api/content/${encodeURIComponent(pageId)}`,
      ensureTrailingSlash(baseUrl)
    );
    url.searchParams.set("expand", "space");
    const page = await fetchSourceJson({
      fetchImpl,
      url: url.toString(),
      headers: confluenceHeaders(config.authMode, config.username, credential),
      timeoutMs,
      sourceLabel: "Confluence",
      authorizationMessage: confluenceAuthorizationMessage(config.authMode)
    });
    if (String(page?.id) !== pageId || page?.space?.key !== spaceKey) {
      throw new SourceConnectionValidationError(
        "source_page_not_found",
        "configuration",
        "Confluence could not validate one of the configured root pages."
      );
    }
  }
}

function buildValidationRequest(
  source,
  config,
  credential,
  allowedHosts,
  allowedInsecureHosts,
  allowInsecureLoopback
) {
  if (source === "github") {
    const repositories = typeof config.repositories === "string"
      ? [config.repositories]
      : config.repositories;
    const repository = repositories?.[0];
    if (
      typeof repository !== "string"
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
        .test(repository)
    ) {
      throw new SourceConnectionValidationError(
        "invalid_repository",
        "configuration",
        "GitHub repository must use owner/name syntax."
      );
    }
    const baseUrl = validateBaseUrl(config.apiUrl ?? DEFAULT_GITHUB_API_URL, allowedHosts, {
      allowDefaultGitHub: true,
      allowedInsecureHosts,
      allowInsecureLoopback
    });
    if (config.webBaseUrl) {
      validateBaseUrl(config.webBaseUrl, allowedHosts, {
        allowDefaultGitHub: true,
        allowedInsecureHosts,
        allowInsecureLoopback
      });
    }
    return {
      url: new URL(
        `repos/${encodeRepository(repository)}`,
        ensureTrailingSlash(baseUrl)
      ).toString(),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential}`,
        "user-agent": "tkl-source-connection-validator"
      }
    };
  }

  const baseUrl = validateBaseUrl(config.baseUrl, allowedHosts, {
    allowedInsecureHosts,
    allowInsecureLoopback
  });
  if (source === "jira") {
    const jiraUrl = new URL(baseUrl);
    if (
      jiraUrl.hostname.toLowerCase() === "jira.app.solera.com"
      && !jiraUrl.pathname.toLowerCase().startsWith("/jira")
    ) {
      throw new SourceConnectionValidationError(
        "invalid_source_url",
        "configuration",
        "Use https://jira.app.solera.com/jira as the Jira base URL."
      );
    }
    return {
      url: new URL(
        `rest/api/2/project/${encodeURIComponent(config.allowedProjects[0])}`,
        ensureTrailingSlash(baseUrl)
      ).toString(),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`
      }
    };
  }
  if (source === "testrail") {
    const url = new URL("index.php", ensureTrailingSlash(baseUrl));
    url.search = `/api/v2/get_project/${encodeURIComponent(config.projectId)}`;
    return { url: url.toString(), headers: basicHeaders(config.username, credential) };
  }
  if (source === "confluence") {
    if (config.contentScope !== "space" && config.rootPageRefs?.length > 0) {
      const [pageId] = config.rootPageRefs[0].split(":");
      return {
        url: new URL(
          `rest/api/content/${encodeURIComponent(pageId)}`,
          ensureTrailingSlash(baseUrl)
        ).toString(),
        headers: confluenceHeaders(config.authMode, config.username, credential),
        authorizationMessage: confluenceAuthorizationMessage(config.authMode)
      };
    }
    return {
      url: new URL(
        `rest/api/space/${encodeURIComponent(config.spaceKeys[0])}`,
        ensureTrailingSlash(baseUrl)
      ).toString(),
      headers: confluenceHeaders(config.authMode, config.username, credential),
      authorizationMessage: confluenceAuthorizationMessage(config.authMode)
    };
  }
  return {
    url: new URL(
      `api/v1/project/${encodeURIComponent(config.project)}`,
      ensureTrailingSlash(baseUrl)
    ).toString(),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential}`
    }
  };
}

function basicHeaders(username, credential) {
  return {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${username}:${credential}`, "utf8").toString("base64")}`
  };
}

function confluenceHeaders(authMode, username, credential) {
  if (authMode === "bearer") {
    return {
      accept: "application/json",
      authorization: `Bearer ${credential}`
    };
  }
  return basicHeaders(username, credential);
}

function confluenceAuthorizationMessage(authMode) {
  return authMode === "bearer"
    ? "Confluence rejected the personal access token. Verify that the PAT is active and can read the selected pages."
    : "Confluence Cloud rejected the account email or API token.";
}

function inferConfluenceAuthMode(baseUrl) {
  return new URL(baseUrl).hostname.toLowerCase().endsWith(".atlassian.net")
    ? "basic"
    : "bearer";
}

function validateBaseUrl(
  value,
  allowedHosts,
  {
    allowDefaultGitHub = false,
    allowedInsecureHosts = new Set(),
    allowInsecureLoopback = false
  } = {}
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SourceConnectionValidationError(
      "invalid_source_url",
      "configuration",
      "The source URL is invalid."
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SourceConnectionValidationError(
      "invalid_source_url",
      "configuration",
      "The source URL cannot contain credentials, query parameters, or fragments."
    );
  }
  const host = url.hostname.toLowerCase();
  const insecureHostAllowed =
    url.protocol === "http:" && allowedInsecureHosts.has(host);
  if (
    url.protocol !== "https:"
    && !insecureHostAllowed
    && !(allowInsecureLoopback && url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new SourceConnectionValidationError(
      "insecure_source_url",
      "configuration",
      "The source URL must use HTTPS."
    );
  }
  const allowed =
    allowedHosts.has(host)
    || (allowDefaultGitHub && host === "api.github.com")
    || (allowInsecureLoopback && isLoopback(host));
  if (!allowed) {
    throw new SourceConnectionValidationError(
      "source_host_not_allowed",
      "configuration",
      "The source host must be approved by the deployment administrator."
    );
  }
  return url;
}

function ensureTrailingSlash(url) {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

function encodeRepository(repository) {
  const [owner, name, ...rest] = repository.split("/");
  const validOwner =
    typeof owner === "string"
    && owner.length <= 39
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner);
  const validName =
    typeof name === "string"
    && name.length <= 100
    && name !== "."
    && name !== ".."
    && /^[A-Za-z0-9._-]+$/.test(name);
  if (!validOwner || !validName || rest.length > 0) {
    throw new SourceConnectionValidationError(
      "invalid_repository",
      "configuration",
      "GitHub repositories must use the owner/repository format."
    );
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
