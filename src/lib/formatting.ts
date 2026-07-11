export function formatUsd(value: number | string, opts?: { sign?: boolean }): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (opts?.sign && n < 0) {
    return `-$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatRelative(input: Date | string, now: number = Date.now()): string {
  const then = typeof input === 'string' ? new Date(input).getTime() : input.getTime();
  if (Number.isNaN(then)) return typeof input === 'string' ? input : '';
  const secs = Math.floor((now - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}
