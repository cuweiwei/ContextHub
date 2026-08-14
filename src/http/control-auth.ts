import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { WebPrincipalsRepo } from '../core/web-principals-repo.js';
import type { WebSessionsRepo } from '../core/web-sessions-repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    controlSession: ReturnType<WebSessionsRepo['getValid']>;
  }
}

export const SESSION_COOKIE = '__Host-contexthub_session';

export function normalizeTailscaleLogin(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !/^[a-z0-9][a-z0-9._+@-]*$/.test(normalized)) return null;
  return normalized;
}

export function tailscaleIdentity(req: FastifyRequest, config: Config): {
  provider: 'tailscale'; subject: string; displayName: string; profilePicUrl: string | null;
} | null {
  if (!config.controlCenterEnabled || !config.controlCenterTailscaleAuthEnabled || !config.controlCenterTrustedProxy) return null;
  const proto = req.headers['x-forwarded-proto'];
  if (proto !== 'https') return null;
  if (config.controlCenterCanonicalOrigin) {
    try {
      const expected = new URL(config.controlCenterCanonicalOrigin);
      const host = req.headers.host?.toLowerCase();
      if (expected.protocol !== 'https:' || host !== expected.host.toLowerCase()) return null;
    } catch {
      return null;
    }
  }
  const subject = normalizeTailscaleLogin(req.headers['tailscale-user-login'] as string | undefined);
  if (!subject) return null;
  return {
    provider: 'tailscale',
    subject,
    displayName: (req.headers['tailscale-user-name'] as string | undefined)?.trim().slice(0, 200) || subject,
    profilePicUrl: (req.headers['tailscale-user-profile-pic'] as string | undefined)?.trim().slice(0, 1000) || null,
  };
}

export function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}

export function requireControlSession(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.controlSession) {
    reply.code(401).header('Cache-Control', 'no-store').send({ error: { code: 'control_unauthorized', message: 'Sign in through the private Tailscale HTTPS endpoint' } });
    return false;
  }
  return true;
}

export function sameOrigin(req: FastifyRequest, config: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (config.controlCenterCanonicalOrigin) return origin === config.controlCenterCanonicalOrigin;
  return origin === `https://${req.headers.host}`;
}

export function hasJsonContentType(req: FastifyRequest): boolean {
  return typeof req.headers['content-type'] === 'string' && req.headers['content-type'].split(';')[0] === 'application/json';
}
