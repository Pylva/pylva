// B2a T3 — rule-creation form, type driven by the URL segment.
// Built-in templates delegate to RuleFormClient; custom delegates to a
// request form that POSTs to /api/v1/rules/custom-request.

import { CustomRuleRequestClient } from '@/components/rules/CustomRuleRequestClient';
import { RuleFormClient } from '@/components/rules/RuleFormClient';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation.js';

export const metadata: Metadata = { title: 'New rule' };

const VALID = new Set(['cost_threshold', 'budget_limit', 'margin_protection', 'custom']);

export default async function NewRuleForm({
  params,
}: {
  params: Promise<{ slug: string; type: string }>;
}) {
  const { slug, type } = await params;
  if (!VALID.has(type)) notFound();
  if (type === 'custom') return <CustomRuleRequestClient slug={slug} />;
  return <RuleFormClient type={type as 'cost_threshold' | 'budget_limit' | 'margin_protection'} />;
}
