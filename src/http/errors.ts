import type { FastifyReply } from 'fastify';
import {
  AuditUnavailableError,
  IdempotencyConflictError,
  NotFoundError,
  PolicyDeniedError,
  RevisionConflictError,
  SourceItemConflictError,
  ValidationError,
} from '../core/errors.js';

/** Single mapping from domain errors to HTTP responses for every route. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (
    err instanceof SourceItemConflictError ||
    err instanceof RevisionConflictError ||
    err instanceof IdempotencyConflictError
  ) {
    return reply.code(409).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ValidationError) {
    return reply.code(400).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof PolicyDeniedError) {
    return reply.code(403).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof AuditUnavailableError) {
    return reply.code(503).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function idempotencyKeyFrom(headers: Record<string, unknown>, body?: unknown): string | null {
  const header = headers['idempotency-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (body && typeof body === 'object' && 'idempotency_key' in body) {
    const k = (body as { idempotency_key?: unknown }).idempotency_key;
    if (typeof k === 'string' && k.trim()) return k.trim();
  }
  return null;
}
