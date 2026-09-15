import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyDeniedError, SourceItemConflictError } from '../src/core/errors.js';
import {
  radarHubContentHash,
  type RadarInsightItem,
} from '../src/core/radar-publications.js';
import { buildTestEnv, idem } from './helpers.js';

function sourceHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function insight(revision: number, content = `Radar insight revision ${revision}`): RadarInsightItem {
  return {
    type: 'insight',
    title: `Radar insight ${revision}`,
    content,
    data: { revision },
    tags: ['radar', `revision:${revision}`],
    entities: ['topic:context-hub'],
    sensitivity: 'normal',
    status: 'active',
    confidence: 0.82,
    occurred_at: '2026-09-15T00:00:00.000Z',
    derived_from: [],
    source_uri: `https://radar.example.test/insights/${revision}`,
  };
}

function publication(input: {
  insightId: string;
  revision: number;
  operationKey?: string;
  action?: 'publish' | 'withdraw';
  item?: RadarInsightItem;
}) {
  const action = input.action ?? 'publish';
  const item = input.item;
  return {
    schemaVersion: 1 as const,
    insightId: input.insightId,
    revision: input.revision,
    operationKey: input.operationKey ?? idem(),
    contentHash: sourceHash(`${input.insightId}:${input.revision}:${action}`),
    ...(item ? { hubContentHash: radarHubContentHash(item), item } : {}),
    action,
  };
}

describe('Radar publication contract', () => {
  const envs: Array<ReturnType<typeof buildTestEnv>> = [];
  afterEach(async () => {
    for (const env of envs.splice(0)) await env.app.close();
  });

  it('keeps publication, human review, revision supersession, withdrawal, and cache pointers distinct', () => {
    const env = buildTestEnv();
    envs.push(env);
    const radar = env.newClient({ id: 'radar-service', principalKind: 'service', profile: 'radar-publisher' });
    const reviewer = env.newClient({ id: 'human-reviewer', principalKind: 'human', profile: 'reviewer' });
    const agentReviewer = env.newClient({ id: 'agent-reviewer', principalKind: 'agent', profile: 'reviewer' });
    const reader = env.newClient({ id: 'reader', principalKind: 'agent', scopes: ['read'] });
    const insightId = `insight-${randomUUID()}`;

    const first = publication({ insightId, revision: 1, item: insight(1) });
    const published = env.commands.publishRadarInsight(radar.auth, first);
    expect(published.status).toBe('candidate');
    expect(published.hub_item_id).toBeTruthy();
    expect(env.commands.search(reader.auth, { queries: ['Radar insight'], limit: 10 }).items).toHaveLength(0);

    const replay = env.commands.publishRadarInsight(radar.auth, first);
    expect(replay.replayed).toBe(true);
    const dedup = env.commands.publishRadarInsight(radar.auth, { ...first, operationKey: idem() });
    expect(dedup.replayed).toBe(false);
    expect(dedup.created).toBe(false);
    expect(env.commands.listRadarPublications(radar.auth, { insightId }).publications).toHaveLength(1);

    expect(() => env.commands.reviewMemory(agentReviewer.auth, published.hub_item_id!, {
      decision: 'accept', expectedRevision: 1,
    }, idem())).toThrow(PolicyDeniedError);
    const accepted = env.commands.reviewMemory(reviewer.auth, published.hub_item_id!, {
      decision: 'accept', expectedRevision: 1, note: '人工核准',
    }, idem());
    expect(accepted.item.trust_state).toBe('accepted');
    expect(env.commands.listRadarPublications(radar.auth, { insightId }).publications[0]!.status).toBe('accepted');
    expect(env.commands.search(reader.auth, { queries: ['Radar insight'], limit: 10 }).items.map((item) => item.id)).toContain(published.hub_item_id);

    const second = publication({ insightId, revision: 2, item: insight(2) });
    const revised = env.commands.publishRadarInsight(radar.auth, second);
    expect(revised.status).toBe('candidate');
    expect(revised.hub_item_id).not.toBe(published.hub_item_id);
    const acceptedRevisionTwo = env.commands.reviewMemory(reviewer.auth, revised.hub_item_id!, {
      decision: 'accept', expectedRevision: 1,
    }, idem());
    expect(acceptedRevisionTwo.item.trust_state).toBe('accepted');
    expect(acceptedRevisionTwo.item.successor_of).toBe(published.hub_item_id);
    expect(env.itemsRepo.get({
      clientId: 'admin', isAdmin: true, namespace: null, readSources: null, maxSensitivity: 'private',
    }, published.hub_item_id!)!.status).toBe('superseded');

    const withdrawn = env.commands.publishRadarInsight(radar.auth, publication({
      insightId, revision: 3, action: 'withdraw',
    }));
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.hub_withdrawal_status).toBe('applied');
    const withdrawnItem = env.commands.getItem(radar.auth, revised.hub_item_id!);
    expect(withdrawnItem?.source_withdrawn_at).toBeTruthy();
    expect(env.commands.search(reader.auth, { queries: ['Radar insight'], limit: 10 }).items).toHaveLength(0);

    const changes = env.commands.changes(radar.auth, { after: 0, limit: 100 }).events;
    const invalidation = changes.find((event) => event.action === 'radar.publish' && event.entity_id === revised.hub_item_id && event.revision === withdrawn.hub_item_revision);
    expect(invalidation?.entity_kind).toBe('context_item');
    expect(invalidation?.cache_pointer).toMatchObject({ hub_item_id: revised.hub_item_id, revision: withdrawn.hub_item_revision });

    const late = env.commands.publishRadarInsight(radar.auth, { ...second, operationKey: idem() });
    expect(late.status).toBe('accepted');
    expect(env.commands.getItem(radar.auth, revised.hub_item_id!)?.source_withdrawn_at).toBeTruthy();
  });

  it('rejects conflicting revisions, accepted-insight upserts, and non-service publishers', () => {
    const env = buildTestEnv();
    envs.push(env);
    const radar = env.newClient({ id: 'radar-service', principalKind: 'service', profile: 'radar-publisher' });
    const reviewer = env.newClient({ id: 'human-reviewer', principalKind: 'human', profile: 'reviewer' });
    const ordinary = env.newClient({ id: 'ordinary-service', principalKind: 'service' });
    const insightId = `insight-${randomUUID()}`;
    const first = publication({ insightId, revision: 1, item: insight(1) });
    const published = env.commands.publishRadarInsight(radar.auth, first);
    env.commands.reviewMemory(reviewer.auth, published.hub_item_id!, { decision: 'accept', expectedRevision: 1 }, idem());

    expect(() => env.commands.publishRadarInsight(radar.auth, {
      ...first,
      operationKey: idem(),
      item: insight(1, 'different payload'),
      hubContentHash: radarHubContentHash(insight(1, 'different payload')),
    })).toThrow(SourceItemConflictError);
    expect(() => env.commands.createMemory(radar.auth, {
      ...insight(1),
      source_item_id: `radar:${insightId}:r1`,
      idempotency_key: idem(),
    })).toThrow(SourceItemConflictError);
    expect(() => env.commands.publishRadarInsight(ordinary.auth, publication({ insightId, revision: 2, item: insight(2) }))).toThrow(PolicyDeniedError);
  });

  it('exposes the same command contract over REST with server-bound publisher identity', async () => {
    const env = buildTestEnv();
    envs.push(env);
    const radar = env.newClient({ id: 'radar-service', principalKind: 'service', profile: 'radar-publisher' });
    const item = insight(1);
    const input = publication({ insightId: 'http-insight', revision: 1, item });
    const response = await env.app.inject({
      method: 'POST',
      url: '/v1/radar/publications',
      headers: { authorization: `Bearer ${radar.apiKey}` },
      payload: {
        schema_version: input.schemaVersion,
        insight_id: input.insightId,
        revision: input.revision,
        operation_key: input.operationKey,
        content_hash: input.contentHash,
        action: input.action,
        item: input.item,
        source: 'forged-source',
        namespace: 'work',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().publisher_id).toBe('radar-service');
    expect(response.json().namespace).toBe('personal');
    const listed = await env.app.inject({
      method: 'GET',
      url: '/v1/radar/publications?insight_id=http-insight',
      headers: { authorization: `Bearer ${radar.apiKey}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().publications[0].status).toBe('candidate');
  });
});
