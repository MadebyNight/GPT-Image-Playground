import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../src/config.js';
import { getOrCreateSession } from '../src/security.js';

describe('Gateway session renewal', () => {
  it('renews the cookie without changing the session ID on an authenticated request', () => {
    const config = {
      publicOrigin: 'https://app.internal',
      sessionSecret: 'test-session-secret-with-at-least-32-characters',
    } as GatewayConfig;
    const header = vi.fn();
    const reply = { header } as unknown as FastifyReply;
    const first = getOrCreateSession({ headers: {} } as FastifyRequest, reply, config);
    const cookie = String(header.mock.calls[0]?.[1]).split(';')[0];

    header.mockClear();
    const renewed = getOrCreateSession({ headers: { cookie } } as FastifyRequest, reply, config);

    expect(renewed).toMatchObject({ id: first.id, isNew: false });
    expect(header).toHaveBeenCalledWith('set-cookie', expect.stringContaining(`${cookie}; Path=/;`));
    expect(header.mock.calls[0]?.[1]).toContain('Max-Age=86400');
  });
});
