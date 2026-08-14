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
});
