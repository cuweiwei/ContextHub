import type { ConnectorItem, ConnectorRunMetadata } from './sdk.js';
import { ConnectorRestClient } from './sdk.js';

export interface ConnectorPage<T> {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  checkpointValue?: string | null;
}

export interface ConnectorWorkerOptions<T> {
  connector: string;
  checkpointKey: string;
  client: ConnectorRestClient;
  fetchPage: (cursor: string | null) => Promise<ConnectorPage<T>>;
  map: (item: T) => ConnectorItem;
  initialCursor?: string | null;
  maxPages?: number;
  retryAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  loadCheckpoint?: () => Promise<string | null>;
  saveCheckpoint?: (value: string | null) => Promise<void>;
}

export interface ConnectorWorkerResult {
  connector: string;
  status: 'ok' | 'failed';
  pages: number;
  items: number;
  checkpointValue: string | null;
  error_code?: string;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Only emit a bounded classification. Provider messages can contain tokens,
  // URLs, query strings or source payloads and must never become run metadata.
  const match = message.toLowerCase().match(/(?:[a-z0-9-]+_http_[0-9]{3}|connector_[a-z0-9_]+|provider_[a-z0-9_]+|timeout|aborted)/);
  return match?.[0] ?? 'connector_error';
}

async function retry<T>(operation: () => Promise<T>, attempts: number, sleep: (milliseconds: number) => Promise<void>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(250 * (2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Provider-neutral worker loop. Provider adapters only return minimized items;
 * every write, checkpoint and run status still crosses the ContextHub REST
 * command boundary with idempotency.
 */
export async function runConnectorWorker<T>(options: ConnectorWorkerOptions<T>): Promise<ConnectorWorkerResult> {
  const maxPages = options.maxPages ?? 10_000;
  const attempts = options.retryAttempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  let cursor = options.initialCursor ?? (options.loadCheckpoint ? await options.loadCheckpoint() : null);
  let pages = 0;
  let items = 0;
  let checkpointValue: string | null = null;

  try {
    while (pages < maxPages) {
      const page = await retry(() => options.fetchPage(cursor), attempts, sleep);
      pages += 1;
      const mapped = page.items.map(options.map);
      if (mapped.length > 0) {
        for (let offset = 0; offset < mapped.length; offset += 100) {
          const batch = mapped.slice(offset, offset + 100);
          const idempotencyKey = `${options.connector}:${options.checkpointKey}:${page.nextCursor ?? 'complete'}:${offset}`;
          await retry(() => options.client.upsertBatch(batch, idempotencyKey), attempts, sleep);
        }
        items += mapped.length;
      }
      checkpointValue = page.checkpointValue ?? page.nextCursor ?? checkpointValue;
      if (page.complete || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (pages >= maxPages) throw new Error('connector_page_limit_exceeded');
    const metadata: ConnectorRunMetadata = { connector: options.connector, checkpoint_key: options.checkpointKey, checkpoint_value: checkpointValue, status: 'ok', counts: { pages, items } };
    await retry(() => options.client.recordRun(metadata, `${options.connector}:run:${checkpointValue ?? 'initial'}:${pages}:${items}`), attempts, sleep);
    if (options.saveCheckpoint) await retry(() => options.saveCheckpoint!(checkpointValue), attempts, sleep);
    return { connector: options.connector, status: 'ok', pages, items, checkpointValue };
  } catch (error) {
    const code = errorCode(error);
    try {
      await options.client.recordRun({ connector: options.connector, checkpoint_key: options.checkpointKey, checkpoint_value: checkpointValue, status: 'failed', counts: { pages, items } }, `${options.connector}:failed:${checkpointValue ?? 'initial'}:${pages}:${code}`);
    } catch {
      // Preserve the original provider failure. The next scheduled run will
      // retry from the last committed checkpoint.
    }
    return { connector: options.connector, status: 'failed', pages, items, checkpointValue, error_code: code };
  }
}
