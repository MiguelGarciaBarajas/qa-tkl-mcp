export function hashSearchParam(name: string): string {
  if (typeof window === "undefined") return "";
  const query = window.location.hash.split("?", 2)[1] ?? "";
  return new URLSearchParams(query).get(name)?.trim() ?? "";
}
