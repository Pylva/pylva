import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

async function read(rel: string) {
  return readFile(path.join(ROOT, rel), 'utf8');
}

type Oklch = [number, number, number];

function findRule(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `missing CSS rule: ${selector}`).not.toBeNull();
  return match![1]!;
}

function findOklch(rule: string, token: string): Oklch {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rule.match(
    new RegExp(`${escaped}:\\s*oklch\\(([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\)`),
  );
  expect(match, `missing OKLCH token: ${token}`).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function oklchToLinearSrgb([lightness, chroma, hueDegrees]: Oklch): Oklch {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function encodedChannel(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function relativeLuminance(color: Oklch) {
  const [linearRed, linearGreen, linearBlue] = oklchToLinearSrgb(color);
  const red = encodedChannel(linearRed);
  const green = encodedChannel(linearGreen);
  const blue = encodedChannel(linearBlue);
  const decode = (value: number) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * decode(red) + 0.7152 * decode(green) + 0.0722 * decode(blue);
}

function contrastRatio(foreground: Oklch, background: Oklch) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('frontend design system alignment', () => {
  it('scopes tokens per surface instead of mutating dashboard globals', async () => {
    const css = await read('src/app/globals.css');
    expect(css).toContain('[data-marketing]');
    expect(css).toContain('[data-app]');
    expect(css).toContain('[data-portal]');
    expect(css).toContain('--mkt-accent');
    expect(css).toContain('--app-brand');
    expect(css).toContain('--portal-panel');
  });

  it('keeps dashboard semantic state colors AA-compliant on panel backgrounds', async () => {
    const css = await read('src/app/globals.css');
    const lightRule = findRule(css, '[data-app]');
    const darkRule = findRule(css, '.dark [data-app]');

    const lightPanel = findOklch(lightRule, '--app-panel');
    const darkPanel = findOklch(darkRule, '--app-panel');

    for (const token of ['--app-success', '--app-warn', '--app-danger']) {
      expect(contrastRatio(findOklch(lightRule, token), lightPanel)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(findOklch(darkRule, token), darkPanel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dashboard routes use the shared app shell and page header primitive', async () => {
    const layout = await read('src/app/o/[slug]/layout.tsx');
    const overview = await read('src/app/o/[slug]/dashboard/page.tsx');
    const rules = await read('src/app/o/[slug]/dashboard/rules/page.tsx');
    expect(layout).toContain('data-app');
    expect(overview).toContain('PageHeader');
    expect(rules).toContain('PageHeader');
    expect(rules).toContain('app-card');
  });

  it('portal owns a dedicated white-label surface', async () => {
    const portal = await read('src/app/portal/page.tsx');
    expect(portal).toContain('data-portal');
    expect(portal).toContain('primaryColor');
    expect(portal).toContain('Powered by Pylva');
  });
});
