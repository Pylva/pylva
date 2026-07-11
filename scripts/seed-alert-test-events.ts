// B2a T4a — dev helper: fire a synthetic batch at /api/v1/events to
// exercise the alert fan-out end-to-end locally. Call with a real
// Agent SDK key and customer_id that a rule targets.
//
// Usage: PYLVA_API_KEY=pv_live_... pnpm exec tsx scripts/seed-alert-test-events.ts <customer_external_id>

import crypto from 'node:crypto';

async function main() {
  const endpoint = process.env['PYLVA_BACKEND_URL'] ?? 'http://localhost:3000';
  const key = process.env['PYLVA_API_KEY'];
  if (!key) {
    console.error('PYLVA_API_KEY env var required');
    process.exit(1);
  }
  const customerId = process.argv[2];
  if (!customerId) {
    console.error('Usage: tsx scripts/seed-alert-test-events.ts <customer_external_id>');
    process.exit(1);
  }

  const events = Array.from({ length: 5 }, (_, i) => ({
    schema_version: '1.6',
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    customer_id: customerId,
    status: 'success',
    latency_ms: 200 + i * 50,
    provider: 'openai',
    model: 'gpt-4o',
    tokens_in: 1000 + i * 200,
    tokens_out: 500 + i * 100,
    step_name: 'synth:test',
    operation: 'chat.completions',
    instrumentation_tier: 'sdk_wrapper',
    cost_source: 'auto',
    framework: 'none',
    stream_aborted: false,
    abort_savings_usd: 0,
    sdk_version: '0.0.1-dev',
    metadata: {},
  }));

  const res = await fetch(`${endpoint}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pylva-Key': key },
    body: JSON.stringify({ batch_id: crypto.randomUUID(), sdk_version: '0.0.1-dev', events }),
  });
  console.log(`status ${res.status}`);
  const body = await res.text();
  console.log(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
