import * as v from 'valibot';

const MAX_RANGE_DAYS = 180;
const DEFAULT_RANGE_DAYS = 30;
const MAX_SWAPS = 10;

const modelSwapSchema = v.object({
  from_model: v.pipe(v.string(), v.minLength(1)),
  to_model: v.pipe(v.string(), v.minLength(1)),
  from_provider: v.pipe(v.string(), v.minLength(1)),
  to_provider: v.pipe(v.string(), v.minLength(1)),
});

export const simulatorRequestSchema = v.pipe(
  v.object({
    customer_id: v.optional(v.nullable(v.string()), null),
    period_start: v.optional(v.pipe(v.string(), v.isoDate())),
    period_end: v.optional(v.pipe(v.string(), v.isoDate())),
    model_swaps: v.pipe(
      v.array(modelSwapSchema),
      v.minLength(1, 'At least one model swap is required'),
      v.maxLength(MAX_SWAPS, `Maximum ${MAX_SWAPS} model swaps per simulation`),
    ),
  }),
  v.transform((input) => {
    const now = new Date();
    const end = input.period_end ? new Date(input.period_end) : now;
    const start = input.period_start
      ? new Date(input.period_start)
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
    return { ...input, period_start: start.toISOString(), period_end: end.toISOString() };
  }),
  v.check((input) => {
    const start = new Date(input.period_start);
    const end = new Date(input.period_end);
    const diffDays = (end.getTime() - start.getTime()) / 86_400_000;
    return diffDays >= 0 && diffDays <= MAX_RANGE_DAYS;
  }, `Date range must be between 0 and ${MAX_RANGE_DAYS} days`),
);

export type ValidatedSimulatorRequest = v.InferOutput<typeof simulatorRequestSchema>;
