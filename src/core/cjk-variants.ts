import * as OpenCC from 'opencc-js/core';
import * as Locale from 'opencc-js/preset';
import fs from 'node:fs';

const toTraditionalTaiwan = OpenCC.ConverterFactory(Locale.from.cn!, Locale.to.twp!);
const toSimplified = OpenCC.ConverterFactory(Locale.from.tw!, Locale.to.cn!);

let aliasCache: Record<string, string[]> | null | undefined;
function aliasesFor(value: string): string[] {
  if (aliasCache === undefined) {
    const file = process.env.CONTEXTHUB_ALIAS_FILE;
    if (!file) aliasCache = null;
    else {
      try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; aliasCache = parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 10)])) : null; } catch { aliasCache = null; }
    }
  }
  return aliasCache?.[value] ?? [];
}

/**
 * Returns bounded query variants only. This is query-time expansion: the
 * authoritative item title/content is never copied or rewritten.
 */
export function cjkQueryVariants(value: string): string[] {
  const variants = new Set<string>();
  const add = (candidate: string) => {
    const normalized = candidate.trim();
    if (normalized) variants.add(normalized);
  };
  add(value);
  try {
    add(toTraditionalTaiwan(value));
    add(toSimplified(value));
    for (const alias of aliasesFor(value)) add(alias);
  } catch {
    // Malformed/unexpected Unicode should not make lexical retrieval fail.
  }
  return [...variants].slice(0, 3);
}

export function expandCjkQueries(values: string[], max = 20): string[] {
  const result = new Set<string>();
  for (const value of values) {
    for (const variant of cjkQueryVariants(value)) {
      result.add(variant);
      if (result.size >= max) return [...result];
    }
  }
  return [...result];
}
