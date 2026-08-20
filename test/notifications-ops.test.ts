import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { assertAllowedWebhook, deriveWebhookSecret, enqueueChangeNotification, recordDeliveryFailure, NotificationDispatcher } from '../src/core/notifications.js';

describe('change delivery operations', () => {
  it('enqueues metadata-only notifications and enforces HTTPS host allowlists', () => {
    const db = openDatabase(':memory:');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO change_subscriptions (id, namespace, kind, endpoint, event_categories, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('sub-1', 'personal', 'webhook', 'https://hooks.example.test/context', '["connector.sync"]', 'active', 'human-1', now, now);
    expect(assertAllowedWebhook('https://hooks.example.test/context', { allowedHosts: ['hooks.example.test'] }).hostname).toBe('hooks.example.test');
    expect(() => assertAllowedWebhook('http://hooks.example.test/context', { allowedHosts: ['hooks.example.test'] })).toThrow();
    expect(() => assertAllowedWebhook('https://other.example.test/context', { allowedHosts: ['hooks.example.test'] })).toThrow();
    expect(deriveWebhookSecret('sub-1', 'master')).toMatch(/^[a-f0-9]{64}$/);
    expect(enqueueChangeNotification(db, { namespace: 'personal', category: 'connector.sync', severity: 'warning', count: 1, timestamp: now })).toBe(1);
    const delivery = db.prepare('SELECT payload_metadata FROM change_deliveries WHERE subscription_id = ?').get('sub-1') as { payload_metadata: string };
    expect(delivery.payload_metadata).toContain('connector.sync');
    expect(delivery.payload_metadata).not.toContain('Memory');
    db.close();
  });

  it('retries then dead-letters without persisting provider payloads', async () => {
    const db = openDatabase(':memory:'); const now = new Date('2026-08-20T00:00:00.000Z').toISOString();
    db.prepare('INSERT INTO change_subscriptions (id, namespace, kind, endpoint, event_categories, status, created_by, created_at, updated_at, pending_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('sub-2', 'personal', 'webhook', 'https://hooks.example.test/context', '["*"]', 'active', 'human-1', now, now, 1);
    db.prepare('INSERT INTO change_deliveries (id, subscription_id, cursor, payload_metadata, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('del-2', 'sub-2', null, '{"category":"doctor","severity":"critical","count":1}', 'pending', 0, now, now);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"provider_body":"secret"}', { status: 500 }));
    const dispatcher = new NotificationDispatcher(db, { allowedHosts: ['hooks.example.test'], signingMasterKey: 'master' }, fetchImpl);
    expect((await dispatcher.dispatchDue(new Date(now))).failed).toBe(1);
    expect((db.prepare('SELECT last_error_code FROM change_deliveries WHERE id = ?').get('del-2') as { last_error_code: string }).last_error_code).toBe('http_500');
    for (let attempt = 0; attempt < 7; attempt += 1) recordDeliveryFailure(db, 'del-2', 'http_500', new Date(now));
    const row = db.prepare('SELECT status, attempts, last_error_code FROM change_deliveries WHERE id = ?').get('del-2') as { status: string; attempts: number; last_error_code: string };
    expect(row).toMatchObject({ status: 'dead_letter', attempts: 8, last_error_code: 'http_500' });
    expect((db.prepare('SELECT status FROM change_subscriptions WHERE id = ?').get('sub-2') as { status: string }).status).toBe('dead_letter');
    db.prepare("UPDATE change_deliveries SET status = 'retry', attempts = 0 WHERE id = ?").run('del-2');
    recordDeliveryFailure(db, 'del-2', 'token=super-secret /var/private/path', new Date(now));
    expect((db.prepare('SELECT last_error_code FROM change_deliveries WHERE id = ?').get('del-2') as { last_error_code: string }).last_error_code).toBe('notification_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    db.close();
  });
});
