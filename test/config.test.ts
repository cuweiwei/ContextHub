import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration URL options', () => {
  it('treats blank deployment environment values as unset', () => {
    const config = loadConfig({
      DATA_DIR: '/tmp/contexthub-config-test',
      CONTROL_CENTER_CANONICAL_ORIGIN: '',
      OAUTH_ISSUER: '   ',
      OAUTH_AUDIENCE_BASE: '',
      OAUTH_JWKS_URI: '',
    });

    expect(config.controlCenterCanonicalOrigin).toBeUndefined();
    expect(config.oauthIssuer).toBeUndefined();
    expect(config.oauthAudienceBase).toBeUndefined();
    expect(config.oauthJwksUri).toBeUndefined();
  });

  it('still rejects non-URL values', () => {
    expect(() => loadConfig({ CONTROL_CENTER_CANONICAL_ORIGIN: 'not-a-url' })).toThrow();
  });

  it('parses bounded SQLite cache and opt-in retrieval controls', () => {
    const config = loadConfig({
      DATA_DIR: '/tmp/contexthub-config-test',
      SQLITE_CACHE_KIB: '32768',
      CONTEXTHUB_ENABLE_QUERY_PROFILES: 'true',
      CONTEXTHUB_STATEMENT_CACHE_ENABLED: 'true',
      CONTEXTHUB_QUERY_TRANSFORM_CACHE_ENABLED: 'true',
      CONTEXTHUB_ID_FIRST_RETRIEVAL_ENABLED: 'true',
      CONTEXTHUB_MAINTENANCE_MODE: 'false',
    });
    expect(config.sqliteCacheKiB).toBe(32768);
    expect(config.enableQueryProfiles).toBe(true);
    expect(config.statementCacheEnabled).toBe(true);
    expect(config.queryTransformCacheEnabled).toBe(true);
    expect(config.idFirstRetrievalEnabled).toBe(true);
    expect(config.maintenanceMode).toBe(false);
  });
});
