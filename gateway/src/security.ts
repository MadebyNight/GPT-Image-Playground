import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';

const COOKIE_NAME = 'agent_sid';

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function sign(value: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(value).digest());
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const item of (header ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    values[name] = value;
  }
  return values;
}

export interface SessionContext {
  id: string;
  csrfToken: string;
  isNew: boolean;
}

export function getOrCreateSession(
  request: FastifyRequest,
  reply: FastifyReply,
  config: GatewayConfig,
): SessionContext {
  const rawCookie = parseCookies(request.headers.cookie)[COOKIE_NAME];
  let sessionId: string | undefined;

  if (rawCookie) {
    const [candidate, signature, extra] = rawCookie.split('.');
    if (!extra && candidate && signature && constantEqual(signature, sign(candidate, config.sessionSecret))) {
      sessionId = candidate;
    }
  }

  const isNew = !sessionId;
  sessionId ??= base64url(randomBytes(24));
  // Keep an active session alive so an in-flight execution does not become
  // inaccessible when the original cookie reaches its absolute expiry.
  const secure = new URL(config.publicOrigin).protocol === 'https:';
  reply.header(
    'set-cookie',
    `${COOKIE_NAME}=${sessionId}.${sign(sessionId, config.sessionSecret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`,
  );

  return {
    id: sessionId,
    csrfToken: sign(`csrf:${sessionId}`, config.sessionSecret),
    isNew,
  };
}

export function requireSameOrigin(request: FastifyRequest, config: GatewayConfig): void {
  const expected = new URL(config.publicOrigin);
  const origin = request.headers.origin;
  if (origin !== expected.origin) {
    throw new AppError(403, 'origin_rejected', '请求 Origin 不受信任');
  }

  const forwardedHost = request.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
  if (!host || host.toLowerCase() !== expected.host.toLowerCase()) {
    throw new AppError(403, 'host_rejected', '请求 Host 不受信任');
  }

  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  if (proto && `${proto}:` !== expected.protocol) {
    throw new AppError(403, 'protocol_rejected', '请求协议不受信任');
  }
}

export function requireCsrf(request: FastifyRequest, session: SessionContext): void {
  const header = request.headers['x-csrf-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || !constantEqual(token, session.csrfToken)) {
    throw new AppError(403, 'csrf_rejected', 'CSRF token 无效');
  }
}

interface RateBucket {
  entries: Array<{ timestamp: number; token: symbol }>;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  consume(key: string, limit: number, windowMs: number, amount = 1, now = Date.now()): () => void {
    const bucket = this.buckets.get(key) ?? { entries: [] };
    const cutoff = now - windowMs;
    bucket.entries = bucket.entries.filter((entry) => entry.timestamp > cutoff);
    if (bucket.entries.length + amount > limit) {
      throw new AppError(429, 'rate_limit_exceeded', '请求过于频繁，请稍后再试');
    }
    const token = Symbol(key);
    for (let index = 0; index < amount; index += 1) bucket.entries.push({ timestamp: now, token });
    this.buckets.set(key, bucket);
    return () => {
      const current = this.buckets.get(key);
      if (!current) return;
      current.entries = current.entries.filter((entry) => entry.token !== token);
      if (current.entries.length === 0) this.buckets.delete(key);
    };
  }

  clear(): void {
    this.buckets.clear();
  }
}
