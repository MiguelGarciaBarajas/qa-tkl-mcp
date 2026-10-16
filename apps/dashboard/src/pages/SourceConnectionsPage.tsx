import { useRef, useState } from "react";
import { getTklApiClient } from "../api/client";
import { useAsync } from "../api/useAsync";
import { Icon } from "../components/Icon";
import type {
  ConfluencePageDiscovery,
  GitHubRepository,
  GitHubRepositoryLifecycle,
  GitHubRepositoryPurpose,
  SourceConnection,
  SourceConnectionId,
  SourceConnectionStatus,
  TestRailSuite,
} from "../contracts/types";

interface FieldDefinition {
  name: string;
  label: string;
  placeholder: string;
  hint?: string;
  type?: "email" | "url" | "text";
  list?: boolean;
  optional?: boolean;
  fullWidth?: boolean;
}

const FIELDS: Record<SourceConnectionId, FieldDefinition[]> = {
  jira: [
    {
      name: "baseUrl",
      label: "Jira base URL",
      placeholder: "https://jira.app.solera.com/jira",
      type: "url",
      hint: "For Solera Jira, include the /jira path.",
    },
    {
      name: "allowedProjects",
      label: "Jira project key",
      placeholder: "ABC",
      list: true,
      hint: "The short project key shown before the issue number, for example ABC in ABC-123.",
    },
    {
      name: "allowedJql",
      label: "JQL filter",
      placeholder: "project = ABC AND component = TEAM_COMPONENT",
      hint: "Enter a complete Jira query and limit it to the scope approved for this workspace.",
    },
  ],
  github: [],
  testrail: [
    { name: "baseUrl", label: "TestRail URL", placeholder: "https://testrail.example.com", type: "url" },
    { name: "username", label: "Account email", placeholder: "name@company.com", type: "email" },
    { name: "projectId", label: "Project ID", placeholder: "12" },
  ],
  confluence: [
    {
      name: "rootPageUrls",
      label: "Confluence root page URLs",
      placeholder: "https://wiki.example.com/confluence/display/SPACE/Page",
      list: true,
      fullWidth: true,
      hint: "Paste one or more root page URLs separated by commas. TKL resolves their canonical page IDs and spaces.",
    },
    { name: "username", label: "Account email", placeholder: "name@company.com", type: "email" },
  ],
  reportportal: [
    {
      name: "baseUrl",
      label: "ReportPortal URL",
      placeholder: "http://reportportal.example.com:8080/ui/#project/dashboard/123",
      type: "url",
      hint: "Paste the ReportPortal dashboard URL. TKL derives the API base URL and project identifier.",
    },
    {
      name: "project",
      label: "Project identifier",
      placeholder: "fl_titling",
      fullWidth: true,
      hint: "Use the identifier shown after # in the ReportPortal URL, not the dashboard display name.",
    },
  ],
};

const SOURCE_META: Record<SourceConnectionId, { initial: string; description: string }> = {
  jira: { initial: "J", description: "Stories, acceptance criteria and defect context" },
  github: { initial: "G", description: "Automation, pull requests and code evidence" },
  testrail: { initial: "T", description: "Manual coverage, runs and execution results" },
  confluence: { initial: "C", description: "Approved requirement and product documentation" },
  reportportal: { initial: "R", description: "Launches, test execution and defect signals" },
};

const CREDENTIAL_META: Record<SourceConnectionId, { label: string; hint: string }> = {
  jira: {
    label: "Jira personal access token (PAT)",
    hint: "Paste your Jira PAT. TKL sends it to Jira as a Bearer token, stores it encrypted, and never displays it again.",
  },
  github: {
    label: "GitHub personal access token",
    hint: "Paste a token with read access to the selected repository.",
  },
  testrail: {
    label: "Credential",
    hint: "Paste the API key associated with the TestRail account email above.",
  },
  confluence: {
    label: "Confluence token",
    hint: "For company-hosted Confluence, use a personal access token (PAT). For atlassian.net, use the API token associated with the account email. TKL selects the correct authentication method from the page URL.",
  },
  reportportal: {
    label: "ReportPortal API token",
    hint: "Paste a token with read access to the selected ReportPortal project.",
  },
};

const DEFAULT_CONFIG: Partial<Record<SourceConnectionId, Record<string, string>>> = {
  jira: {
    baseUrl: "https://jira.app.solera.com/jira",
  },
};

const STATUS_LABEL: Record<SourceConnectionStatus, string> = {
  "not-connected": "Not connected",
  validating: "Validating",
  connected: "Connected",
  syncing: "Syncing",
  stale: "Stale",
  "authorization-expired": "Authorization expired",
  error: "Error",
  disabled: "Disabled",
};

const STATUS_CLASS: Record<SourceConnectionStatus, string> = {
  "not-connected": "badge badge--muted",
  validating: "badge badge--pending",
  connected: "badge badge--ok",
  syncing: "badge badge--pending",
  stale: "badge badge--warn",
  "authorization-expired": "badge badge--error",
  error: "badge badge--error",
  disabled: "badge badge--muted",
};

interface Draft {
  credential: string;
  config: Record<string, string>;
}

interface GitHubRepositoryDraft {
  url: string;
  purpose: GitHubRepositoryPurpose;
  lifecycle: GitHubRepositoryLifecycle;
  enabled: boolean;
}

const EMPTY_GITHUB_REPOSITORY_DRAFT: GitHubRepositoryDraft = {
  url: "",
  purpose: "quality-evidence",
  lifecycle: "active",
  enabled: true,
};

const REPOSITORY_PURPOSE_LABEL: Record<GitHubRepositoryPurpose, string> = {
  application: "Application",
  "test-automation": "Test automation",
  "quality-evidence": "Quality evidence",
  documentation: "Documentation",
  "shared-library": "Shared library",
  other: "Other",
};

const REPOSITORY_LIFECYCLE_LABEL: Record<GitHubRepositoryLifecycle, string> = {
  active: "Active",
  maintenance: "Maintenance",
  deprecated: "Deprecated",
  archived: "Archived",
};

export function SourceConnectionsPage() {
  const [generation, setGeneration] = useState(0);
  const { data, loading, error } = useAsync(
    () => getTklApiClient().getSourceConnections(),
    [generation],
  );
  const [drafts, setDrafts] = useState<Partial<Record<SourceConnectionId, Draft>>>({});
  const [pendingSource, setPendingSource] = useState<SourceConnectionId | null>(null);
  const [actionErrors, setActionErrors] = useState<Partial<Record<SourceConnectionId, string>>>({});
  const [testRailSuites, setTestRailSuites] = useState<TestRailSuite[] | null>(null);
  const [discoveringTestRail, setDiscoveringTestRail] = useState(false);
  const [confluenceDiscovery, setConfluenceDiscovery] =
    useState<ConfluencePageDiscovery | null>(null);
  const [discoveringConfluence, setDiscoveringConfluence] = useState(false);
  const confluenceDiscoveryRequest = useRef(0);
  const [repositoryDraft, setRepositoryDraft] =
    useState<GitHubRepositoryDraft>(EMPTY_GITHUB_REPOSITORY_DRAFT);
  const [editingRepositoryId, setEditingRepositoryId] = useState<string | null>(null);
  const [pendingRepositoryId, setPendingRepositoryId] = useState<string | null>(null);
  const [repositoryErrors, setRepositoryErrors] = useState<Record<string, string | undefined>>({});

  if (loading && !data) return <p>Loading source connections…</p>;
  if (error) return <p role="alert">Failed to load source connections: {error.message}</p>;

  const updateDraft = (source: SourceConnectionId, field: "credential" | string, value: string) => {
    if (
      source === "confluence"
      && (field === "rootPageUrls" || field === "username" || field === "credential")
    ) {
      confluenceDiscoveryRequest.current += 1;
      setConfluenceDiscovery(null);
      setDiscoveringConfluence(false);
    }
    setDrafts((current) => {
      const draft = current[source] ?? { credential: "", config: {} };
      return {
        ...current,
        [source]: field === "credential"
          ? { ...draft, credential: value }
          : { ...draft, config: { ...draft.config, [field]: value } },
      };
    });
  };

  const runAction = async (
    source: SourceConnectionId,
    action: () => Promise<SourceConnection>,
  ) => {
    setPendingSource(source);
    setActionErrors((current) => ({ ...current, [source]: undefined }));
    try {
      await action();
      setGeneration((current) => current + 1);
    } catch (actionError) {
      setActionErrors((current) => ({
        ...current,
        [source]: friendlyActionError(
          source,
          actionError instanceof Error ? actionError.message : "The operation failed.",
        ),
      }));
    } finally {
      setPendingSource(null);
    }
  };

  const cancelConnection = async (connection: SourceConnection) => {
    setPendingSource(connection.source);
    setActionErrors((current) => ({ ...current, [connection.source]: undefined }));
    try {
      await getTklApiClient().cancelSourceConnectionSync(connection.source);
      setGeneration((current) => current + 1);
    } catch (actionError) {
      setActionErrors((current) => ({
        ...current,
        [connection.source]: friendlyActionError(
          connection.source,
          actionError instanceof Error ? actionError.message : "Cancellation failed.",
        ),
      }));
    } finally {
      setPendingSource(null);
    }
  };

  const connect = async (connection: SourceConnection) => {
    const draft = drafts[connection.source] ?? { credential: "", config: {} };
    await runAction(connection.source, async () => {
      validateDraft(connection, draft, confluenceDiscovery);
      const config = Object.fromEntries(
        FIELDS[connection.source].flatMap((field) => {
          const raw = draft.config[field.name] ?? configValue(connection, field.name);
          const normalizedRaw = serializeFieldInput(connection.source, field.name, raw);
          const value = field.list
            ? normalizedRaw.split(",").map((item) => item.trim()).filter(Boolean)
            : normalizedRaw.trim();
          return field.optional && (Array.isArray(value) ? value.length === 0 : !value)
            ? []
            : [[field.name, value]];
        }),
      );
      if (connection.source === "github") {
        const configuredRepositories = githubRepositoryNames(connection);
        const initialRepository = configuredRepositories[0]
          ?? (repositoryDraft.url.trim()
            ? parseGithubRepositoryUrl(repositoryDraft.url).repository
            : undefined);
        if (!initialRepository) {
          throw new Error("Enter a GitHub repository URL before connecting.");
        }
        Object.assign(config, {
          repositories: configuredRepositories.length > 0
            ? configuredRepositories
            : [initialRepository],
          ...(repositoryDraft.url
            ? githubServerConfig(repositoryDraft.url)
            : githubExistingServerConfig(connection)),
        });
      }
      if (connection.source === "testrail") {
        const suiteScope = testRailSuiteScope(connection, draft);
        Object.assign(config, { suiteScope });
        if (suiteScope === "selected") {
          Object.assign(config, {
            suiteIds: testRailSelectedSuiteIds(connection, draft),
          });
        }
      }
      if (connection.source === "confluence") {
        const discovery = confluenceDiscovery;
        if (!discovery) throw new Error("Load the Confluence root pages before connecting.");
        const contentScope = confluenceContentScope(connection, draft);
        Object.assign(config, {
          baseUrl: discovery.baseUrl,
          authMode: discovery.authMode,
          contentScope,
          spaceKeys: [...new Set(discovery.roots.map((root) => root.spaceKey))],
        });
        if (contentScope !== "space") {
          Object.assign(config, {
            rootPageRefs: discovery.roots.map((root) => `${root.id}:${root.spaceKey}`),
          });
        }
      }
      const saved = await getTklApiClient().saveSourceConnection(connection.source, {
        credential: draft.credential,
        config,
      });
      setDrafts((current) => ({
        ...current,
        [connection.source]: { credential: "", config: {} },
      }));
      return saved;
    });
  };

  const discoverTestRail = async (connection: SourceConnection) => {
    const draft = drafts.testrail ?? { credential: "", config: {} };
    const baseUrl = draft.config.baseUrl ?? configValue(connection, "baseUrl");
    const username = draft.config.username ?? configValue(connection, "username");
    const projectId = draft.config.projectId ?? configValue(connection, "projectId");
    if (!baseUrl.trim() || !username.trim() || !projectId.trim() || !draft.credential.trim()) {
      setActionErrors((current) => ({
        ...current,
        testrail: "Complete the TestRail URL, account email, project ID, and API key before loading suites.",
      }));
      return;
    }
    setDiscoveringTestRail(true);
    setActionErrors((current) => ({ ...current, testrail: undefined }));
    try {
      const suites = await getTklApiClient().discoverTestRailSuites({
        credential: draft.credential,
        config: { baseUrl, username, projectId },
      });
      setTestRailSuites(suites);
    } catch (discoveryError) {
      setActionErrors((current) => ({
        ...current,
        testrail: discoveryError instanceof Error
          ? discoveryError.message
          : "TestRail suites could not be loaded.",
      }));
    } finally {
      setDiscoveringTestRail(false);
    }
  };

  const discoverConfluence = async (connection: SourceConnection) => {
    const draft = drafts.confluence ?? { credential: "", config: {} };
    const username = draft.config.username ?? configValue(connection, "username");
    const rootPageUrls = confluenceRootPageUrls(connection, draft);
    if (!username.trim() || rootPageUrls.length === 0 || !draft.credential.trim()) {
      setActionErrors((current) => ({
        ...current,
        confluence: "Enter at least one Confluence root page URL, the account email, and the API token before loading pages.",
      }));
      return;
    }
    const requestId = confluenceDiscoveryRequest.current + 1;
    confluenceDiscoveryRequest.current = requestId;
    setDiscoveringConfluence(true);
    setActionErrors((current) => ({ ...current, confluence: undefined }));
    try {
      const discovery = await getTklApiClient().discoverConfluencePages({
        credential: draft.credential,
        config: {
          username,
          rootPageUrls,
          authMode: confluenceAuthMode(rootPageUrls),
        },
      });
      if (confluenceDiscoveryRequest.current === requestId) {
        setConfluenceDiscovery(discovery);
      }
    } catch (discoveryError) {
      if (confluenceDiscoveryRequest.current === requestId) {
        setActionErrors((current) => ({
          ...current,
          confluence: discoveryError instanceof Error
            ? discoveryError.message
            : "Confluence root pages could not be loaded.",
        }));
      }
    } finally {
      if (confluenceDiscoveryRequest.current === requestId) {
        setDiscoveringConfluence(false);
      }
    }
  };

  const persistedSyncingSource = (data ?? []).find(
    (connection) => connection.status === "syncing",
  )?.source;
  const activeSyncSource = persistedSyncingSource;

  const resetRepositoryEditor = () => {
    setEditingRepositoryId(null);
    setRepositoryDraft(EMPTY_GITHUB_REPOSITORY_DRAFT);
    setRepositoryErrors((current) => ({ ...current, form: undefined }));
  };

  const editRepository = (repository: GitHubRepository) => {
    setEditingRepositoryId(repository.id);
    setRepositoryDraft({
      url: repository.url,
      purpose: repository.purpose,
      lifecycle: repository.lifecycle,
      enabled: repository.enabled,
    });
    setRepositoryErrors((current) => ({ ...current, form: undefined }));
  };

  const saveRepository = async () => {
    const githubConnection = (data ?? []).find((connection) => connection.source === "github");
    if (!githubConnection?.configured) {
      setRepositoryErrors((current) => ({
        ...current,
        form: "Connect the shared GitHub credential before adding repositories.",
      }));
      return;
    }
    let parsed: ReturnType<typeof parseGithubRepositoryUrl>;
    try {
      parsed = parseGithubRepositoryUrl(repositoryDraft.url);
    } catch {
      setRepositoryErrors((current) => ({
        ...current,
        form: "Enter the complete repository URL, for example https://github.com/owner/repository.",
      }));
      return;
    }
    const operationId = editingRepositoryId ?? "form";
    setPendingRepositoryId(operationId);
    setRepositoryErrors((current) => ({ ...current, form: undefined, [operationId]: undefined }));
    try {
      const request = {
        repository: parsed.repository,
        url: `${parsed.webBaseUrl}/${parsed.repository}`,
        purpose: repositoryDraft.purpose,
        lifecycle: repositoryDraft.lifecycle,
        enabled: repositoryDraft.lifecycle === "archived" ? false : repositoryDraft.enabled,
      };
      if (editingRepositoryId) {
        await getTklApiClient().updateGitHubRepository(editingRepositoryId, request);
      } else {
        await getTklApiClient().createGitHubRepository(request);
      }
      resetRepositoryEditor();
      setGeneration((current) => current + 1);
    } catch (repositoryError) {
      setRepositoryErrors((current) => ({
        ...current,
        [operationId]: friendlyActionError(
          "github",
          repositoryError instanceof Error ? repositoryError.message : "The operation failed.",
        ),
      }));
    } finally {
      setPendingRepositoryId(null);
    }
  };

  const runRepositoryAction = async (
    repositoryId: string,
    action: () => Promise<GitHubRepository>,
  ) => {
    setPendingRepositoryId(repositoryId);
    setRepositoryErrors((current) => ({ ...current, [repositoryId]: undefined }));
    try {
      await action();
      setGeneration((current) => current + 1);
    } catch (repositoryError) {
      setRepositoryErrors((current) => ({
        ...current,
        [repositoryId]: friendlyActionError(
          "github",
          repositoryError instanceof Error ? repositoryError.message : "The operation failed.",
        ),
      }));
    } finally {
      setPendingRepositoryId(null);
    }
  };

  const cancelRepositorySync = async (repository: GitHubRepository) => {
    await runRepositoryAction(
      repository.id,
      () => getTklApiClient().cancelGitHubRepositorySync(repository.id),
    );
  };

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="page-heading__eyebrow">Workspace setup</span>
          <h2>Source Connections</h2>
          <p className="page__hint">
            Authorize trusted systems for bounded, on-demand retrieval. Connecting a source
            does not start a broad synchronization. Each credential is encrypted immediately
            and can never be read back from the dashboard.
          </p>
        </div>
        <div className="security-callout">
          <Icon name="lock" size={19} />
          <div>
            <strong>Zero credential readback</strong>
            <span>{(data ?? []).filter((item) => item.configured).length} of {(data ?? []).length} sources connected</span>
          </div>
        </div>
      </div>
      <div className="connections-grid">
        {(data ?? []).map((connection) => {
          const draft = drafts[connection.source] ?? { credential: "", config: {} };
          const pending = pendingSource === connection.source;
          const activeSync = activeSyncSource === connection.source;
          const repositorySyncing = connection.source === "github"
            && (connection.repositories ?? []).some((repository) =>
              repository.syncStatus === "syncing"
            );
          const mutationsDisabled = pending || activeSync || repositorySyncing;
          const configured = connection.configured;
          const credentialLabel = configured
            ? connection.source === "testrail"
              ? "New credential (required to rotate)"
              : `New ${CREDENTIAL_META[connection.source].label} (required to rotate)`
            : CREDENTIAL_META[connection.source].label;
          const configurationIssue = getConfigurationIssue(
            connection,
            draft,
            confluenceDiscovery,
          );
          return (
            <article className={`card connection-card connection-card--${connection.status}`} key={connection.source}>
              <div className="connection-card__header">
                <div className="connection-card__identity">
                  <span className={`source-mark source-mark--${connection.source}`} aria-hidden="true">
                    {SOURCE_META[connection.source].initial}
                  </span>
                  <div>
                    <h3>{connection.displayName}</h3>
                    <p>{SOURCE_META[connection.source].description}</p>
                  </div>
                </div>
                <span className={STATUS_CLASS[connection.status]}>{STATUS_LABEL[connection.status]}</span>
              </div>
              {!connection.ingestionSupported && (
                <p className="page__notes">
                  Connection validation is available, but targeted retrieval is not implemented
                  for this source yet.
                </p>
              )}
              <form
                className="connection-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect(connection);
                }}
              >
                {FIELDS[connection.source].map((field) => (
                  <label
                    key={field.name}
                    htmlFor={`${connection.source}-${field.name}`}
                    className={field.fullWidth ? "connection-form__field--full" : undefined}
                  >
                    <span>{field.label}{!field.optional && <span className="required-mark" aria-hidden="true"> *</span>}</span>
                    <input
                      id={`${connection.source}-${field.name}`}
                      aria-label={field.label}
                      aria-required={!field.optional}
                      type={field.type ?? "text"}
                      value={draft.config[field.name] ?? configValue(connection, field.name)}
                      placeholder={field.placeholder}
                      disabled={mutationsDisabled}
                      required={!field.optional}
                      aria-describedby={field.hint ? `${connection.source}-${field.name}-hint` : undefined}
                      onChange={(event) => updateDraft(connection.source, field.name, event.target.value)}
                      onBlur={(event) => {
                        if (connection.source === "reportportal" && field.name === "baseUrl") {
                          try {
                            const location = parseReportPortalLocation(event.target.value);
                            updateDraft(connection.source, "baseUrl", location.baseUrl);
                            if (location.project) {
                              updateDraft(connection.source, "project", location.project);
                            }
                            return;
                          } catch {
                            // Leave invalid input visible so the form can explain it on submit.
                          }
                        }
                        const normalized = normalizeFieldInput(
                          connection.source,
                          field.name,
                          event.target.value,
                        );
                        if (normalized !== event.target.value) {
                          updateDraft(connection.source, field.name, normalized);
                        }
                      }}
                    />
                    {field.hint && <small id={`${connection.source}-${field.name}-hint`}>{field.hint}</small>}
                  </label>
                ))}
                {connection.source === "jira" && <JiraConnectionGuide />}
                <div className="credential-field">
                  <label htmlFor={`${connection.source}-credential`}>
                    <span>{credentialLabel}<span className="required-mark" aria-hidden="true"> *</span></span>
                  </label>
                  <div className="credential-field__control">
                    <input
                      id={`${connection.source}-credential`}
                      aria-label={credentialLabel}
                      type="password"
                      autoComplete="new-password"
                      value={draft.credential}
                      disabled={mutationsDisabled}
                      required
                      onChange={(event) => updateDraft(connection.source, "credential", event.target.value)}
                    />
                  </div>
                  <small>{CREDENTIAL_META[connection.source].hint}</small>
                </div>
                {connection.source === "testrail" && (
                  <TestRailScopeEditor
                    connection={connection}
                    draft={draft}
                    suites={testRailSuites}
                    discovering={discoveringTestRail}
                    disabled={mutationsDisabled}
                    updateDraft={updateDraft}
                    discover={() => void discoverTestRail(connection)}
                  />
                )}
                {connection.source === "confluence" && (
                  <ConfluenceScopeEditor
                    connection={connection}
                    draft={draft}
                    discovery={confluenceDiscovery}
                    discovering={discoveringConfluence}
                    disabled={mutationsDisabled}
                    updateDraft={updateDraft}
                    discover={() => void discoverConfluence(connection)}
                  />
                )}
                {connection.source === "github" && <GitHubTokenGuide />}
                <button className="button button--primary connection-card__submit" type="submit" disabled={mutationsDisabled || !draft.credential.trim()}>
                  {pending ? <Icon name="refresh" size={17} className="spin" /> : <Icon name="lock" size={17} />}
                  {pending ? "Working…" : configured ? "Reconnect / rotate" : "Connect"}
                </button>
              </form>
              {connection.source === "github" && (
                <GitHubRepositoryManager
                  connection={connection}
                  draft={repositoryDraft}
                  editingRepositoryId={editingRepositoryId}
                  pendingRepositoryId={pendingRepositoryId}
                  errors={repositoryErrors}
                  setDraft={setRepositoryDraft}
                  save={() => void saveRepository()}
                  cancelEdit={resetRepositoryEditor}
                  edit={editRepository}
                  test={(repository) => void runRepositoryAction(
                    repository.id,
                    () => getTklApiClient().testGitHubRepository(repository.id),
                  )}
                  cancelSync={(repository) => void cancelRepositorySync(repository)}
                  toggle={(repository) => void runRepositoryAction(
                    repository.id,
                    () => getTklApiClient().updateGitHubRepository(repository.id, {
                      enabled: !repository.enabled,
                    }),
                  )}
                  remove={(repository) => void runRepositoryAction(
                    repository.id,
                    () => getTklApiClient().deleteGitHubRepository(repository.id),
                  )}
                />
              )}
              {configured && (
                <div className="connection-card__actions">
                  <button className="button" type="button" disabled={mutationsDisabled} onClick={() => void runAction(
                    connection.source,
                    () => getTklApiClient().testSourceConnection(connection.source),
                  )}>
                    <Icon name="check" size={17} />
                    Test connection
                  </button>
                  {activeSync && (
                    <button className="button" type="button" disabled={pending} onClick={() => void cancelConnection(connection)}>
                      <Icon name="x" size={17} />
                      {pending ? "Cancelling…" : "Cancel legacy sync"}
                    </button>
                  )}
                  <button className="button button--danger" type="button" disabled={mutationsDisabled} onClick={() => void runAction(
                    connection.source,
                    () => getTklApiClient().disconnectSourceConnection(connection.source),
                  )}>
                    <Icon name="x" size={17} />
                    Disconnect
                  </button>
                </div>
              )}
              {(connection.ownerSubject || connection.lastSuccessfulSyncAt) && (
                <div className="connection-card__meta">
                  {connection.ownerSubject && <span>Owner <strong>{connection.ownerSubject}</strong></span>}
                  {connection.lastSuccessfulSyncAt && (
                    <span>Last successful sync: <strong>{new Date(connection.lastSuccessfulSyncAt).toLocaleString()}</strong></span>
                  )}
                </div>
              )}
              {(actionErrors[connection.source] ?? configurationIssue ?? connection.error?.message) && (
                <p role="alert" className="connection-card__error" aria-live="assertive">
                  <Icon name="warning" size={17} />
                  {actionErrors[connection.source] ?? configurationIssue ?? connection.error?.message}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function GitHubRepositoryManager({
  connection,
  draft,
  editingRepositoryId,
  pendingRepositoryId,
  errors,
  setDraft,
  save,
  cancelEdit,
  edit,
  test,
  cancelSync,
  toggle,
  remove,
}: {
  connection: SourceConnection;
  draft: GitHubRepositoryDraft;
  editingRepositoryId: string | null;
  pendingRepositoryId: string | null;
  errors: Record<string, string | undefined>;
  setDraft: (draft: GitHubRepositoryDraft) => void;
  save: () => void;
  cancelEdit: () => void;
  edit: (repository: GitHubRepository) => void;
  test: (repository: GitHubRepository) => void;
  cancelSync: (repository: GitHubRepository) => void;
  toggle: (repository: GitHubRepository) => void;
  remove: (repository: GitHubRepository) => void;
}) {
  const repositories = connection.repositories ?? [];
  const formPending = pendingRepositoryId === (editingRepositoryId ?? "form");

  return (
    <section className="github-repositories" aria-labelledby="github-repositories-heading">
      <div className="github-repositories__heading">
        <div>
          <h4 id="github-repositories-heading">Repositories</h4>
          <p>
            Each repository defines the approved scope used for bounded, on-demand lookups.
            The shared credential above is never displayed again.
          </p>
          {connection.configured && (
            <span className="github-repositories__credential">
              Shared GitHub PAT configured · secret hidden
            </span>
          )}
        </div>
        <span className="badge badge--muted">
          {repositories.length} {repositories.length === 1 ? "repository" : "repositories"}
        </span>
      </div>

      <form
        className="github-repository-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <h5>{editingRepositoryId ? "Edit repository" : "Add repository"}</h5>
        <label className="github-repository-form__url">
          <span>Repository URL<span className="required-mark" aria-hidden="true"> *</span></span>
          <input
            type="url"
            aria-label="Repository URL"
            placeholder="https://github.com/Solera-Engineering/repository"
            value={draft.url}
            disabled={formPending}
            required
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            onBlur={(event) => {
              const normalized = normalizeGithubRepositoryUrl(event.target.value);
              if (normalized !== event.target.value) setDraft({ ...draft, url: normalized });
            }}
          />
          <small>Paste the complete repository link. TKL derives the API configuration automatically.</small>
        </label>
        <label>
          <span>Purpose</span>
          <select
            aria-label="Repository purpose"
            value={draft.purpose}
            disabled={formPending}
            onChange={(event) => setDraft({
              ...draft,
              purpose: event.target.value as GitHubRepositoryPurpose,
            })}
          >
            {Object.entries(REPOSITORY_PURPOSE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Lifecycle</span>
          <select
            aria-label="Repository lifecycle"
            value={draft.lifecycle}
            disabled={formPending}
            onChange={(event) => {
              const lifecycle = event.target.value as GitHubRepositoryLifecycle;
              setDraft({
                ...draft,
                lifecycle,
                enabled: lifecycle === "archived" ? false : draft.enabled,
              });
            }}
          >
            {Object.entries(REPOSITORY_LIFECYCLE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="github-repository-form__enabled">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={formPending || draft.lifecycle === "archived"}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          <span>Enable repository</span>
        </label>
        <div className="github-repository-form__actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={formPending || !connection.configured || !draft.url.trim()}
          >
            {formPending && <Icon name="refresh" size={16} className="spin" />}
            {formPending ? "Saving…" : editingRepositoryId ? "Save changes" : "Add repository"}
          </button>
          {editingRepositoryId && (
            <button className="button" type="button" disabled={formPending} onClick={cancelEdit}>
              Cancel edit
            </button>
          )}
        </div>
        {!connection.configured && (
          <p className="github-repository-form__note">
            Connect the shared GitHub credential before adding repositories.
          </p>
        )}
        {errors.form && <p className="connection-card__error" role="alert">{errors.form}</p>}
      </form>

      {repositories.length === 0 ? (
        <div className="github-repositories__empty">
          No repositories are configured. Add the first repository after connecting GitHub.
        </div>
      ) : (
        <div className="github-repository-list">
          {repositories.map((repository) => {
            const pending = pendingRepositoryId === repository.id;
            const syncing = repository.syncStatus === "syncing";
            const disabled = !repository.enabled || repository.lifecycle === "archived";
            const repositoryError = errors[repository.id] ?? repository.error?.message;
            return (
              <article
                className={`github-repository-card${disabled ? " github-repository-card--disabled" : ""}`}
                key={repository.id}
              >
                <div className="github-repository-card__header">
                  <div>
                    <h5>{repository.repository}</h5>
                    <a href={repository.url} target="_blank" rel="noreferrer">
                      {repository.url}
                    </a>
                  </div>
                  <span className={repository.enabled ? "badge badge--ok" : "badge badge--muted"}>
                    {repository.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <dl className="github-repository-card__details">
                  <div>
                    <dt>Purpose</dt>
                    <dd>{REPOSITORY_PURPOSE_LABEL[repository.purpose]}</dd>
                  </div>
                  <div>
                    <dt>Lifecycle</dt>
                    <dd>{REPOSITORY_LIFECYCLE_LABEL[repository.lifecycle]}</dd>
                  </div>
                  <div>
                    <dt>Validation</dt>
                    <dd>
                      <RepositoryStateBadge state={repository.validationStatus} />
                    </dd>
                  </div>
                  <div>
                    <dt>Collection status</dt>
                    <dd>
                      <RepositoryStateBadge state={syncing ? "syncing" : repository.syncStatus} />
                    </dd>
                  </div>
                  <div>
                    <dt>Last successful sync</dt>
                    <dd>{formatTimestamp(repository.lastSuccessfulSyncAt)}</dd>
                  </div>
                  <div>
                    <dt>Records collected</dt>
                    <dd>{repository.recordsCollected.toLocaleString()}</dd>
                  </div>
                </dl>
                <div className="github-repository-card__actions">
                  <button className="button" type="button" disabled={pending || syncing} onClick={() => edit(repository)}>
                    Edit
                  </button>
                  <button className="button" type="button" disabled={pending || syncing || disabled} onClick={() => test(repository)}>
                    Test
                  </button>
                  {syncing && (
                    <button className="button" type="button" disabled={pending} onClick={() => cancelSync(repository)}>
                      Cancel legacy sync
                    </button>
                  )}
                  <button className="button" type="button" disabled={pending || syncing || repository.lifecycle === "archived"} onClick={() => toggle(repository)}>
                    {repository.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="button button--danger" type="button" disabled={pending || syncing} onClick={() => remove(repository)}>
                    Remove
                  </button>
                </div>
                {repositoryError && (
                  <p className="connection-card__error" role="alert">
                    <Icon name="warning" size={17} />
                    {sanitizeRepositoryError(repositoryError)}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RepositoryStateBadge({ state }: { state: string }) {
  const className = state === "valid" || state === "succeeded"
    ? "badge badge--ok"
    : state === "failed"
      ? "badge badge--error"
      : state === "validating" || state === "syncing"
        ? "badge badge--pending"
        : state === "cancelled"
          ? "badge badge--warn"
          : "badge badge--muted";
  return (
    <span className={className}>
      {(state === "validating" || state === "syncing") && (
        <Icon name="refresh" size={13} className="spin" />
      )}
      {humanizeStatus(state)}
    </span>
  );
}

function ConfluenceScopeEditor({
  connection,
  draft,
  discovery,
  discovering,
  disabled,
  updateDraft,
  discover,
}: {
  connection: SourceConnection;
  draft: Draft;
  discovery: ConfluencePageDiscovery | null;
  discovering: boolean;
  disabled: boolean;
  updateDraft: (source: SourceConnectionId, field: string, value: string) => void;
  discover: () => void;
}) {
  const scope = confluenceContentScope(connection, draft);
  const setScope = (value: "tree" | "page" | "space") => {
    updateDraft("confluence", "contentScope", value);
  };

  return (
    <fieldset className="testrail-scope">
      <legend>Content scope</legend>
      <p>
        Choose how much content below each root page becomes part of the knowledge library.
      </p>
      <label className="testrail-scope__option">
        <input
          type="radio"
          name="confluence-content-scope"
          value="tree"
          checked={scope === "tree"}
          disabled={disabled}
          onChange={() => setScope("tree")}
        />
        <span>
          <strong>Page and all descendants (recommended)</strong>
          <small>Includes each root page and every page below it in the page tree.</small>
        </span>
      </label>
      <label className="testrail-scope__option">
        <input
          type="radio"
          name="confluence-content-scope"
          value="page"
          checked={scope === "page"}
          disabled={disabled}
          onChange={() => setScope("page")}
        />
        <span>
          <strong>Exact pages only</strong>
          <small>Includes only the pasted pages, without their children.</small>
        </span>
      </label>
      <label className="testrail-scope__option">
        <input
          type="radio"
          name="confluence-content-scope"
          value="space"
          checked={scope === "space"}
          disabled={disabled}
          onChange={() => setScope("space")}
        />
        <span>
          <strong>Entire spaces</strong>
          <small>Includes every page in the discovered spaces. Use only for dedicated spaces.</small>
        </span>
      </label>
      <button
        className="button testrail-scope__discover"
        type="button"
        disabled={disabled || discovering}
        onClick={discover}
      >
        <Icon name="refresh" size={17} className={discovering ? "spin" : undefined} />
        {discovering ? "Loading pages…" : discovery ? "Refresh pages" : "Load pages"}
      </button>
      {discovery && (
        <div className="testrail-suite-list" aria-label="Resolved Confluence root pages">
          {discovery.roots.map((root) => (
            <div className="testrail-suite" key={`${root.spaceKey}:${root.id}`}>
              <Icon name="check" size={17} />
              <span>
                <strong>{root.title}</strong>
                <small>Space {root.spaceKey} · Page {root.id}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <small>
        This controls what TKL reads. It does not change or move pages in Confluence.
      </small>
    </fieldset>
  );
}

function TestRailScopeEditor({
  connection,
  draft,
  suites,
  discovering,
  disabled,
  updateDraft,
  discover,
}: {
  connection: SourceConnection;
  draft: Draft;
  suites: TestRailSuite[] | null;
  discovering: boolean;
  disabled: boolean;
  updateDraft: (source: SourceConnectionId, field: string, value: string) => void;
  discover: () => void;
}) {
  const scope = testRailSuiteScope(connection, draft);
  const selectedIds = new Set(testRailSelectedSuiteIds(connection, draft));
  const setScope = (value: "all" | "selected") => {
    updateDraft("testrail", "suiteScope", value);
  };
  const toggleSuite = (suiteId: string) => {
    const next = new Set(selectedIds);
    if (next.has(suiteId)) next.delete(suiteId);
    else next.add(suiteId);
    updateDraft("testrail", "suiteIds", [...next].join(", "));
  };

  return (
    <fieldset className="testrail-scope">
      <legend>Knowledge scope</legend>
      <p>
        Load every suite for the broadest reusable context, or limit ingestion only when
        this TestRail project is shared with another product.
      </p>
      <label className="testrail-scope__option">
        <input
          type="radio"
          name="testrail-suite-scope"
          value="all"
          checked={scope === "all"}
          disabled={disabled}
          onChange={() => setScope("all")}
        />
        <span>
          <strong>All suites (recommended)</strong>
          <small>Includes every current and future suite in the project.</small>
        </span>
      </label>
      <label className="testrail-scope__option">
        <input
          type="radio"
          name="testrail-suite-scope"
          value="selected"
          checked={scope === "selected"}
          disabled={disabled || !suites}
          onChange={() => setScope("selected")}
        />
        <span>
          <strong>Selected suites only</strong>
          <small>Use this only to isolate an approved subset of a shared project.</small>
        </span>
      </label>
      <button
        className="button testrail-scope__discover"
        type="button"
        disabled={disabled || discovering}
        onClick={discover}
      >
        <Icon name="refresh" size={17} className={discovering ? "spin" : undefined} />
        {discovering ? "Loading suites…" : suites ? "Refresh suites" : "Load suites"}
      </button>
      {suites && (
        <div className="testrail-suite-list" aria-label="Discovered TestRail suites">
          {suites.length === 0 ? (
            <span>No suites were found in this TestRail project.</span>
          ) : suites.map((suite) => (
            <label
              className={`testrail-suite${suite.isCompleted ? " testrail-suite--completed" : ""}`}
              key={suite.id}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(suite.id)}
                disabled={disabled || scope !== "selected"}
                onChange={() => toggleSuite(suite.id)}
              />
              <span>
                <strong>{suite.name}</strong>
                <small>Suite {suite.id}{suite.isCompleted ? " · Completed" : ""}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {!suites && scope === "selected" && selectedIds.size > 0 && (
        <small>Currently selected suite IDs: {[...selectedIds].join(", ")}</small>
      )}
      <small>
        This controls what TKL reads for context. A future create or improve workflow
        will choose its destination suite and section separately.
      </small>
    </fieldset>
  );
}

function JiraConnectionGuide() {
  return (
    <details className="credential-guide">
      <summary>
        <Icon name="shield" size={17} />
        How to configure the Jira scope
      </summary>
      <div className="credential-guide__content">
        <p>
          <strong>Project key:</strong> use the letters before an issue number. For example,
          the project key for <code>ABC-123</code> is <code>ABC</code>.
        </p>
        <p>
          <strong>JQL filter:</strong> open Jira&apos;s advanced issue search, build the
          narrowest query for this workspace, run it to verify the results, and paste the
          complete JQL here.
        </p>
        <p>
          <code>project = ABC</code> can validate a connection, but it includes the entire
          project. Add the team&apos;s approved component, label, epic, product field, or
          another approved criterion to keep on-demand searches within the intended workspace.
        </p>
        <p>
          <strong>Credential:</strong> create a Jira personal access token with read access.
          TKL sends it as a Bearer token and stores it encrypted.
        </p>
        <a
          href="https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/"
          target="_blank"
          rel="noreferrer"
        >
          Open the Jira JQL guide
          <Icon name="arrow-right" size={15} />
        </a>
        <span>Review the JQL results in Jira before connecting this source.</span>
      </div>
    </details>
  );
}

function GitHubTokenGuide() {
  return (
    <details className="credential-guide">
      <summary>
        <Icon name="shield" size={17} />
        How to create and authorize the GitHub token
      </summary>
      <div className="credential-guide__content">
        <p>
          <strong>Recommended: fine-grained token.</strong> Choose{" "}
          <strong>Solera-Engineering</strong> as the resource owner, select the repository,
          and grant read access to Metadata, Contents, and Pull requests.
        </p>
        <p>
          If organization approval is required, wait until the token is approved before
          connecting it.
        </p>
        <p>
          <strong>Classic token:</strong> select the <code>repo</code> scope, then use{" "}
          <strong>Configure SSO → Solera-Engineering → Authorize</strong>.
        </p>
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noreferrer"
        >
          Open GitHub token settings
          <Icon name="arrow-right" size={15} />
        </a>
        <span>Never paste a token into documentation, chat messages, or screenshots.</span>
      </div>
    </details>
  );
}

function configValue(connection: SourceConnection, field: string): string {
  const value = connection.config[field];
  const resolved = Array.isArray(value)
    ? value.join(", ")
    : value ?? DEFAULT_CONFIG[connection.source]?.[field] ?? "";
  if (connection.source === "github" && field === "repositories" && resolved) {
    const webBaseUrl = typeof connection.config.webBaseUrl === "string"
      ? connection.config.webBaseUrl
      : "https://github.com";
    return `${webBaseUrl.replace(/\/+$/, "")}/${resolved.replace(/^\/+/, "")}`;
  }
  return connection.source === "jira" && field === "baseUrl"
    ? normalizeKnownJiraBaseUrl(resolved)
    : resolved;
}

function validateDraft(
  connection: SourceConnection,
  draft: Draft,
  confluenceDiscovery: ConfluencePageDiscovery | null,
): void {
  const issue = getConfigurationIssue(connection, draft, confluenceDiscovery);
  if (issue) throw new Error(issue);
}

function getConfigurationIssue(
  connection: SourceConnection,
  draft: Draft,
  confluenceDiscovery: ConfluencePageDiscovery | null = null,
): string | null {
  if (connection.source === "github") {
    return null;
  }
  if (connection.source === "testrail") {
    if (
      testRailSuiteScope(connection, draft) === "selected"
      && testRailSelectedSuiteIds(connection, draft).length === 0
    ) {
      return "Select at least one TestRail suite or use All suites.";
    }
    return null;
  }
  if (connection.source === "confluence") {
    if (confluenceRootPageUrls(connection, draft).length === 0) {
      return "Enter at least one Confluence root page URL.";
    }
    if (!confluenceDiscovery) {
      return "Load the Confluence root pages before connecting.";
    }
    return null;
  }
  if (connection.source !== "jira") return null;

  const baseUrl = (draft.config.baseUrl ?? configValue(connection, "baseUrl")).trim();
  try {
    const parsedUrl = new URL(baseUrl);
    if (
      parsedUrl.hostname.toLowerCase() === "jira.app.solera.com"
      && !parsedUrl.pathname.toLowerCase().startsWith("/jira")
    ) {
      return "Use https://jira.app.solera.com/jira as the Jira base URL.";
    }
  } catch {
    return "Enter a valid Jira base URL, for example https://jira.app.solera.com/jira.";
  }

  const jql = (draft.config.allowedJql ?? configValue(connection, "allowedJql")).trim();
  const projects = (draft.config.allowedProjects ?? configValue(connection, "allowedProjects"))
    .split(",")
    .map((project) => project.trim().toUpperCase())
    .filter(Boolean);
  if (projects.includes(jql.toUpperCase())) {
    return `"${jql}" is a project key, not a JQL filter. Use a complete query such as "project = ${jql}".`;
  }
  return null;
}

function testRailSuiteScope(
  connection: SourceConnection,
  draft: Draft,
): "all" | "selected" {
  const configuredScope = draft.config.suiteScope ?? connection.config.suiteScope;
  if (configuredScope === "selected") return "selected";
  if (configuredScope === "all") return "all";
  return connection.config.suiteIds ? "selected" : "all";
}

function testRailSelectedSuiteIds(
  connection: SourceConnection,
  draft: Draft,
): string[] {
  const value = draft.config.suiteIds ?? configValue(connection, "suiteIds");
  return value
    .split(",")
    .map((suiteId) => suiteId.trim())
    .filter(Boolean);
}

function confluenceContentScope(
  connection: SourceConnection,
  draft: Draft,
): "tree" | "page" | "space" {
  const scope = draft.config.contentScope ?? connection.config.contentScope;
  if (scope === "page" || scope === "space") return scope;
  return "tree";
}

function confluenceRootPageUrls(
  connection: SourceConnection,
  draft: Draft,
): string[] {
  const value = draft.config.rootPageUrls ?? configValue(connection, "rootPageUrls");
  return value
    .split(",")
    .map((pageUrl) => pageUrl.trim())
    .filter(Boolean);
}

function confluenceAuthMode(rootPageUrls: string[]): "basic" | "bearer" {
  try {
    return new URL(rootPageUrls[0] ?? "").hostname.toLowerCase().endsWith(".atlassian.net")
      ? "basic"
      : "bearer";
  } catch {
    return "bearer";
  }
}

function normalizeKnownJiraBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.hostname.toLowerCase() === "jira.app.solera.com"
      && (url.pathname === "" || url.pathname === "/")
    ) {
      return "https://jira.app.solera.com/jira";
    }
  } catch {
    return value;
  }
  return value;
}

function normalizeFieldInput(
  source: SourceConnectionId,
  field: string,
  value: string,
): string {
  if (source !== "github" || field !== "repositories") return value;

  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const { webBaseUrl, repository } = parseGithubRepositoryUrl(trimmed);
    return `${webBaseUrl}/${repository}`;
  } catch {
    const repository = trimmed.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `https://github.com/${repository}`;
  }
}

function serializeFieldInput(
  source: SourceConnectionId,
  field: string,
  value: string,
): string {
  if (source !== "github" || field !== "repositories") return value;
  return parseGithubRepositoryUrl(value).repository;
}

function githubServerConfig(repositoryUrl: string): Record<string, string> {
  const { hostname, webBaseUrl } = parseGithubRepositoryUrl(repositoryUrl);
  return hostname === "github.com"
    ? {}
    : { apiUrl: `${webBaseUrl}/api/v3`, webBaseUrl };
}

function githubExistingServerConfig(connection: SourceConnection): Record<string, string> {
  const apiUrl = configValue(connection, "apiUrl");
  const webBaseUrl = configValue(connection, "webBaseUrl");
  return {
    ...(apiUrl ? { apiUrl } : {}),
    ...(webBaseUrl ? { webBaseUrl } : {}),
  };
}

function parseGithubRepositoryUrl(value: string): {
  hostname: string;
  repository: string;
  webBaseUrl: string;
} {
  const trimmed = value.trim();
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://github.com/${trimmed.replace(/^\/+/, "")}`;
  const url = new URL(candidate);
  const segments = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (url.protocol !== "https:" || segments.length !== 2 || url.search || url.hash) {
    throw new Error("Invalid GitHub repository URL");
  }

  return {
    hostname: url.hostname.toLowerCase(),
    repository: `${segments[0]}/${segments[1]}`,
    webBaseUrl: url.origin,
  };
}

function githubRepositoryNames(connection: SourceConnection): string[] {
  if (connection.repositories) {
    return connection.repositories.map((repository) => repository.repository);
  }
  const legacy = connection.config.repositories;
  return Array.isArray(legacy) ? legacy : typeof legacy === "string" ? [legacy] : [];
}

function normalizeGithubRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const { repository, webBaseUrl } = parseGithubRepositoryUrl(trimmed);
    return `${webBaseUrl}/${repository}`;
  } catch {
    return value;
  }
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function humanizeStatus(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeRepositoryError(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:access_?token|token|key|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
}

function parseReportPortalLocation(value: string): {
  baseUrl: string;
  project?: string;
} {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid ReportPortal URL");
  }
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const uiIndex = pathSegments.findIndex((segment) => segment.toLowerCase() === "ui");
  const basePathSegments = uiIndex >= 0 ? pathSegments.slice(0, uiIndex) : [];
  const project = url.hash
    .replace(/^#\/?/, "")
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .find(Boolean);
  return {
    baseUrl: `${url.origin}${basePathSegments.length > 0 ? `/${basePathSegments.join("/")}` : ""}`,
    ...(project ? { project } : {}),
  };
}

function friendlyActionError(source: SourceConnectionId, message: string): string {
  if (source === "github" && /\b404\b/.test(message)) {
    return "GitHub could not access this repository. Verify the repository URL, token repository access, and organization SSO or approval.";
  }
  return message;
}
