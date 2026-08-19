import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { createAuditRepo } from '../src/core/audit-repo.js';
import { mapCalendarEvent } from '../src/connectors/google-calendar.js';
import { mapGitHubObject } from '../src/connectors/github.js';
import { evaluateNeuralGate } from '../src/core/neural-embedding.js';
import { exportNamespace, readNamespaceArchive } from '../src/core/namespace-archive.js';

describe('P1/P2 foundations', () => {
  it('verifies and detects a tampered audit chain', () => {
    const db = openDatabase(':memory:'); const audit = createAuditRepo(db);
    audit.log({ namespace: 'personal', clientId: 'test', action: 'test', outcome: 'allow', details: { count: 1 } });
    expect(audit.verifyChain().verified).toBe(true);
    db.prepare('UPDATE audit_log SET action = ? WHERE id = 1').run('tampered');
    expect(audit.verifyChain().verified).toBe(false); db.close();
  });

  it('keeps connector projections minimized', () => {
    const calendar = mapCalendarEvent({ id: 'e1', summary: 'Meeting', description: 'secret', attendees: [{ email: 'secret' }], location: 'secret', start: { dateTime: '2026-08-20T01:00:00Z' }, end: { dateTime: '2026-08-20T02:00:00Z' } } as any, 'primary');
    expect(calendar.content).toBe(''); expect(JSON.stringify(calendar)).not.toContain('secret');
    const github = mapGitHubObject('issue', { id: 1, title: 'Issue', body: 'secret' } as any, 'owner/repo');
    expect(JSON.stringify(github)).not.toContain('secret');
  });

  it('rejects archive tampering and keeps neural activation gated', () => {
    const db = openDatabase(':memory:'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contexthub-archive-')); const file = path.join(dir, 'archive.jsonl');
    const archive = exportNamespace(db, 'personal', file); expect(archive.count).toBe(0); const parsed = readNamespaceArchive(file); expect(parsed.trailer.kind).toBe('trailer');
    fs.appendFileSync(file, 'tamper\n'); expect(() => readNamespaceArchive(file)).toThrow(/checksum|format|JSON/);
    expect(evaluateNeuralGate({ privateRecallDelta: 0.05, overallDelta: -0.01, nasP95Ms: 250 }).passed).toBe(true); expect(evaluateNeuralGate({ privateRecallDelta: 0.01, overallDelta: 0, nasP95Ms: 100 }).status).toBe('failed');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
