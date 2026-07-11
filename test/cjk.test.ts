import { describe, expect, it } from 'vitest';
import { buildFtsQuery, makeSnippet, segmentCjk } from '../src/core/cjk.js';

describe('segmentCjk', () => {
  it('injects spaces between CJK characters', () => {
    expect(segmentCjk('財務規劃')).toBe('財 務 規 劃');
  });

  it('keeps latin words intact and handles mixed text', () => {
    expect(segmentCjk('財務app預算')).toBe('財 務 app 預 算');
    expect(segmentCjk('hello world')).toBe('hello world');
  });

  it('collapses redundant whitespace', () => {
    expect(segmentCjk('  財務   規劃  ')).toBe('財 務 規 劃');
  });
});

describe('buildFtsQuery', () => {
  it('builds phrase queries for CJK tokens', () => {
    expect(buildFtsQuery('財務')).toBe('"財 務"');
  });

  it('ANDs multiple tokens', () => {
    expect(buildFtsQuery('財務 budget')).toBe('"財 務" AND "budget"');
  });

  it('strips embedded quotes (no FTS syntax injection)', () => {
    expect(buildFtsQuery('a"b')).toBe('"a b"');
  });

  it('returns null for empty input', () => {
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('"')).toBeNull();
  });
});

describe('makeSnippet', () => {
  it('returns short content unchanged', () => {
    expect(makeSnippet('短內容', ['財務'])).toBe('短內容');
  });

  it('windows around the first hit', () => {
    const content = 'x'.repeat(300) + '財務規劃重點在這裡' + 'y'.repeat(300);
    const snippet = makeSnippet(content, ['財務']);
    expect(snippet).toContain('財務規劃');
    expect(snippet.length).toBeLessThan(200);
  });

  it('falls back to head of content when no token hits', () => {
    const content = 'a'.repeat(500);
    const snippet = makeSnippet(content, ['missing']);
    expect(snippet.startsWith('aaa')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
});
