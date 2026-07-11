import {
  PY_SDK_INSTALL_COMMAND,
  PY_SDK_IMPORT_PACKAGE_NAME,
  TS_SDK_PACKAGE_NAME,
  TS_SDK_INSTALL_COMMAND,
} from '@/lib/sdk-package-names';
import { PYLVA_DOCS_URL } from '@/lib/public-links';

// Real package names come from the local SDK package-name constants.
// Default endpoint per spec: https://api.pylva.com.
export const TS_INSTALL = TS_SDK_INSTALL_COMMAND;
export const PY_INSTALL = PY_SDK_INSTALL_COMMAND;

export const TS_MARKETING_SNIPPET = `// 1. install
${TS_SDK_INSTALL_COMMAND}

// 2. init - auto-patches openai / @anthropic-ai/sdk / ai
import { init, track } from "${TS_SDK_PACKAGE_NAME}";
import OpenAI from "openai";

init({ apiKey: process.env.PYLVA_API_KEY });
const openai = new OpenAI();

// 3. wrap your agent run with customer + step context
await track(user.id, { step: "draft" }, async () => {
  await openai.chat.completions.create({ ... });
});`;

export const PY_MARKETING_SNIPPET = `# 1. install
${PY_SDK_INSTALL_COMMAND}

# 2. init - auto-patches openai / anthropic
import os
import ${PY_SDK_IMPORT_PACKAGE_NAME}
from openai import OpenAI

${PY_SDK_IMPORT_PACKAGE_NAME}.init(api_key=os.environ["PYLVA_API_KEY"])
openai = OpenAI()

# 3. wrap your agent run with customer + step context
from ${PY_SDK_IMPORT_PACKAGE_NAME} import track_context

with track_context(customer_id=user.id, step="draft"):
    openai.chat.completions.create(...)`;

export const TS_QUICKSTART = `import { init, track } from "${TS_SDK_PACKAGE_NAME}";

init({ apiKey: process.env.PYLVA_API_KEY! });
// endpoint defaults to https://api.pylva.com; pass endpoint: "..." for self-host

// Wrap a unit of work; LLM calls inside auto-emit telemetry tagged with this
// customer + step. Never include prompts, completions, emails, or raw user
// messages in customer_id / step / metadata.
await track("cust_123", { step: "draft_email" }, async () => {
  return openai.chat.completions.create({ model: "claude-sonnet-4", messages });
});`;

export const PY_QUICKSTART = `import os
from ${PY_SDK_IMPORT_PACKAGE_NAME} import init, track_context

init(api_key=os.environ["PYLVA_API_KEY"])
# endpoint defaults to https://api.pylva.com; pass endpoint=... for self-host

# Wrap a unit of work; LLM calls inside auto-emit telemetry tagged with this
# customer + step. Never include prompts, completions, emails, or raw user
# messages in customer_id / step / metadata.
with track_context(customer_id="cust_123", step="draft_email"):
    openai.chat.completions.create(model="claude-sonnet-4", messages=messages)`;

export const AGENT_SETUP_GUIDE_URL = `${PYLVA_DOCS_URL}/setup-with-ai.md`;

// One-paste prompt for the human's coding agent (Claude Code, Cursor, ...).
// The key line is included only when the caller passes the just-minted
// plaintext: the string is built client-side at click time, never stored,
// and never sent to analytics.
export function buildAgentSetupPrompt(options: { apiKey?: string } = {}): string {
  const keyLine = options.apiKey
    ? `Store this key as PYLVA_API_KEY in the environment (for example a gitignored .env file):\nPYLVA_API_KEY=${options.apiKey}`
    : 'The API key is available in the PYLVA_API_KEY environment variable.';
  return [
    'Set up Pylva cost tracking in this repository.',
    `Read ${AGENT_SETUP_GUIDE_URL} and follow it: install the Pylva SDK for this project's language, initialize it at startup, and wrap the agent entrypoints so LLM and tool calls are attributed to a customer and step.`,
    'Never print, log, or commit the API key.',
    keyLine,
    'You can verify the key with GET https://api.pylva.com/api/v1/whoami sent with the X-Pylva-Key header.',
  ].join('\n\n');
}

// Non-LLM usage examples. Consumed by the app onboarding flow and, in the
// internal production/docs distribution, the agent/reference surfaces.
export const TS_REPORT_USAGE = `import { reportUsage } from "${TS_SDK_PACKAGE_NAME}";

reportUsage({
  customer_id: "cust_123",
  tool: "vector_search",
  metric: "lookups",
  value: 1,
});`;

export const PY_REPORT_USAGE = `from ${PY_SDK_IMPORT_PACKAGE_NAME} import report_usage

report_usage(
    customer_id="cust_123",
    tool="vector_search",
    metric="lookups",
    value=1,
)`;
