// SDK identity carried by authoritative budget-control requests.
//
// These values are observability metadata only: authentication and tenant
// authority always come from the verified Pylva API key. Invalid metadata is
// deliberately normalized to `unknown` instead of rejecting or weakening an
// otherwise valid control request.

export const PYLVA_SDK_VERSION_HEADER = 'x-pylva-sdk-version';
export const PYLVA_SDK_LANGUAGE_HEADER = 'x-pylva-sdk-language';
export const UNKNOWN_SDK_IDENTITY = 'unknown';

export type BudgetControlSdkLanguage = 'python' | 'typescript' | typeof UNKNOWN_SDK_IDENTITY;

export interface BudgetControlSdkIdentity {
  sdkVersion: string;
  sdkLanguage: BudgetControlSdkLanguage;
}

type HeaderReader = Pick<Headers, 'get'>;

// PostgreSQL's authoritative usage ledger enforces the same byte range and
// length (`^[ -~]{1,50}$`). Because every accepted character is one-byte
// ASCII, character count and encoded byte count are identical here.
const PRINTABLE_ASCII_SDK_VERSION = /^[\x20-\x7E]{1,50}$/;

export function normalizeBudgetControlSdkVersion(value: string | null | undefined): string {
  return typeof value === 'string' && PRINTABLE_ASCII_SDK_VERSION.test(value)
    ? value
    : UNKNOWN_SDK_IDENTITY;
}

export function normalizeBudgetControlSdkLanguage(
  value: string | null | undefined,
): BudgetControlSdkLanguage {
  return value === 'python' || value === 'typescript' ? value : UNKNOWN_SDK_IDENTITY;
}

export function readBudgetControlSdkIdentity(headers: HeaderReader): BudgetControlSdkIdentity {
  return {
    sdkVersion: normalizeBudgetControlSdkVersion(headers.get(PYLVA_SDK_VERSION_HEADER)),
    sdkLanguage: normalizeBudgetControlSdkLanguage(headers.get(PYLVA_SDK_LANGUAGE_HEADER)),
  };
}
