/** Connector SDK boundary. A connector is an outbound REST producer and never
 * receives a SQLite handle; all writes are ordinary domain API requests. */
export interface ConnectorRunMetadata {
  connector: string;
  checkpoint_key: string;
  checkpoint_value?: string | null;
  status: 'ok' | 'stale' | 'failed';
  counts?: Record<string, number>;
}

export interface ConnectorItem {
  type: string;
  title: string;
  content?: string;
  data?: unknown;
  tags?: string[];
  entities?: string[];
  source_item_id: string;
  source_uri?: string;
  status?: 'active' | 'completed' | 'cancelled';
  idempotency_key: string;
}

export class ConnectorRestClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`ContextHub connector request failed (${response.status})`);
    return body;
  }

  upsertBatch(items: ConnectorItem[], idempotencyKey: string) {
    return this.request('/v1/items/batch', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ items }) });
  }

  recordRun(metadata: ConnectorRunMetadata, idempotencyKey: string) {
    return this.request('/v1/connectors/runs', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ connector: metadata.connector, checkpoint_key: metadata.checkpoint_key, checkpoint_value: metadata.checkpoint_value ?? null, status: metadata.status, counts: metadata.counts ?? {}, idempotency_key: idempotencyKey }) });
  }

  tombstoneBatch(items: Array<{ id: string; expected_revision: number }>, idempotencyKey: string) {
    return this.request('/v1/connectors/tombstones', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ items, idempotency_key: idempotencyKey }) });
  }

  changes(after = 0, limit = 100) { return this.request(`/v1/changes?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`); }
}
