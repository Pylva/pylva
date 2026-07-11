import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { modelSchema, providerSchema } from '@pylva/shared';

describe('telemetry provider/model identifiers', () => {
  const accepted = [
    'ollama',
    'openai.chat',
    'zhipu',
    'together_ai',
    'ft:gpt-4o-mini:org/name+v1@prod',
    'ollama/llama3.1-8b',
    'glm 4.5',
    '模型-プロバイダー',
  ];

  it('accepts store-safe arbitrary provider strings', () => {
    for (const value of accepted) {
      expect(v.safeParse(providerSchema, value).success, value).toBe(true);
    }
  });

  it('accepts store-safe arbitrary model strings', () => {
    for (const value of accepted) {
      expect(v.safeParse(modelSchema, value).success, value).toBe(true);
    }
  });

  it('rejects blank, control-character, and over-length values', () => {
    const rejected = ['', '   ', 'openai\nchat', 'x'.repeat(256)];

    for (const value of rejected) {
      expect(v.safeParse(providerSchema, value).success, JSON.stringify(value)).toBe(false);
      expect(v.safeParse(modelSchema, value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
