function ownStringCode(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Object.prototype.hasOwnProperty.call(value, 'code')
  ) {
    return null;
  }

  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function pgErrorCode(error: unknown): string | null {
  const directCode = ownStringCode(error);
  if (directCode !== null) {
    return directCode;
  }

  if (
    typeof error !== 'object' ||
    error === null ||
    !Object.prototype.hasOwnProperty.call(error, 'cause')
  ) {
    return null;
  }

  return ownStringCode((error as { cause?: unknown }).cause);
}

export function hasPgErrorCode(error: unknown, code: string): boolean {
  return pgErrorCode(error) === code;
}
