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
