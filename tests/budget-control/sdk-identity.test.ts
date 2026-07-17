import { describe, expect, it } from 'vitest';
import {
  PYLVA_SDK_LANGUAGE_HEADER,
  PYLVA_SDK_VERSION_HEADER,
  UNKNOWN_SDK_IDENTITY,
  normalizeBudgetControlSdkLanguage,
  normalizeBudgetControlSdkVersion,
  readBudgetControlSdkIdentity,
} from '../../src/lib/budget-control/sdk-identity.js';

describe('authoritative budget-control SDK identity', () => {
  describe('SDK version', () => {
    it.each([
      ['short semantic version', '1.2.0'],
      ['one printable character', 'v'],
      ['one printable space', ' '],
      ['all printable ASCII boundaries', ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
      ['exactly 50 printable ASCII characters', 'x'.repeat(50)],
      ['spaces are printable ASCII and are preserved', 'sdk version 1.2.0'],
    ])('preserves %s', (_case, version) => {
      expect(normalizeBudgetControlSdkVersion(version)).toBe(version);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['empty', ''],
      ['51 characters', 'x'.repeat(51)],
      ['tab control', '1.2\t0'],
      ['newline control', '1.2\n0'],
      ['NUL control', '1.2\0'],
      ['unit separator control', `1.2${String.fromCharCode(0x1f)}0`],
      ['DEL control', `1.2${String.fromCharCode(0x7f)}0`],
      ['non-ASCII Latin character', 'versión'],
      ['non-ASCII emoji', '1.2.0-🚀'],
    ])('normalizes %s to unknown', (_case, version) => {
      expect(normalizeBudgetControlSdkVersion(version)).toBe(UNKNOWN_SDK_IDENTITY);
    });
  });

  describe('SDK language', () => {
    it.each(['python', 'typescript'] as const)('preserves %s', (language) => {
      expect(normalizeBudgetControlSdkLanguage(language)).toBe(language);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['empty', ''],
      ['uppercase', 'Python'],
      ['surrounding whitespace', ' typescript '],
      ['unsupported language', 'javascript'],
      ['comma-joined duplicate values', 'python, typescript'],
    ])('normalizes %s to unknown', (_case, language) => {
      expect(normalizeBudgetControlSdkLanguage(language)).toBe(UNKNOWN_SDK_IDENTITY);
    });
  });

  it('reads the two case-insensitive request headers', () => {
    const headers = new Headers({
      'X-Pylva-SDK-Version': '1.2.0-beta.1',
      'X-Pylva-SDK-Language': 'typescript',
    });

    expect(readBudgetControlSdkIdentity(headers)).toEqual({
      sdkVersion: '1.2.0-beta.1',
      sdkLanguage: 'typescript',
    });
    expect(headers.has(PYLVA_SDK_VERSION_HEADER)).toBe(true);
    expect(headers.has(PYLVA_SDK_LANGUAGE_HEADER)).toBe(true);
  });

  it('normalizes absent or independently invalid request headers without throwing', () => {
    const headers = new Headers({
      'X-Pylva-SDK-Version': 'é'.repeat(10),
      'X-Pylva-SDK-Language': 'PYTHON',
    });

    expect(readBudgetControlSdkIdentity(headers)).toEqual({
      sdkVersion: UNKNOWN_SDK_IDENTITY,
      sdkLanguage: UNKNOWN_SDK_IDENTITY,
    });
    expect(readBudgetControlSdkIdentity(new Headers())).toEqual({
      sdkVersion: UNKNOWN_SDK_IDENTITY,
      sdkLanguage: UNKNOWN_SDK_IDENTITY,
    });
  });
});
