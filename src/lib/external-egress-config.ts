import { createEnv } from '@t3-oss/env-core';
import * as v from 'valibot';

export const externalEgressEnv = createEnv({
  server: {
    EGRESS_BROKER_FUNCTION_NAME: v.optional(v.pipe(v.string(), v.minLength(1))),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
