import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-tsc/**',
      '**/dist-tsc/**',
      '.next/**',
      '.open-next/**',
      '.claude/**',
      '.agent/**',
      '.context/**',
      '*.js',
      '*.mjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Strict TypeScript
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // ELv2 license boundary — Decision #21
      // Blocks imports from src/ee/ in non-ee code
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ee/**'],
              message:
                'Enterprise features (src/ee/) cannot be imported from MIT-licensed code. Move your code to src/ee/ if it needs enterprise dependencies.',
            },
          ],
        },
      ],

      // Logger secret/body redaction — Decision D12
      // Forbids logger.{info,warn,error,debug,trace,fatal}({ apiKey, messages, content, prompt,
      // completion, tool_arguments, ... }) calls anywhere in the backend. If you genuinely
      // need to log one of these (you don't), rename the key or inline a redacted string.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.object.name=/^(logger|log)$/][callee.property.name=/^(trace|debug|info|warn|error|fatal)$/] > ObjectExpression > Property[key.name=/^(apiKey|api_key|Authorization|authorization|messages|content|prompt|completion|tool_arguments)$/]',
          message:
            'Pino logger payloads MUST NOT include secrets, request bodies, or prompt/completion text. (Decision D12)',
        },
        {
          selector:
            'CallExpression[callee.object.property.name=/^(trace|debug|info|warn|error|fatal)$/] > ObjectExpression > Property[key.name=/^(apiKey|api_key|Authorization|authorization|messages|content|prompt|completion|tool_arguments)$/]',
          message:
            'Pino logger payloads MUST NOT include secrets, request bodies, or prompt/completion text. (Decision D12)',
        },

        // Shared table primitives — hand-rolled <table> markup drifts
        // (padding/borders/RTL); the only allowed raw <table> is inside the
        // primitive itself (inline eslint-disable there).
        {
          selector: "JSXOpeningElement[name.name='table']",
          message:
            'Hand-rolled <table> markup drifts (padding/borders/RTL). Compose tables from @/components/ui/table instead.',
        },
      ],
    },
  },
  // Override: allow ee imports within ee directory
  {
    files: ['src/ee/**/*.ts', 'src/ee/**/*.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // SDK packages log via console.warn('[pylva]', ...) — Pino is backend-only.
  // Exempt SDK source from the logger-redaction rule. Keep the TS plugin so
  // in-file `// eslint-disable-next-line @typescript-eslint/...` directives resolve.
  {
    files: ['packages/sdk-ts/**/*.ts', 'packages/sdk-py/**/*.ts'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
  // Test files may intentionally construct synthetic bad-log fixtures to verify
  // the redaction rule itself — disabled at the file level in those tests.
];
