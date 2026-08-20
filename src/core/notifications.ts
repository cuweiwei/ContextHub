import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { URL } from 'node:url';
import type { DB } from '../db/connection.js';

export interface NotificationConfig { allowedHosts: string[]; signingMasterKey?: string }

function read0600(file: string): string {
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error('notification secret mount must be mode 0600');
  return fs.readFileSync(file, 'utf8').trim();
}

export function assertAllowedWebhook(endpoint: string, config: NotificationConfig): URL {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !config.allowedHosts.includes(url.hostname)) throw new Error('webhook endpoint is not HTTPS or is outside WEBHOOK_ALLOWED_HOSTS');
  return url;
}

export function deriveWebhookSecret(subscriptionId: string, masterKey: string): string {
  return createHmac('sha256', masterKey).update(`contexthub:webhook:${subscriptionId}`).digest('hex');
}

export function enqueueChangeNotification(db: DB, input: { namespace: string; category: string; severity: 'info' | 'warning' | 'critical'; count: number; timestamp: string; link?: string }): number {
  const subscriptions = db.prepare("SELECT id, pending_count, event_categories FROM change_subscriptions WHERE namespace = ? AND status = 'active'").all(input.namespace) as Array<{ id: string; pending_count: number; event_categories: string }>;
  const insert = db.prepare('INSERT INTO change_deliveries (id, subscription_id, cursor, payload_metadata, status, attempts, next_attempt_at, created_at) VALUES (?, ?, NULL, ?, \'pending\', 0, ?, ?)');
  let count = 0;
  for (const subscription of subscriptions) {
    if (subscription.pending_count >= 1000) continue;
    const categories = JSON.parse(subscription.event_categories) as string[];
    if (!categories.includes('*') && !categories.includes(input.category)) continue;
    const payload = { category: input.category, severity: input.severity, count: input.count, timestamp: input.timestamp, link: input.link ?? null };
    insert.run(`del_${randomUUID()}`, subscription.id, JSON.stringify(payload), input.timestamp, input.timestamp);
    db.prepare('UPDATE change_subscriptions SET pending_count = pending_count + 1, updated_at = ? WHERE id = ?').run(input.timestamp, subscription.id);
    count += 1;
  }
  return count;
}

export const DELIVERY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];

function safeErrorCode(value: string): string {
  const match = value.toLowerCase().match(/(?:http_[0-9]{3}|timeout|aborted|notification_[a-z0-9_]+|provider_[a-z0-9_]+)/);
  return match?.[0] ?? 'notification_error';
}

export function recordDeliveryFailure(db: DB, deliveryId: string, errorCode: string, now = new Date()): 'retry' | 'dead_letter' {
  const row = db.prepare('SELECT attempts, subscription_id FROM change_deliveries WHERE id = ?').get(deliveryId) as { attempts: number; subscription_id: string } | undefined;
  if (!row) throw new Error('delivery not found');
  const attempts = row.attempts + 1;
  const code = safeErrorCode(errorCode);
  if (attempts >= 8) { db.prepare("UPDATE change_deliveries SET attempts = ?, status = 'dead_letter', last_error_code = ? WHERE id = ?").run(attempts, code, deliveryId); db.prepare("UPDATE change_subscriptions SET status = 'dead_letter', pending_count = CASE WHEN pending_count > 0 THEN pending_count - 1 ELSE 0 END, updated_at = ? WHERE id = ?").run(now.toISOString(), row.subscription_id); return 'dead_letter'; }
  const delay = DELIVERY_RETRY_DELAYS_MS[Math.min(attempts - 1, DELIVERY_RETRY_DELAYS_MS.length - 1)]!;
  db.prepare("UPDATE change_deliveries SET attempts = ?, status = 'retry', last_error_code = ?, next_attempt_at = ? WHERE id = ?").run(attempts, code, new Date(now.getTime() + delay).toISOString(), deliveryId); return 'retry';
}

export class NotificationDispatcher {
  constructor(private readonly db: DB, private readonly config: NotificationConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async dispatchDue(now = new Date()): Promise<{ delivered: number; failed: number }> {
    const due = this.db.prepare("SELECT d.id, d.subscription_id, d.payload_metadata, s.kind, s.endpoint FROM change_deliveries d JOIN change_subscriptions s ON s.id = d.subscription_id WHERE d.status IN ('pending', 'retry') AND d.next_attempt_at <= ? ORDER BY d.created_at LIMIT 100").all(now.toISOString()) as Array<{ id: string; subscription_id: string; payload_metadata: string; kind: string; endpoint: string | null }>;
    let delivered = 0; let failed = 0;
    for (const delivery of due) {
      try {
        const body = delivery.payload_metadata;
        let response: Response;
        if (delivery.kind === 'webhook' && delivery.endpoint && this.config.signingMasterKey) {
          const url = assertAllowedWebhook(delivery.endpoint, this.config); const signature = createHmac('sha256', deriveWebhookSecret(delivery.subscription_id, this.config.signingMasterKey)).update(body).digest('hex');
          response = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-contexthub-signature': `sha256=${signature}` }, body });
        } else if (delivery.kind === 'telegram') {
          const token = read0600(process.env.TELEGRAM_BOT_TOKEN_FILE ?? ''); const chatId = read0600(process.env.TELEGRAM_CHAT_ID_FILE ?? '');
          response = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: `ContextHub notification: ${body}` }) });
        } else throw new Error('notification provider is not configured');
        if (!response.ok) throw new Error(`http_${response.status}`);
        this.db.prepare("UPDATE change_deliveries SET status = 'delivered', delivered_at = ? WHERE id = ?").run(now.toISOString(), delivery.id); this.db.prepare('UPDATE change_subscriptions SET pending_count = CASE WHEN pending_count > 0 THEN pending_count - 1 ELSE 0 END, updated_at = ? WHERE id = ?').run(now.toISOString(), delivery.subscription_id); delivered += 1;
      } catch (err) { recordDeliveryFailure(this.db, delivery.id, (err as Error).message, now); failed += 1; }
    }
    return { delivered, failed };
  }
}
