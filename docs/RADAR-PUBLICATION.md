# Radar → ContextHub Publication Contract

此文件描述 ContextHub 的 `contexthub-radar-publication/v1` 接收端。Radar 的原始資料與 insight durable state 仍由 Radar 擁有；ContextHub 只保存有界的 insight item、publication receipt 與 revision head。

## Endpoint

`POST /v1/radar/publications` requires a namespace-bound service credential with `write` scope and the explicit `memory.publish_insight` capability. `GET /v1/radar/publications` requires the same credential with `read` scope and is used for reconciliation.

POST body:

```json
{
  "schema_version": 1,
  "insight_id": "stable-radar-id",
  "revision": 3,
  "operation_key": "uuid-or-stable-operation-key",
  "content_hash": "sha256-hex-of-radar-insight",
  "hub_content_hash": "sha256-hex-of-canonical-hub-item",
  "action": "publish",
  "item": {
    "type": "insight",
    "title": "短標題",
    "content": "有界的摘要與結論",
    "tags": ["radar"],
    "entities": ["topic:example"],
    "derived_from": [],
    "status": "active"
  }
}
```

`action=withdraw` uses the same stable `insight_id` and a positive revision, omits `item` and `hub_content_hash`, and records a durable tombstone. All other item fields are validated by the canonical `newItemSchema`; the body cannot select `source`, `namespace`, or `authority`. The authenticated publisher becomes the item source, its server-bound namespace is used, and a service is assigned `authority=app`.

`hub_content_hash` is optional for compatibility. When present, it must equal SHA-256 over stable-key JSON (NFC strings, sorted object keys) of the normalized item fields: `type`, `title`, `content`, `data`, canonical sorted/deduplicated `tags` and `entities`, `sensitivity`, `status`, `confidence`, `occurred_at`, `expires_at`, `valid_from`, `valid_until`, `last_verified_at`, `decay_policy`, normalized `claim_key`, sorted `derived_from`, and `source_uri`. When omitted for publish, ContextHub computes and stores it.

## Lifecycle and ordering

- Every publish is a candidate. `memory.publish_insight` never grants automatic acceptance.
- A human reviewer must use the existing review command/UI to accept or reject it. Acceptance updates the receipt; it does not rewrite provenance.
- A higher revision creates a new Hub insight item. If the current Hub item is accepted, the new candidate points to it as `successor_of`; human acceptance atomically supersedes the predecessor.
- The same publisher, insight, revision, and action are unique. Repeating the same payload returns the existing receipt; a different hash returns `409 source_item_conflict`. The same `operation_key` is exactly-once through the normal idempotency ledger.
- An older revision is stored as `stale` and never changes the head. A withdrawn head is retained, so late old publish messages cannot resurrect ordinary recall.
- Withdrawal sets `context_items.source_withdrawn_at`, increments the Hub item revision, writes a version snapshot and a `radar.publish` change pointer, and reports `hub_withdrawal_status` as `applied`, `not_found`, or `stale`. It is source invalidation, not a fabricated human review/revoke event.

Normal list/search/brief/current/compiler surfaces exclude source-withdrawn and superseded rows. Authorized exact-item and history reads retain the row and provenance for reconciliation. Every REST operation reaches the domain command layer, which performs policy, idempotency, audit, transaction, and change-event handling.
