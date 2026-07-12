import { afterEach, describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => ({
  NODE_ENV: 'test',
  NEXT_PUBLIC_POSTHOG_HOST: '',
  NEXT_PUBLIC_POSTHOG_KEY: '',
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));

const { PageViewBeacon, htmlScriptJson } = await import('@/lib/analytics/page-view-beacon');

function renderedBeaconScript(surface: 'marketing' | 'docs' | 'auth' | 'app'): string | null {
  const element = PageViewBeacon({ surface });
  if (!element) return null;
  const props = element.props as {
    dangerouslySetInnerHTML: { __html: string };
  };
  return props.dangerouslySetInnerHTML.__html;
}

afterEach(() => {
  testEnv.NODE_ENV = 'test';
  testEnv.NEXT_PUBLIC_POSTHOG_HOST = '';
  testEnv.NEXT_PUBLIC_POSTHOG_KEY = '';
});

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

describe('PageViewBeacon configuration guard', () => {
  it('stays disabled when the PostHog key is missing', () => {
    testEnv.NODE_ENV = 'production';
    testEnv.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';

    expect(renderedBeaconScript('marketing')).toBeNull();
  });

  it('stays disabled during tests even when fully configured', () => {
    testEnv.NODE_ENV = 'test';
    testEnv.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    testEnv.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';

    expect(renderedBeaconScript('app')).toBeNull();
  });

  it.each(['http://us.i.posthog.com', 'https://posthog.example.com', 'not-a-url'])(
    'rejects a non-allowlisted capture host: %s',
    (host) => {
      testEnv.NODE_ENV = 'production';
      testEnv.NEXT_PUBLIC_POSTHOG_HOST = host;
      testEnv.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';

      expect(renderedBeaconScript('docs')).toBeNull();
    },
  );

  it.each(['https://app.posthog.com', 'https://us.i.posthog.com', 'https://eu.i.posthog.com'])(
    'emits the limited page-view beacon for allowlisted host %s',
    (host) => {
      testEnv.NODE_ENV = 'production';
      testEnv.NEXT_PUBLIC_POSTHOG_HOST = host;
      testEnv.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';

      const script = renderedBeaconScript('auth');
      expect(script).toContain(`endpoint=${htmlScriptJson(`${host}/capture/`)}`);
      expect(script).toContain('event:"page_viewed"');
      expect(script).toContain('surface');
      expect(script).not.toContain('autocapture');
      expect(script).not.toContain('session_recording');
    },
  );

  it('escapes an adversarial key before embedding it in the inline script', () => {
    testEnv.NODE_ENV = 'production';
    testEnv.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    testEnv.NEXT_PUBLIC_POSTHOG_KEY = '</script><img src=x onerror=alert(1)>';

    const script = renderedBeaconScript('marketing');
    expect(script).not.toContain('</script>');
    expect(script).not.toContain('<img');
    expect(script).toContain('\\u003c\\u002fscript\\u003e');
  });
});
