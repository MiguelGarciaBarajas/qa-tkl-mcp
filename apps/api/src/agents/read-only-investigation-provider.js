export const readOnlyInvestigationProviderManifest = Object.freeze({
  id: "provider.read-only-investigation",
  version: "0.1.0",
  mode: "read-only",
  capabilities: ["repository-evidence", "live-ui-evidence"],
});

export function createUnavailableInvestigationProvider() {
  return {
    manifest: readOnlyInvestigationProviderManifest,
    async investigate() {
      return {
        status: "not-enabled",
        summary: "No governed code or live-UI investigation provider is enabled.",
        evidence: { citations: [], items: [] },
        limitations: ["Live or repository investigation is unavailable in this deployment."],
      };
    },
  };
}

export function mergeInvestigationResult(result, investigation) {
  return {
    ...result,
    summary: [result.summary, investigation.summary].filter(Boolean).join(" "),
    evidence: {
      ...(result.evidence ?? {}),
      ...(investigation.evidence ?? {}),
      citations: [
        ...(result.evidence?.citations ?? []),
        ...(investigation.evidence?.citations ?? []),
      ],
      items: [
        ...(result.evidence?.items ?? []),
        ...(investigation.evidence?.items ?? []),
      ],
    },
    limitations: [
      ...(result.limitations ?? []),
      ...(investigation.limitations ?? []),
    ],
  };
}
