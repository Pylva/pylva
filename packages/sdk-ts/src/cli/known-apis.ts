// B3-T4a — built-in registry of known cost-source packages.
//
// Shipped as TS (not JSON) so tsup bundles it into dist/cli/*.js — the prior
// `known-apis.json` file wasn't copied into dist/ and the CLI crashed on first
// run with ENOENT. Keeping the registry in code also makes misspellings a
// compile-time failure instead of a runtime one.

export interface KnownLlmEntry {
  display_name: string;
  slug: string;
}
export interface KnownNonLlmEntry {
  display_name: string;
  slug: string;
  suggested_metric: string;
}

export interface KnownApis {
  llm_providers: Record<string, KnownLlmEntry>;
  non_llm_suggestions: Record<string, KnownNonLlmEntry>;
}

export const KNOWN_APIS: KnownApis = {
  llm_providers: {
    openai: { display_name: 'OpenAI', slug: 'openai' },
    '@openai/agents': { display_name: 'OpenAI', slug: 'openai' },
    anthropic: { display_name: 'Anthropic', slug: 'anthropic' },
    '@anthropic-ai/sdk': { display_name: 'Anthropic', slug: 'anthropic' },
    'google-generativeai': { display_name: 'Google Gemini', slug: 'google-gemini' },
    '@google/generative-ai': { display_name: 'Google Gemini', slug: 'google-gemini' },
    mistralai: { display_name: 'Mistral', slug: 'mistral' },
    '@mistralai/mistralai': { display_name: 'Mistral', slug: 'mistral' },
    cohere: { display_name: 'Cohere', slug: 'cohere' },
    'cohere-ai': { display_name: 'Cohere', slug: 'cohere' },
  },
  non_llm_suggestions: {
    elevenlabs: { display_name: 'ElevenLabs', slug: 'elevenlabs', suggested_metric: 'characters' },
    'pinecone-client': { display_name: 'Pinecone', slug: 'pinecone', suggested_metric: 'requests' },
    '@pinecone-database/pinecone': {
      display_name: 'Pinecone',
      slug: 'pinecone',
      suggested_metric: 'requests',
    },
    chromadb: { display_name: 'Chroma', slug: 'chroma', suggested_metric: 'requests' },
    deepgram: { display_name: 'Deepgram', slug: 'deepgram', suggested_metric: 'seconds' },
    replicate: { display_name: 'Replicate', slug: 'replicate', suggested_metric: 'predictions' },
  },
};
