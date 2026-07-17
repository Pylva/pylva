import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadTypescriptSdkArtifact } from './typescript-sdk-artifact.mjs';

const networkFetch = globalThis.fetch;
let activeJourney = null;
globalThis.fetch = async (input, request) => {
  const href = input instanceof Request ? input.url : String(input);
  const url = new URL(href);
  const bodyText =
    input instanceof Request
      ? await input.clone().text()
      : request?.body == null
        ? ''
        : String(request.body);
  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/chat/completions') {
    if (activeJourney === null) throw new Error('official provider dispatched without a journey');
    const body = JSON.parse(bodyText);
    if (
      body.model !== 'gpt-langgraph-e2e' ||
      body.max_completion_tokens !== 8 ||
      !Array.isArray(body.messages)
    ) {
      throw new Error('official OpenAI request lost the controlled LangGraph request shape');
    }
    activeJourney.providerCalls += 1;
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_langgraph_e2e',
        object: 'chat.completion',
        created: 1_784_009_600,
        model: body.model,
        service_tier: 'default',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'llm-ok', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 3,
          total_tokens: 5,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_langgraph_e2e',
        },
      },
    );
  }
  if (url.origin === 'https://api.openai.com') {
    throw new Error(`unexpected official OpenAI request: ${url.pathname}`);
  }
  const response = await networkFetch(input, request);
  if (
    activeJourney !== null &&
    url.pathname === '/api/v1/budget/reservations' &&
    bodyText.length > 0
  ) {
    const reservation = JSON.parse(bodyText);
    const decision = await response.clone().json();
    if (
      reservation.kind === 'llm' &&
      decision.decision === 'reserved' &&
      activeJourney.allowedLlm === null
    ) {
      if (
        typeof reservation.operation_id !== 'string' ||
        typeof decision.reservation_id !== 'string'
      ) {
        throw new Error('authoritative LLM reservation omitted its controlled identity');
      }
      activeJourney.allowedLlm = {
        operation_id: reservation.operation_id,
        reservation_id: decision.reservation_id,
      };
    }
  }
  return response;
};

const loadedArtifact = await loadTypescriptSdkArtifact({ requireLangGraph: true }).catch(
  (error) => {
    process.stdout.write(
      `${JSON.stringify({
        event: 'error',
        runtime: 'typescript',
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : 'unknown artifact loading failure',
      })}\n`,
    );
    process.exit(1);
  },
);
const { evidence: SDK_EVIDENCE, langgraph, peers, root } = loadedArtifact;
let officialOpenAiArtifact = null;
function installedOpenAiConstructor() {
  const artifactResolver = createRequire(
    path.join(SDK_EVIDENCE.sdkInstallRoot ?? SDK_EVIDENCE.sdkPackageRoot, 'package.json'),
  );
  officialOpenAiArtifact = realpathSync(artifactResolver.resolve('openai'));
  const openAiPeer = artifactResolver('openai');
  const constructor = openAiPeer.OpenAI ?? openAiPeer.default ?? openAiPeer;
  if (typeof constructor !== 'function') {
    throw new Error('installed OpenAI constructor is unavailable');
  }
  return constructor;
}
const {
  PylvaBudgetExceeded,
  bufferSize,
  controlledExactUsage,
  currentContext,
  init,
  ready,
  track,
  wrapOpenAI,
} = root;
const { PylvaCallbackHandler, withLangGraphControlScope } = langgraph;
const { Annotation, END, START, StateGraph } = peers.graph;
const { HumanMessage } = peers.messages;
const { DynamicTool } = peers.tools;
const { FakeListChatModel } = peers.testing;

const MODEL = 'gpt-langgraph-e2e';
const TOOL_SLUG = 'langgraph-e2e-tool';
const TOOL_NAME = 'langgraph_e2e_tool';
const TOOL_METRIC = 'calls';
const PROBE_KEY = `pv_live_f0f0f0f0_${'f'.repeat(32)}`;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requiredEnvironment() {
  const endpoint = process.env.PYLVA_LANGGRAPH_ENDPOINT;
  const apiKey = process.env.PYLVA_LANGGRAPH_API_KEY;
  const customerId = process.env.PYLVA_LANGGRAPH_CUSTOMER_ID;
  const refusalKind = process.env.PYLVA_LANGGRAPH_REFUSAL_KIND ?? 'llm';
  if (!endpoint || !apiKey || !customerId || refusalKind !== 'llm') {
    throw new Error('invalid TypeScript LangGraph runner configuration');
  }
  return { apiKey, customerId, endpoint, refusalKind };
}

function seedCrossEntrypointIdentityProbe() {
  init({
    apiKey: PROBE_KEY,
    endpoint: 'https://identity-probe.invalid',
    batchSize: 100,
    flushInterval: 60_000,
    localMode: true,
  });
  const handler = new PylvaCallbackHandler({ llmTracking: 'callback' });
  const runId = crypto.randomUUID();
  handler.handleChatModelStart(
    { name: 'ProbeChatModel' },
    [],
    runId,
    undefined,
    { invocation_params: { provider: 'openai', model: MODEL } },
    [],
    {},
    'identity_probe',
  );
  handler.handleLLMEnd(
    {
      llmOutput: {
        tokenUsage: { promptTokens: 1, completionTokens: 1 },
        provider: 'openai',
        model: MODEL,
      },
    },
    runId,
  );
}

class ControlledChatModel extends FakeListChatModel {
  constructor(journey) {
    super({ responses: ['llm-ok'] });
    this.journey = journey;
  }

  async _generate(...args) {
    await this.journey.callLlm();
    return super._generate(...args);
  }
}

class Journey {
  constructor(customerId) {
    this.customerId = customerId;
    this.providerCalls = 0;
    this.toolCalls = 0;
    this.allowedLlm = null;
    this.allowedTool = null;
    this.telemetryBeforeRefusal = null;

    const OpenAI = installedOpenAiConstructor();
    activeJourney = this;
    this.openai = wrapOpenAI(
      new OpenAI({ apiKey: 'provider-private-langgraph-key', maxRetries: 0 }),
    );
    this.model = new ControlledChatModel(this);
    this.tool = new DynamicTool({
      name: TOOL_NAME,
      description: 'One deterministic priced integration-test tool call.',
      func: async () => {
        const result = await controlledExactUsage({
          costSourceSlug: TOOL_SLUG,
          toolName: TOOL_NAME,
          metric: TOOL_METRIC,
          value: '1',
          customerId: this.customerId,
          invoke: () => {
            this.toolCalls += 1;
            return 'tool-ok';
          },
        });
        if (this.allowedTool === null) {
          this.allowedTool = {
            operation_id: result.control.operationId,
            reservation_id: result.control.reservationId,
          };
        }
        return result.value;
      },
    });
  }

  async callLlm() {
    const openai = await this.openai;
    return openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'integration' }],
      max_completion_tokens: 8,
    });
  }
}

function buildGraph(journey) {
  const State = Annotation.Root({ value: Annotation() });
  return new StateGraph(State)
    .addNode('langgraph.allowed_llm', async (state, config) =>
      track(
        journey.customerId,
        { step: 'langgraph.allowed_llm', framework: 'langgraph' },
        async () => {
          const reply = await withLangGraphControlScope(() =>
            journey.model.invoke([new HumanMessage(state.value)], config),
          );
          return { value: String(reply.content) };
        },
      ),
    )
    .addNode('langgraph.allowed_tool', async (_state, config) =>
      track(
        journey.customerId,
        { step: 'langgraph.allowed_tool', framework: 'langgraph' },
        async () => {
          const value = await withLangGraphControlScope(() => journey.tool.invoke('run', config));
          return { value: String(value) };
        },
      ),
    )
    .addNode('langgraph.refused_llm', async (state, config) => {
      journey.telemetryBeforeRefusal = bufferSize();
      return track(
        journey.customerId,
        { step: 'langgraph.refused_llm', framework: 'langgraph' },
        async () => {
          const reply = await withLangGraphControlScope(() =>
            journey.model.invoke([new HumanMessage(state.value)], config),
          );
          return { value: String(reply.content) };
        },
      );
    })
    .addEdge(START, 'langgraph.allowed_llm')
    .addEdge('langgraph.allowed_llm', 'langgraph.allowed_tool')
    .addEdge('langgraph.allowed_tool', 'langgraph.refused_llm')
    .addEdge('langgraph.refused_llm', END)
    .compile();
}

async function main() {
  const { apiKey, customerId, endpoint, refusalKind } = requiredEnvironment();

  // Deliberately buffer one old-identity callback event in the independently
  // built LangGraph entrypoint. Root init below must synchronously clear it.
  seedCrossEntrypointIdentityProbe();
  init({
    apiKey,
    endpoint,
    batchSize: 100,
    flushInterval: 60_000,
    control: { mode: 'enforce', onUnavailable: 'deny', timeoutMs: 30_000 },
  });
  if (!(await ready())) throw new Error('TypeScript LangGraph control did not become ready');

  const handler = new PylvaCallbackHandler({
    customerId,
    llmTracking: 'auto',
    trackToolCalls: true,
    flushOnChainEnd: true,
  });
  const journey = new Journey(customerId);
  const graph = buildGraph(journey);
  let traceId = null;
  let refusal = null;
  let refusalError = null;

  try {
    await track(customerId, { step: 'langgraph.graph', framework: 'langgraph' }, async () => {
      traceId = currentContext()?.trace_id ?? null;
      await graph.invoke(
        { value: 'start' },
        {
          callbacks: [handler],
          metadata: { pylva_customer_id: customerId },
        },
      );
    });
  } catch (error) {
    if (!(error instanceof PylvaBudgetExceeded) || !error.authoritativeDenial) throw error;
    refusalError = error;
    refusal = error.authoritativeDenial;
    // Force a final deep-entrypoint flush observation. Any duplicate callback
    // event or stale identity-probe event becomes a visible /events request.
    await handler.handleChainError(error, crypto.randomUUID());
  }

  if (!refusal || !refusalError) throw new Error('expected final paid LLM node to be refused');
  if (officialOpenAiArtifact === null) throw new Error('official OpenAI artifact was not loaded');
  if (!traceId || !journey.allowedLlm || !journey.allowedTool) {
    throw new Error('allowed graph nodes did not expose exact controlled identities');
  }
  if (journey.telemetryBeforeRefusal === null) {
    throw new Error('refusal node did not execute');
  }

  write({
    event: 'result',
    runtime: 'typescript',
    ...SDK_EVIDENCE,
    sdkOpenAiArtifact: officialOpenAiArtifact,
    customer_id: customerId,
    trace_id: traceId,
    provider_calls: journey.providerCalls,
    tool_calls: journey.toolCalls,
    telemetry_before_refusal: journey.telemetryBeforeRefusal,
    telemetry_after_refusal: bufferSize(),
    identity_reinit_probe: true,
    allowed_llm: journey.allowedLlm,
    allowed_tool: journey.allowedTool,
    refusal: {
      kind: refusalKind,
      operation_id: refusal.operationId,
      decision_id: refusal.decisionId,
      rule_id: refusalError.rule_id,
      provider_calls_after: journey.providerCalls,
      tool_calls_after: journey.toolCalls,
    },
  });
}

main().catch((error) => {
  write({
    event: 'error',
    runtime: 'typescript',
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : 'unknown runner failure',
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
  });
  process.exitCode = 1;
});
