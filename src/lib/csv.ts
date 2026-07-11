const DANGEROUS_PREFIXES = ['=', '+', '-', '@', '\t', '\r', '\n'];

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvEscapeSafe(value: string): string {
  let safe = value;
  if (DANGEROUS_PREFIXES.some((p) => safe.startsWith(p))) {
    safe = `'${safe}`;
  }
  return csvEscape(safe);
}
