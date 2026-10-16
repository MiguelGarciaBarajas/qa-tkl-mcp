import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourceConnectionValidator,
  createConfluencePageDiscoverer,
  createTestRailSuiteDiscoverer,
  SourceConnectionValidationError
} from "../src/source-connection-validation.js";

test("validates GitHub against the first allowlisted repository without leaking the token", async () => {
  let received;
  const validator = createSourceConnectionValidator({
    async fetchImpl(url, init) {
      received = { url, init };
      return { ok: true, status: 200 };
    }
  });

  await validator({
    source: "github",
    config: { repositories: ["Solera-Engineering/qa-tkl-mcp-f5"] },
    credential: "synthetic-token"
  });

  assert.equal(
    received.url,
    "https://api.github.com/repos/Solera-Engineering/qa-tkl-mcp-f5"
  );
  assert.equal(received.init.headers.authorization, "Bearer synthetic-token");
});

test("requires non-GitHub source hosts to be deployment-allowlisted", async () => {
  const validator = createSourceConnectionValidator({
    async fetchImpl() {
      throw new Error("must not be called");
    }
  });

  await assert.rejects(
    () => validator({
      source: "jira",
      config: {
        baseUrl: "https://jira.example",
        allowedProjects: ["STT"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "source_host_not_allowed"
  );
});

test("allows only api.github.com by default and rejects an arbitrary GitHub API host", async () => {
  const validator = createSourceConnectionValidator({
    async fetchImpl() {
      throw new Error("must not be called");
    }
  });

  await assert.rejects(
    () => validator({
      source: "github",
      config: {
        apiUrl: "https://internal-admin.example",
        repositories: ["owner/repository"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "source_host_not_allowed"
  );
});

test("preserves the configured GitHub Enterprise API path prefix", async () => {
  let requestedUrl;
  const validator = createSourceConnectionValidator({
    allowedHosts: ["ghe.example"],
    async fetchImpl(url) {
      requestedUrl = url;
      return { ok: true, status: 200 };
    }
  });

  await validator({
    source: "github",
    config: {
      apiUrl: "https://ghe.example/api/v3",
      webBaseUrl: "https://ghe.example",
      repositories: ["owner/repository"]
    },
    credential: "synthetic-token"
  });

  assert.equal(requestedUrl, "https://ghe.example/api/v3/repos/owner/repository");
});

test("rejects GitHub repository dot segments before constructing the validation URL", async () => {
  let calls = 0;
  const validator = createSourceConnectionValidator({
    async fetchImpl() {
      calls += 1;
      return { ok: true, status: 200 };
    }
  });

  for (const repository of ["../rate_limit", "owner/..", "./repository"]) {
    await assert.rejects(
      () => validator({
        source: "github",
        config: { repositories: [repository] },
        credential: "synthetic-token"
      }),
      (error) =>
        error instanceof SourceConnectionValidationError
        && error.code === "invalid_repository"
    );
  }
  assert.equal(calls, 0);
});

test("rejects loopback source URLs unless the explicit development option is enabled", async () => {
  let calls = 0;
  const blocked = createSourceConnectionValidator({
    async fetchImpl() {
      calls += 1;
      return { ok: true, status: 200 };
    }
  });
  await assert.rejects(
    () => blocked({
      source: "jira",
      config: {
        baseUrl: "http://127.0.0.1:8080",
        allowedProjects: ["STT"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "insecure_source_url"
  );
  assert.equal(calls, 0);

  const allowed = createSourceConnectionValidator({
    allowInsecureLoopback: true,
    async fetchImpl() {
      calls += 1;
      return { ok: true, status: 200 };
    }
  });
  await allowed({
    source: "jira",
    config: {
      baseUrl: "http://127.0.0.1:8080",
      allowedProjects: ["STT"]
    },
    credential: "synthetic-token"
  });
  assert.equal(calls, 2);
});

test("maps source authorization failures to an expired authorization state", async () => {
  const validator = createSourceConnectionValidator({
    allowedHosts: ["jira.example"],
    async fetchImpl() {
      return { ok: false, status: 401 };
    }
  });

  await assert.rejects(
    () => validator({
      source: "jira",
      config: {
        baseUrl: "https://jira.example",
        allowedProjects: ["STT"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.connectionStatus === "authorization-expired"
      && !error.message.includes("synthetic-token")
  );
});

test("explains the required Solera Jira context path before making a request", async () => {
  let calls = 0;
  const validator = createSourceConnectionValidator({
    allowedHosts: ["jira.app.solera.com"],
    async fetchImpl() {
      calls += 1;
      return { ok: true, status: 200 };
    }
  });

  await assert.rejects(
    () => validator({
      source: "jira",
      config: {
        baseUrl: "https://jira.app.solera.com/",
        allowedProjects: ["STT"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "invalid_source_url"
      && error.message === "Use https://jira.app.solera.com/jira as the Jira base URL."
  );
  assert.equal(calls, 0);
});

test("explains that GitHub 404 can mean private repository access was denied", async () => {
  const validator = createSourceConnectionValidator({
    async fetchImpl() {
      return { ok: false, status: 404 };
    }
  });

  await assert.rejects(
    () => validator({
      source: "github",
      config: {
        repositories: ["Solera-Engineering/qa-titletec-fl-automation-pw"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "github_repository_not_accessible"
      && error.category === "authorization"
      && error.message.includes("organization SSO or approval")
      && !error.message.includes("synthetic-token")
  );
});

test("validates the Jira PAT before checking the configured project", async () => {
  const requestedUrls = [];
  const validator = createSourceConnectionValidator({
    allowedHosts: ["jira.app.solera.com"],
    async fetchImpl(url) {
      requestedUrls.push(url);
      return { ok: true, status: 200 };
    }
  });

  await validator({
    source: "jira",
    config: {
      baseUrl: "https://jira.app.solera.com/jira",
      allowedProjects: ["STT"]
    },
    credential: "synthetic-token"
  });

  assert.deepEqual(requestedUrls, [
    "https://jira.app.solera.com/jira/rest/api/2/myself",
    "https://jira.app.solera.com/jira/rest/api/2/project/STT"
  ]);
});

test("distinguishes a valid Jira PAT from a missing or inaccessible project", async () => {
  let calls = 0;
  const validator = createSourceConnectionValidator({
    allowedHosts: ["jira.app.solera.com"],
    async fetchImpl() {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200 }
        : { ok: false, status: 404 };
    }
  });

  await assert.rejects(
    () => validator({
      source: "jira",
      config: {
        baseUrl: "https://jira.app.solera.com/jira",
        allowedProjects: ["STT"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "source_project_not_accessible"
      && error.message.includes('project "STT"')
  );
});

test("blocks insecure non-loopback source URLs before any network request", async () => {
  const validator = createSourceConnectionValidator({
    allowedHosts: ["jira.example"],
    async fetchImpl() {
      throw new Error("must not be called");
    }
  });

  await assert.rejects(
    () => validator({
      source: "jira",
      config: {
        baseUrl: "http://jira.example",
        allowedProjects: ["STT"]
      },
      credential: "synthetic-token"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "insecure_source_url"
  );
});

test("allows HTTP only for an explicitly approved internal source host", async () => {
  let requestedUrl;
  const validator = createSourceConnectionValidator({
    allowedHosts: ["reportportal.internal"],
    allowedInsecureHosts: ["reportportal.internal"],
    async fetchImpl(url) {
      requestedUrl = url;
      return { ok: true, status: 200 };
    }
  });

  await validator({
    source: "reportportal",
    config: {
      baseUrl: "http://reportportal.internal:8080",
      project: "fl_titling"
    },
    credential: "synthetic-token"
  });

  assert.equal(
    requestedUrl,
    "http://reportportal.internal:8080/api/v1/project/fl_titling"
  );
});

test("discovers and sanitizes TestRail suites without exposing the API key", async () => {
  let received;
  const discover = createTestRailSuiteDiscoverer({
    allowedHosts: ["testrail.example"],
    async fetchImpl(url, init) {
      received = { url, init };
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { id: 8, name: "Regression", is_completed: false, secret: "ignored" },
            { id: 4, name: " Automation ", is_completed: true },
          ];
        }
      };
    }
  });

  const suites = await discover({
    config: {
      baseUrl: "https://testrail.example",
      username: "qa@example.com",
      projectId: "128"
    },
    credential: "synthetic-api-key"
  });

  assert.equal(
    received.url,
    "https://testrail.example/index.php?/api/v2/get_suites/128"
  );
  assert.match(received.init.headers.authorization, /^Basic /);
  assert.equal(received.init.headers.authorization.includes("synthetic-api-key"), false);
  assert.deepEqual(suites, [
    { id: "4", name: "Automation", isCompleted: true },
    { id: "8", name: "Regression", isCompleted: false },
  ]);
  assert.equal(JSON.stringify(suites).includes("secret"), false);
});

test("resolves a Confluence display URL to a canonical root page", async () => {
  let received;
  const discover = createConfluencePageDiscoverer({
    allowedHosts: ["wiki.example"],
    async fetchImpl(url, init) {
      received = { url, init };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: [{
              id: "42",
              title: "Product 2.0",
              space: { key: "QA" }
            }]
          };
        }
      };
    }
  });

  const discovery = await discover({
    config: {
      username: "qa@example.com",
      authMode: "basic",
      rootPageUrls: ["https://wiki.example/confluence/display/QA/Product+2.0"]
    },
    credential: "synthetic-api-key"
  });

  const requestedUrl = new URL(received.url);
  assert.equal(requestedUrl.pathname, "/confluence/rest/api/content");
  assert.equal(requestedUrl.searchParams.get("spaceKey"), "QA");
  assert.equal(requestedUrl.searchParams.get("title"), "Product 2.0");
  assert.deepEqual(discovery, {
    baseUrl: "https://wiki.example/confluence",
    authMode: "basic",
    roots: [{
      id: "42",
      title: "Product 2.0",
      spaceKey: "QA",
      url: "https://wiki.example/confluence/display/QA/Product+2.0"
    }]
  });
  assert.equal(received.init.headers.authorization.includes("synthetic-api-key"), false);
});

test("resolves a modern Confluence Cloud page URL", async () => {
  let requestedUrl;
  const discover = createConfluencePageDiscoverer({
    allowedHosts: ["company.atlassian.net"],
    async fetchImpl(url) {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: "123456", title: "Requirements", space: { key: "QA" } };
        }
      };
    }
  });

  test("uses a bearer PAT when discovering pages from self-hosted Confluence", async () => {
    let authorization;
    const discover = createConfluencePageDiscoverer({
      allowedHosts: ["wiki.example"],
      async fetchImpl(_url, init) {
        authorization = init.headers.authorization;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              results: [{ id: "42", title: "Product", space: { key: "QA" } }]
            };
          }
        };
      }
    });

    const discovery = await discover({
      config: {
        username: "qa@example.com",
        authMode: "bearer",
        rootPageUrls: ["https://wiki.example/confluence/display/QA/Product"]
      },
      credential: "personal-access-token"
    });

    assert.equal(authorization, "Bearer personal-access-token");
    assert.equal(discovery.authMode, "bearer");
  });

  const discovery = await discover({
    config: {
      username: "qa@example.com",
      rootPageUrls: [
        "https://company.atlassian.net/wiki/spaces/QA/pages/123456/Requirements"
      ]
    },
    credential: "synthetic-api-key"
  });

  assert.equal(
    requestedUrl,
    "https://company.atlassian.net/wiki/rest/api/content/123456?expand=space%2Cversion"
  );
  assert.equal(discovery.baseUrl, "https://company.atlassian.net/wiki");
  assert.equal(discovery.authMode, "basic");
  assert.deepEqual(discovery.roots[0], {
    id: "123456",
    title: "Requirements",
    spaceKey: "QA",
    url: "https://company.atlassian.net/wiki/spaces/QA/pages/123456/Requirements"
  });
});

test("validates every configured Confluence root and its canonical space", async () => {
  const requestedIds = [];
  const validator = createSourceConnectionValidator({
    allowedHosts: ["wiki.example"],
    async fetchImpl(url) {
      const pageId = new URL(url).pathname.split("/").at(-1);
      requestedIds.push(pageId);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: pageId,
            title: `Page ${pageId}`,
            space: { key: pageId === "10" ? "QA" : "DOC" }
          };
        }
      };
    }
  });

  await validator({
    source: "confluence",
    config: {
      baseUrl: "https://wiki.example/confluence",
      username: "qa@example.com",
      contentScope: "tree",
      spaceKeys: ["QA", "DOC"],
      rootPageRefs: ["10:QA", "20:DOC"]
    },
    credential: "synthetic-api-key"
  });

  assert.deepEqual(requestedIds, ["10", "20"]);
});

test("rejects a Confluence root whose response belongs to another space", async () => {
  const validator = createSourceConnectionValidator({
    allowedHosts: ["wiki.example"],
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: "10", title: "Wrong space", space: { key: "OTHER" } };
        }
      };
    }
  });

  await assert.rejects(
    () => validator({
      source: "confluence",
      config: {
        baseUrl: "https://wiki.example/confluence",
        username: "qa@example.com",
        contentScope: "page",
        spaceKeys: ["QA"],
        rootPageRefs: ["10:QA"]
      },
      credential: "synthetic-api-key"
    }),
    (error) =>
      error instanceof SourceConnectionValidationError
      && error.code === "source_page_not_found"
  );
});
