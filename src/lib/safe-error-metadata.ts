export interface SafeErrorMetadata {
  error_name: string;
  error_code?: string;
  error_status?: number;
  cause_name?: string;
  cause_code?: string;
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function errorName(value: unknown): string {
  if (value instanceof Error) return value.name;
  const name = objectValue(value, 'name');
  return typeof name === 'string' ? name : typeof value;
}

export function safeErrorMetadata(error: unknown): SafeErrorMetadata {
  const metadata: SafeErrorMetadata = { error_name: errorName(error) };
  const code = objectValue(error, 'code');
  if (typeof code === 'string') metadata.error_code = code;
  const status = objectValue(error, 'status');
  if (typeof status === 'number' && Number.isFinite(status)) metadata.error_status = status;

  const cause = objectValue(error, 'cause');
  if (cause !== undefined) {
    metadata.cause_name = errorName(cause);
    const causeCode = objectValue(cause, 'code');
    if (typeof causeCode === 'string') metadata.cause_code = causeCode;
  }
  return metadata;
}
