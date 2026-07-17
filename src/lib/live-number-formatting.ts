/**
 * Format live dashboard counters that have already crossed the JSON number
 * boundary. Authoritative decimal strings must keep using formatTelemetryUsd.
 */
export function formatLiveTelemetryUsd(value: number): string {
  if (!Number.isFinite(value)) return '$—';
  if (value === 0) return '$0.00';

  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute < 1e-18) {
    return `${sign}$${absolute.toExponential(2)}`;
  }

  return `${sign}$${absolute.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: absolute < 0.01 ? 18 : 2,
  })}`;
}

export function formatLiveInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
