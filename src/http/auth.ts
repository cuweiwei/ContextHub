import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientsRepo } from '../core/clients-repo.js';
import type { ClientAuth, Scope } from '../core/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    client: ClientAuth | null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

/**
 * The admin token is a break-glass/administration credential, NOT a
 * namespace principal: its `namespace` is the empty string and it is never
 * subject to namespace policies (repos branch on isAdmin explicitly). Daily
 * review work should use namespace-scoped human reviewer clients instead.
 */
export const ADMIN_CLIENT: ClientAuth = {
  id: 'admin',
  name: 'Admin token',
  principalKind: 'human',
  namespace: '',
  scopes: ['read', 'write', 'review_insight', 'admin'],
  maxSensitivity: 'private',
  readSources: null,
  credentialVersion: 0,
  isAdmin: true,
};

export function resolveClient(
  req: FastifyRequest,
  clientsRepo: ClientsRepo,
  adminToken: string | undefined,
  legacyApiKeysEnabled = true,
): ClientAuth | null {
  const token = extractBearer(req);
  if (!token) return null;
  if (adminToken && safeEqual(token, adminToken)) return ADMIN_CLIENT;
  if (!legacyApiKeysEnabled) return null;
  return clientsRepo.verifyKey(token);
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.client) {
      reply.code(401).send({
        error: { code: 'unauthorized', message: 'Provide a valid Authorization: Bearer <api key> header' },
      });
      return;
    }
    if (!req.client.scopes.includes(scope)) {
      reply.code(403).send({
        error: { code: 'forbidden', message: `This operation requires the "${scope}" scope` },
      });
    }
  };
}
