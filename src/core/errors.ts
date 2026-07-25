/** Same (source, source_item_id) exists and the write is not allowed to replace it. */
export class SourceItemConflictError extends Error {
  readonly code = 'source_item_conflict';
}

/** Optimistic-concurrency failure: the item changed since the caller read it. */
export class RevisionConflictError extends Error {
  readonly code = 'revision_conflict';
}

/** Input failed a server-side trust/validation rule (e.g. bad evidence reference). */
export class ValidationError extends Error {
  readonly code = 'invalid_request';
}

/**
 * The namespace policy denies this operation (missing grant/rule, unknown or
 * invalid policy, unknown namespace). Fail-closed by design: absence of a
 * valid policy is a denial, never a fallback.
 */
export class PolicyDeniedError extends Error {
  readonly code = 'policy_denied';
}

/**
 * The audit log could not be written. Reads are refused (503) rather than
 * served unaudited — the system does not violate its own audit promise.
 */
export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable';
}

/** Same idempotency key was already used with a DIFFERENT payload. */
export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';
}

/**
 * Target item does not exist OR the caller may not see it — deliberately the
 * same error, so existence is never leaked across namespaces/ACLs.
 */
export class NotFoundError extends Error {
  readonly code = 'not_found';
}
