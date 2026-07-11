import { describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => ({
  NODE_ENV: 'test',
  NEXT_PUBLIC_POSTHOG_HOST: '',
  NEXT_PUBLIC_POSTHOG_KEY: '',
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));

const { htmlScriptJson } = await import('@/lib/analytics/page-view-beacon');

describe('htmlScriptJson', () => {
  it('keeps inline script literals from containing raw closing script delimiters', () => {
    const value = '</script><img src=x onerror=alert(1)>/capture/';
    const encoded = htmlScriptJson(value);

    expect(encoded).not.toContain('</script>');
    expect(encoded).not.toContain('<');
    expect(encoded).not.toContain('>');
    expect(encoded).not.toContain('/');
    expect(JSON.parse(encoded)).toBe(value);
  });
});
