import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AppDeps } from '../http/server.js';
import { extractBearer } from '../http/auth.js';
import type { ClientAuth } from '../core/types.js';

function scopeSet(payload: JWTPayload): Set<string> {
  const raw = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : Array.isArray(payload.scp) ? payload.scp.filter((value): value is string => typeof value === 'string') : [];
  return new Set(raw);
}

export async function resolveOAuthClient(req: any, deps: AppDeps, resource: string): Promise<{ client: ClientAuth; scopes: Set<string> } | null> {
  if (!deps.config.mcpOauthEnabled || !deps.config.oauthIssuer || !deps.config.oauthJwksUri || !deps.config.oauthAudienceBase) return null;
  const token = extractBearer(req);
  if (!token) return null;
  try {
    const jwks = createRemoteJWKSet(new URL(deps.config.oauthJwksUri));
    const { payload } = await jwtVerify(token, jwks, { issuer: deps.config.oauthIssuer, audience: resource, algorithms: ['RS256', 'ES256'] });
    if (!payload.sub || typeof payload.iss !== 'string') return null;
    const binding = deps.db.prepare('SELECT client_id FROM oauth_bindings WHERE issuer = ? AND subject = ?').get(payload.iss, payload.sub) as { client_id: string } | undefined;
    if (!binding) return null;
    const client = deps.clientsRepo.authForId(binding.client_id);
    if (!client) return null;
    const scopes = scopeSet(payload);
    // OAuth may only narrow the existing namespace credential scope.
    if (scopes.has('contexthub.read') && !client.scopes.includes('read')) return null;
    if (scopes.has('contexthub.write') && !client.scopes.includes('write')) return null;
    return { client, scopes };
  } catch { return null; }
}

export function resourceMetadata(deps: AppDeps, resource: string) {
  return { resource, authorization_servers: deps.config.oauthIssuer ? [deps.config.oauthIssuer] : [], scopes_supported: ['contexthub.read', 'contexthub.write'] };
}
