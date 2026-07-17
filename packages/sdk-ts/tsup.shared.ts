import { dirname, resolve as resolvePath } from 'node:path';
import type { Options } from 'tsup';

export const bundledWorkspacePackages = [
  '@pylva/shared',
  '@pylva/shared/telemetry',
  '@pylva/shared/telemetry-values',
  '@pylva/shared/budget-errors',
  '@pylva/shared/budget-control',
  '@pylva/shared/errors',
  '@pylva/shared/rules',
  '@pylva/shared/cost-sources',
] as const;

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

function resolvesToSource(importer: string, request: string, suffix: string): boolean {
  if (importer.length === 0 || !request.startsWith('.')) return false;
  return resolvePath(dirname(importer), request).replaceAll('\\', '/').endsWith(suffix);
}

/**
 * Leave closure-owned runtime modules as package-private imports. Node maps
 * each specifier to one hardened canonical CJS file through package imports.
 */
export const canonicalRuntimeExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-runtime-externals',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const importer = args.importer.replaceAll('\\', '/');
      const request = args.path.replaceAll('\\', '/');
      if (
        resolvesToSource(importer, request, '/src/core/config.js') &&
        !importer.endsWith('/src/index.ts') &&
        !importer.endsWith('/src/core/identity.ts')
      ) {
        return { path: '#pylva/core-runtime', external: true };
      }
      if (/\/_engine\.js$/.test(request) && !importer.endsWith('/src/internal/engine-runtime.ts')) {
        return { path: '#pylva/engine-runtime', external: true };
      }
      if (
        /\/_budget\.js$/.test(request) &&
        !importer.endsWith('/src/internal/budget-enforcement-runtime.ts')
      ) {
        return { path: '#pylva/budget-enforcement-runtime', external: true };
      }
      if (
        /\/_usage_bound\.js$/.test(request) &&
        !importer.endsWith('/src/internal/usage-snapshot-runtime.ts')
      ) {
        if (importer.endsWith('/src/index.ts')) {
          return { path: '#pylva/public-errors', external: true };
        }
        return { path: '#pylva/usage-snapshot-runtime', external: true };
      }
      if (
        /\/core-runtime-state\.js$/.test(request) &&
        !importer.endsWith('/src/internal/core-runtime.ts')
      ) {
        return { path: '#pylva/core-runtime', external: true };
      }
      if (
        /\/(?:context|control_correlation)\.js$/.test(request) &&
        !importer.endsWith('/src/internal/execution-runtime.ts')
      ) {
        return { path: '#pylva/execution-runtime', external: true };
      }
      if (
        /\/errors\/(?:budget_exceeded|control|strict_provider)\.js$/.test(request) &&
        !importer.endsWith('/src/internal/public-errors.ts')
      ) {
        return { path: '#pylva/public-errors', external: true };
      }
      return undefined;
    });
  },
};

/** Root imports provider implementations from their one physical CJS files. */
export const canonicalProviderExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-provider-externals',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const request = args.path.replaceAll('\\', '/');
      if (/\/(?:openai|openai_controlled)\.js$/.test(request)) {
        return { path: '#pylva/openai-runtime', external: true };
      }
      if (/\/(?:anthropic|anthropic_controlled)\.js$/.test(request)) {
        return { path: '#pylva/anthropic-runtime', external: true };
      }
      if (/\/vercel-ai\.js$/.test(request)) {
        return { path: '#pylva/vercel-ai-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const canonicalTelemetryExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-telemetry-external',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const request = args.path.replaceAll('\\', '/');
      if (/\/telemetry\.js$/.test(request)) {
        return { path: '#pylva/telemetry-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const canonicalBudgetExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-budget-external',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const importer = args.importer.replaceAll('\\', '/');
      const request = args.path.replaceAll('\\', '/');
      if (
        /\/(?:budget_accumulator|budget_rules|pricing_cache|rules_cache)\.js$/.test(request) &&
        !importer.endsWith('/src/internal/budget-runtime.ts')
      ) {
        return { path: '#pylva/budget-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const canonicalRoutingExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-routing-external',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const request = args.path.replaceAll('\\', '/');
      if (/\/(?:rules_engine|model_routing|failover|client_registry)\.js$/.test(request)) {
        return { path: '#pylva/routing-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const canonicalNonLlmExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-nonllm-external',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const request = args.path.replaceAll('\\', '/');
      if (/\/non_llm_policy\.js$/.test(request)) {
        return { path: '#pylva/nonllm-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const canonicalControlExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-control-external',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const request = args.path.replaceAll('\\', '/');
      // Provider attempts share one physical LLM-only strict runtime. The
      // public descriptor-safe all-cost facade remains in the root bundle.
      if (/\/(?:control_attempt|strict_attempt_control)\.js$/.test(request)) {
        return { path: '#pylva/control-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const canonicalWrapperExternalPlugin: EsbuildPlugin = {
  name: 'pylva-canonical-wrapper-external',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const importer = args.importer.replaceAll('\\', '/');
      const request = args.path.replaceAll('\\', '/');
      if (
        /\/_init_validation\.js$/.test(request) &&
        !importer.endsWith('/src/internal/init-validation-runtime.ts')
      ) {
        return { path: '#pylva/init-validation-runtime', external: true };
      }
      if (
        /\/_strict_unwrap\.js$/.test(request) &&
        !importer.endsWith('/src/internal/strict-unwrapper-runtime.ts')
      ) {
        return { path: '#pylva/strict-unwrapper-runtime', external: true };
      }
      return undefined;
    });
  },
};

export const runtimeBuildBase: Pick<
  Options,
  | 'shims'
  | 'noExternal'
  | 'tsconfig'
  | 'sourcemap'
  | 'splitting'
  | 'minify'
  | 'target'
  | 'treeshake'
> = {
  shims: true,
  noExternal: [...bundledWorkspacePackages, 'valibot'],
  tsconfig: './tsconfig.build.json',
  sourcemap: true,
  splitting: false,
  // The orchestrator applies one pinned Terser pass after every runtime phase.
  // Keeping esbuild unminified here is required for accurate map chaining.
  minify: false,
  target: 'node20',
  treeshake: true,
};
