export function normalizeNonLlmMatcher(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.:/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export function displayNameForTool(value: string): string {
  const trimmed = value.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : 'Unknown tool';
}
