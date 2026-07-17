import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_ORG_SLUG, DASHBOARD_STORAGE_STATE } from './setup/fixtures';
import { AUTHORITATIVE_E2E } from './setup/authoritative-budget-journey-fixtures';

const PATH = `/o/${DASHBOARD_ORG_SLUG}/dashboard/budget-activity`;

test.skip(!process.env.E2E_DASHBOARD, 'dashboard e2e requires E2E_DASHBOARD + a seeded stack');
test.use({ storageState: DASHBOARD_STORAGE_STATE });

test('real authoritative LLM + tool charges and refusal are correlated without duplicate spend', async ({
  page,
  isMobile,
}) => {
  await page.goto(`${PATH}?trace_id=${AUTHORITATIVE_E2E.primaryTraceId}&page_size=10`);

  await expect(page.getByRole('heading', { name: 'Budget activity', level: 1 })).toBeVisible();
  await expect(page.getByText('Refused means the provider request was not sent.')).toBeVisible();
  await expect(
    page.getByText('Only charged actions become spend or invoice events.'),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Budget activity filters' })).toBeVisible();

  const activitySurface = isMobile ? page.locator('ul.md\\:hidden') : page.getByRole('table');
  await expect(page.getByText('Authority: PostgreSQL · 3 actions')).toBeVisible();
  await expect(activitySurface.getByLabel('Budget status: Charged')).toHaveCount(2);
  await expect(activitySurface.getByLabel('Budget status: Refused')).toHaveCount(1);
  await expect(activitySurface.getByText('openai / gpt-4o-mini')).toHaveCount(2);
  await expect(activitySurface.getByText('tavily-search / tavily_search')).toBeVisible();
  await expect(activitySurface.getByText(AUTHORITATIVE_E2E.steps.refused)).toBeVisible();
  await expect(activitySurface.getByText('⊘ Not sent')).toHaveCount(1);
  await expect(activitySurface.getByText('✓ Sent')).toHaveCount(2);
  await expect(activitySurface.getByText('$0.000004').first()).toBeVisible();

  if (isMobile) {
    const refusedCard = activitySurface
      .locator(':scope > li')
      .filter({ has: page.getByLabel('Budget status: Refused') });
    const refusalProof = refusedCard.getByLabel('Budget proof for openai / gpt-4o-mini');
    const proofValue = (label: string) =>
      refusalProof.getByText(label, { exact: true }).locator('..').locator('dd');

    await expect(refusedCard).toHaveCount(1);
    await expect(refusedCard.getByLabel('Budget status: Refused')).toContainText('Refused');
    await expect(proofValue('Requested')).toBeVisible();
    await expect(proofValue('Actual')).toHaveText('$0.00');
    await expect(proofValue('Committed before')).toHaveText(
      `$${AUTHORITATIVE_E2E.expected.committedUsd}`,
    );
    await expect(proofValue('Reserved before')).toHaveText('$0.00');
    await expect(proofValue('Unresolved before')).toHaveText('$0.00');
    await expect(proofValue('Remaining')).toBeVisible();
    await expect(proofValue('Provider')).toHaveText('⊘ Not sent');
  }

  const status = page.locator('select[name="status"]');
  await status.focus();
  await expect(status).toBeFocused();
  await status.selectOption('refused');
  await page.getByLabel('End-user ID').fill(AUTHORITATIVE_E2E.customerId);
  const apply = page.getByRole('button', { name: 'Apply filters' });
  await apply.focus();
  await expect(apply).toBeFocused();
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes('/api/v1/budget-activity?') &&
      candidate.request().method() === 'GET',
  );
  await page.keyboard.press('Enter');
  await expect((await response).status()).toBe(200);

  await expect(page.getByText('Authority: PostgreSQL · 1 actions')).toBeVisible();
  await expect(activitySurface.getByLabel('Budget status: Refused')).toHaveCount(1);
  await expect(activitySurface.getByText('⊘ Not sent')).toHaveCount(1);
  await expect(activitySurface.getByText(AUTHORITATIVE_E2E.steps.refused)).toBeVisible();
  expect(page.url()).toContain('status=refused');
  expect(page.url()).toContain(`customer=${AUTHORITATIVE_E2E.customerId}`);
  expect(page.url()).toContain(`trace_id=${AUTHORITATIVE_E2E.primaryTraceId}`);

  if (isMobile) {
    await expect(page.locator('ul.md\\:hidden')).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
  } else {
    await expect(page.getByRole('table')).toBeVisible();
  }

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join('; ')}`,
    ),
  ).toEqual([]);
});

test('real trace, blocked-only trace, end-user, and rule pages preserve authoritative proof', async ({
  page,
}) => {
  await page.goto(`/o/${DASHBOARD_ORG_SLUG}/dashboard/traces/${AUTHORITATIVE_E2E.primaryTraceId}`);
  await expect(page.getByRole('heading', { name: 'Trace', level: 1 })).toBeVisible();
  await expect(page.getByText(AUTHORITATIVE_E2E.primaryTraceId)).toBeVisible();
  await expect(page.getByText(AUTHORITATIVE_E2E.steps.llm)).toBeVisible();
  await expect(page.getByText(AUTHORITATIVE_E2E.steps.tool)).toBeVisible();
  await expect(page.getByLabel('Budget status: Refused')).toBeVisible();
  await expect(page.getByText('⊘ provider not sent')).toBeVisible();

  await page.goto(
    `/o/${DASHBOARD_ORG_SLUG}/dashboard/traces/${AUTHORITATIVE_E2E.blockedOnlyTraceId}`,
  );
  await expect(page.getByText('⊘ No cost span was created.')).toBeVisible();
  await expect(
    page.getByText(
      'This blocked-only trace exists because PostgreSQL recorded the control decision before provider dispatch.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Budget status: Refused')).toBeVisible();
  await expect(page.getByText(AUTHORITATIVE_E2E.steps.blockedOnly)).toBeVisible();

  await page.goto(
    `/o/${DASHBOARD_ORG_SLUG}/dashboard/end-users/${AUTHORITATIVE_E2E.blockedOnlyCustomerId}`,
  );
  await expect(
    page.getByRole('heading', { name: AUTHORITATIVE_E2E.blockedOnlyCustomerId, level: 1 }),
  ).toBeVisible();
  const blockedEventsCard = page.getByText('Events', { exact: true }).locator('..');
  await expect(blockedEventsCard.getByText('0', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'End-user budget control', level: 2 }),
  ).toBeVisible();
  await expect(page.getByLabel('Budget status: Refused')).toBeVisible();
  await expect(page.getByText(AUTHORITATIVE_E2E.steps.blockedOnly)).toBeVisible();

  await page.goto(`/o/${DASHBOARD_ORG_SLUG}/dashboard/end-users/${AUTHORITATIVE_E2E.customerId}`);
  await expect(
    page.getByRole('heading', { name: AUTHORITATIVE_E2E.customerId, level: 1 }),
  ).toBeVisible();
  const eventsCard = page.getByText('Events', { exact: true }).locator('..');
  await expect(eventsCard.getByText('2', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'End-user budget control', level: 2 }),
  ).toBeVisible();
  await expect(page.getByLabel('Budget status: Refused')).toBeVisible();

  await page.goto(`/o/${DASHBOARD_ORG_SLUG}/dashboard/rules/${AUTHORITATIVE_E2E.ruleId}`);
  await expect(
    page.getByRole('heading', { name: AUTHORITATIVE_E2E.ruleName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rule budget control', level: 2 })).toBeVisible();
  await expect(page.getByLabel('Budget status: Charged')).toHaveCount(2);
  await expect(page.getByLabel('Budget status: Refused')).toHaveCount(2);
});
