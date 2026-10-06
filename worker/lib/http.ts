// Errors, JSON bodies and small validators for the API. Error bodies are `{ error: { code, message } }`.

import type { Context } from 'hono';
import type { ApiErrorBody, ErrorCode } from '../../shared/api';
import type { AppEnv } from '../env';

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  validation: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  forbidden: 403,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message?: string, status?: number) {
    super(message ?? code);
    this.code = code;
    this.status = status ?? STATUS[code];
  }
  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = (what = 'Not found') => new ApiError('not_found', what);
export const unauthorized = () => new ApiError('unauthorized', 'Not signed in');
export const validation = (message: string) => new ApiError('validation', message);

const MAX_BODY = 16 * 1024;

export type JsonObject = Record<string, unknown>;

/** Parses a JSON object body. Requires a JSON content type (part of the CSRF story) and a modest size. */
export async function readJson(c: Context<AppEnv>): Promise<JsonObject> {
  const ct = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw validation('Expected application/json');
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new ApiError('validation', 'Body too large', 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw validation('Body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validation('Expected a JSON object');
  return body as JsonObject;
}

/** A required string field, trimmed, within `max` characters. */
export function stringField(body: JsonObject, key: string, max = 256): string {
  const v = body[key];
  if (typeof v !== 'string') throw validation(`${key}: expected a string`);
  const s = v.trim();
  if (!s) throw validation(`${key}: must not be empty`);
  if (s.length > max) throw validation(`${key}: too long`);
  return s;
}

/** An optional string field: undefined when missing or null. */
export function optionalString(body: JsonObject, key: string, max = 1024): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw validation(`${key}: expected a string`);
  return v;
}

/** A required integer field between `lo` and `hi` inclusive. */
export function intField(body: JsonObject, key: string, lo: number, hi: number): number {
  const v = body[key];
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw validation(`${key}: expected an integer between ${lo} and ${hi}`);
  return v as number;
}

/** An optional boolean field. */
export function optionalBool(body: JsonObject, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw validation(`${key}: expected true or false`);
  return v;
}

/** Hono `onError` handler: ApiError → its JSON; anything else → 500 (logged). */
export function handleError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  console.error('Unhandled error', err);
  const body: ApiErrorBody = { error: { code: 'internal', message: 'Something went wrong' } };
  return c.json(body, 500);
}
