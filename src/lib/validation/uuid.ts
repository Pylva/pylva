import * as v from 'valibot';

const uuidSchema = v.pipe(v.string(), v.uuid());

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && v.is(uuidSchema, value);
}
