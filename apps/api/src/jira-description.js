export function parseStructuredJiraDescription(value) {
  const text = String(value).replace(/\r\n?/g, "\n").trim();
  const headingPattern =
    /(?:^|\n)\s*(?:\*{1,2}|_{1,2})?(Issue|Acceptance Criteria|Repro Steps)(?:\*{1,2}|_{1,2})?\s*:?\s*/gi;
  const matches = [...text.matchAll(headingPattern)];
  if (matches.length === 0) return null;

  const sections = {};
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    sections[match[1].toLowerCase()] = text.slice(start, end).trim();
  }
  const steps = (sections["repro steps"] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(/^\d+\s*[-.)]\s*(.+)$/)?.[1]?.trim())
    .filter(Boolean);
  return {
    issue: sections.issue ?? "",
    acceptanceCriteria: sections["acceptance criteria"] ?? "",
    reproSteps: steps,
  };
}
