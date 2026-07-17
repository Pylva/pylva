export function formatUsd(value: number | string, opts?: { sign?: boolean }): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (opts?.sign && n < 0) {
    return `-$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface DecimalParts {
  negative: boolean;
  integer: string;
  fraction: string;
}

function parseDecimalParts(value: number | string): DecimalParts | null {
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const raw = typeof value === 'number' ? value.toString() : value;
  // Authority currently tops out at NUMERIC(44,18). This wider bound keeps
  // the general formatter useful without allowing a hostile string to force
  // an unbounded exponent expansion in the browser.
  if (raw.length === 0 || raw.length > 512) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return null;

  const whole = match[2] ?? '';
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 512) return null;

  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  let integerPart: string;
  let fractionPart: string;
  if (decimalPosition <= 0) {
    integerPart = '0';
    fractionPart = `${'0'.repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    integerPart = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
    fractionPart = '';
  } else {
    integerPart = digits.slice(0, decimalPosition);
    fractionPart = digits.slice(decimalPosition);
  }

  integerPart = integerPart.replace(/^0+(?=\d)/, '') || '0';
  fractionPart = fractionPart.replace(/0+$/, '');
  const isZero = integerPart === '0' && fractionPart.length === 0;
  return {
    negative: match[1] === '-' && !isZero,
    integer: integerPart,
    fraction: fractionPart,
  };
}

function groupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fixedTwo(parts: DecimalParts): string {
  const cents = `${parts.fraction}000`.slice(0, 2);
  let scaled = BigInt(parts.integer) * 100n + BigInt(cents);
  if ((parts.fraction[2] ?? '0') >= '5') scaled += 1n;
  const integer = (scaled / 100n).toString();
  const fraction = (scaled % 100n).toString().padStart(2, '0');
  return `${groupedInteger(integer)}.${fraction}`;
}

function exactScientific(fraction: string, firstNonzero: number): string {
  const significant = fraction.slice(firstNonzero).replace(/0+$/, '');
  const rest = significant.slice(1);
  const decimal = rest.length === 0 ? '00' : rest.length === 1 ? `${rest}0` : rest;
  return `${significant[0]}.${decimal}e-${firstNonzero + 1}`;
}

/**
 * Telemetry costs can be much smaller than one cent. Preserve the familiar
 * two-decimal display for ordinary values, then add only the precision needed
 * to keep a real sub-cent charge visible. Billing and invoice screens must
 * continue to use formatUsd so their currency presentation stays two-decimal.
 */
export function formatTelemetryUsd(value: number | string): string {
  const parts = parseDecimalParts(value);
  if (!parts) return '$—';
  if (parts.integer === '0' && parts.fraction.length === 0) return '$0.00';

  const sign = parts.negative ? '-' : '';
  const firstNonzero = parts.fraction.search(/[1-9]/);
  const isSubCent = parts.integer === '0' && firstNonzero >= 2;
  if (!isSubCent) return `${sign}$${fixedTwo(parts)}`;

  // NUMERIC(38,18) / NUMERIC(44,18) authority can represent 1e-18 exactly.
  // Keep every authoritative decimal digit instead of converting through a
  // binary float. Scientific notation is reserved for smaller nonzero input;
  // returning "$0.00" for a real telemetry value is never allowed.
  if (firstNonzero >= 18) {
    return `${sign}$${exactScientific(parts.fraction, firstNonzero)}`;
  }
  return `${sign}$0.${parts.fraction}`;
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
