import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { GatewayDatabase } from '../src/db.js';
import { ExecutionEvents } from '../src/events.js';
import type { ImageExecutor } from '../src/executor.js';
import type { Planner } from '../src/planner.js';
import { createApp } from '../src/server.js';
import type { RestrictedAgentPlanSnapshot } from '../src/types.js';
import {
  RESTRICTED_EXECUTION_RESPONSE_FIXTURE,
  RESTRICTED_PLAN_RESPONSE_FIXTURE,
  createDeterministicExecutorFixture,
  createDeterministicPlannerFixture,
  normalizeRestrictedExecutionResponse,
  normalizeRestrictedPlanResponse,
} from './fixtures.js';

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];
let png: Buffer;
let jpeg: Buffer;
let webp: Buffer;
let compressedNoisyJpeg: Buffer;

beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000ff' } }).png().toBuffer();
  jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
  webp = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0000ffff' } }).webp().toBuffer();
  compressedNoisyJpeg = await sharp(randomBytes(50 * 50 * 3), { raw: { width: 50, height: 50, channels: 3 } })
    .jpeg({ quality: 1 })
    .toBuffer();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(overrides: Partial<GatewayConfig> = {}): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restricted-agent-'));
  tempDirs.push(dataDir);
  return {
    nodeEnv: 'test', host: '127.0.0.1', port: 3000, publicOrigin: 'http://app.internal',
    sessionSecret: 'test-session-secret-with-at-least-32-characters',
    upstreamBaseUrl: 'http://upstream.invalid/v1', apiKey: 'test-key', plannerModel: 'planner-fixed',
    imageModel: 'image-fixed', dataDir, dbPath: path.join(dataDir, 'gateway.sqlite'),
    assetsDir: path.join(dataDir, 'assets'), planTtlSeconds: 900, assetTtlSeconds: 3600,
    maxReferenceImages: 16, maxFileBytes: 1024 * 1024, maxUploadBytes: 4 * 1024 * 1024,
    maxImagePixels: 1_000_000, maxOutputImages: 4, maxQueue: 10, maxConcurrency: 2,
    planRatePerMinute: 20, executeRatePerMinute: 20, imagesRatePerHour: 100,
    plannerTimeoutMs: 1000, executorTimeoutMs: 1000, logLevel: 'silent', ...overrides,
  };
}

function fakeExecutor(delayMs = 0, outputs: Buffer[] = [png]): ImageExecutor & { execute: ReturnType<typeof vi.fn> } {
  return createDeterministicExecutorFixture(outputs, delayMs);
}

function multipart(fields: Record<string, string>, files: Array<{ field: string; bytes: Buffer; filename?: string }> = []) {
  const boundary = `----agent-test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename ?? 'image.png'}"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(file.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function setup(overrides: { config?: Partial<GatewayConfig>; planner?: Planner; executor?: ImageExecutor } = {}) {
  const config = await makeConfig(overrides.config);
  const executor = overrides.executor ?? fakeExecutor();
  const app = await createApp({ config, planner: overrides.planner ?? createDeterministicPlannerFixture(), executor });
  apps.push(app);
  const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { host: 'app.internal' } });
  const cookie = capabilities.headers['set-cookie']!.split(';')[0]!;
  const csrf = capabilities.json().data.csrfToken as string;
  const mutationHeaders = { host: 'app.internal', origin: 'http://app.internal', cookie, 'x-csrf-token': csrf };
  return { app, config, executor, cookie, csrf, mutationHeaders };
}

async function createPlan(context: Awaited<ReturnType<typeof setup>>, fields: Record<string, string> = { request: '生成一张红色图片' }) {
  const form = multipart(fields);
  return context.app.inject({
    method: 'POST', url: '/v1/plans', payload: form.payload,
    headers: { ...context.mutationHeaders, 'content-type': form.contentType },
  });
}

async function waitForTerminal(app: FastifyInstance, id: string, cookie: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/executions/${id}`, headers: { host: 'app.internal', cookie } });
    const execution = response.json().data;
    if (['completed', 'failed', 'cancelled', 'failed_unknown'].includes(execution.status)) return execution;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('execution did not finish');
}

describe('response fixture normalization', () => {
  it('只归一化服务端 toISOString 时间格式', () => {
    const normalized = normalizeRestrictedPlanResponse({ expiresAt: '2026-08-10T00:00:00.000Z' }) as Record<string, unknown>;
    expect(normalized.expiresAt).toBe('<expires-at>');
  });

  it.each([
    '2026-08-10',
    '08/10/2026',
    '0',
    'not-a-date',
    0,
    null,
  ])('不隐藏非服务端 ISO 时间值：%j', (expiresAt) => {
    const normalized = normalizeRestrictedPlanResponse({ expiresAt }) as Record<string, unknown>;
    expect(normalized.expiresAt).toBe(expiresAt);
  });
});

describe('fail-closed config', () => {
  it('缺少秘密或固定上游配置时拒绝启动', () => {
    expect(() => loadConfig({})).toThrow(/配置无效或缺失/);
  });

  it('拒绝可能泄露 Authorization 的上游 URL 结构', () => {
    const base = {
      AGENT_PUBLIC_ORIGIN: 'https://app.internal',
      AGENT_SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
      AGENT_API_KEY: 'test-key',
      AGENT_PLANNER_MODEL: 'planner-fixed',
      AGENT_IMAGE_MODEL: 'image-fixed',
    };

    for (const upstream of [
      'https://user:password@api.example.com/v1',
      'https://api.example.com/v1?target=other',
      'https://api.example.com/v1#fragment',
    ]) {
      expect(() => loadConfig({ ...base, AGENT_UPSTREAM_BASE_URL: upstream })).toThrow(/不得包含凭据、查询或片段/);
    }
  });
});

describe('two phase gateway', () => {
  it('只注册 Nginx 去前缀后的 /v1 内部路由', async () => {
    const context = await setup();
    const response = await context.app.inject({ method: 'GET', url: '/agent-api/v1/capabilities', headers: { host: 'app.internal' } });
    expect(response.statusCode).toBe(404);
  });

  it('创建计划不执行图片调用，且响应不暴露模型和上游', async () => {
    const context = await setup();
    const response = await createPlan(context);
    expect(response.statusCode).toBe(201);
    const text = response.body;
    expect(context.executor.execute).not.toHaveBeenCalled();
    expect(text).not.toContain('planner-fixed');
    expect(text).not.toContain('image-fixed');
    expect(text).not.toContain('upstream.invalid');
    expect(normalizeRestrictedPlanResponse(response.json().data)).toEqual(RESTRICTED_PLAN_RESPONSE_FIXTURE);
  });

  it('拒绝 model、tools、upstream 等未知客户端字段', async () => {
    const context = await setup();
    for (const field of ['model', 'tools', 'upstream']) {
      const response = await createPlan(context, { request: '测试', [field]: 'attacker-controlled' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('unknown_field');
    }
    expect(context.executor.execute).not.toHaveBeenCalled();
  });

  it('必须同源且 CSRF token 正确', async () => {
    const context = await setup();
    const form = multipart({ request: '测试' });
    const badOrigin = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, origin: 'http://evil.internal', 'content-type': form.contentType },
    });
    expect(badOrigin.statusCode).toBe(403);
    const badCsrf = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'x-csrf-token': 'bad', 'content-type': form.contentType },
    });
    expect(badCsrf.statusCode).toBe(403);
  });

  it('上传图片按真实内容校验并绑定哈希', async () => {
    const planner = createDeterministicPlannerFixture('edit');
    const context = await setup({ planner });
    const form = multipart({ request: '把图片改成蓝色' }, [{ field: 'reference', bytes: png }]);
    const response = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'content-type': form.contentType },
    });
    expect(response.statusCode).toBe(201);
    const input = response.json().data.inputs[0];
    expect(input.role).toBe('reference');
    expect(input.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.mimeType).toBe('image/png');
  });

  it('拒绝规范化后膨胀超过单文件限制的压缩图片并清理产物', async () => {
    const context = await setup({ config: { maxFileBytes: 1_000, maxUploadBytes: 5_000 }, planner: createDeterministicPlannerFixture('edit') });
    expect(compressedNoisyJpeg.byteLength).toBeLessThan(1_000);
    const form = multipart({ request: '编辑图片' }, [{ field: 'reference', bytes: compressedNoisyJpeg, filename: 'compressed.jpg' }]);
    const response = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'content-type': form.contentType },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('normalized_file_too_large');
    expect(await readdir(context.config.assetsDir)).toEqual([]);
  });

  it('累计上传同时按规范化后大小计量', async () => {
    const context = await setup({ config: { maxFileBytes: 5_000, maxUploadBytes: 6_000 }, planner: createDeterministicPlannerFixture('edit') });
    const form = multipart({ request: '合并参考图片' }, [
      { field: 'reference', bytes: compressedNoisyJpeg, filename: 'a.jpg' },
      { field: 'reference', bytes: compressedNoisyJpeg, filename: 'b.jpg' },
      { field: 'reference', bytes: compressedNoisyJpeg, filename: 'c.jpg' },
      { field: 'reference', bytes: compressedNoisyJpeg, filename: 'd.jpg' },
    ]);
    const response = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'content-type': form.contentType },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('upload_too_large');
    expect(await readdir(context.config.assetsDir)).toEqual([]);
  });

  it('同一计划并发确认只执行一次，重复请求返回同一 execution', async () => {
    const executor = fakeExecutor(20);
    const context = await setup({ executor });
    const planResponse = await createPlan(context);
    const plan = planResponse.json().data;
    const request = () => context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    const [first, second] = await Promise.all([request(), request()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 202]);
    expect(first.json().data.id).toBe(second.json().data.id);
    const completed = await waitForTerminal(context.app, first.json().data.id, context.cookie);
    expect(normalizeRestrictedExecutionResponse(completed, plan.id)).toEqual(RESTRICTED_EXECUTION_RESPONSE_FIXTURE);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { source: () => jpeg, outputFormat: 'png', outputCompression: undefined, mimeType: 'image/png', format: 'png', extension: '.png' },
    { source: () => webp, outputFormat: 'jpeg', outputCompression: '80', mimeType: 'image/jpeg', format: 'jpeg', extension: '.jpg' },
    { source: () => png, outputFormat: 'webp', outputCompression: '80', mimeType: 'image/webp', format: 'webp', extension: '.webp' },
  ] as const)('规范化上游图片并以 $outputFormat 返回', async ({ source, outputFormat, outputCompression, mimeType, format, extension }) => {
    const context = await setup({ executor: fakeExecutor(0, [source()]) });
    const fields = {
      request: '生成一张测试图片',
      outputFormat,
      ...(outputCompression ? { outputCompression } : {}),
    };
    const plan = (await createPlan(context, fields)).json().data;
    const started = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    const completed = await waitForTerminal(context.app, started.json().data.id, context.cookie);
    const asset = completed.outputAssets[0];
    const response = await context.app.inject({
      method: 'GET', url: `/v1/assets/${asset.id}`,
      headers: { host: 'app.internal', cookie: context.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(mimeType);
    expect(response.rawPayload.byteLength).toBe(asset.byteSize);
    await expect(sharp(response.rawPayload).metadata()).resolves.toMatchObject({ format, width: 2, height: 2 });
    const files = await readdir(context.config.assetsDir);
    expect(files).toHaveLength(1);
    expect(path.extname(files[0]!)).toBe(extension);
  });

  it('确认接口拒绝 body、过期版本和跨会话读取', async () => {
    const context = await setup();
    const plan = (await createPlan(context)).json().data;
    const bodyResponse = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`, payload: { prompt: 'tampered' },
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'content-type': 'application/json' },
    });
    expect(bodyResponse.statusCode).toBe(400);
    const versionResponse = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"2"' },
    });
    expect(versionResponse.statusCode).toBe(412);
    const otherCapabilities = await context.app.inject({ method: 'GET', url: '/v1/capabilities', headers: { host: 'app.internal' } });
    const otherCookie = otherCapabilities.headers['set-cookie']!.split(';')[0]!;
    const crossSession = await context.app.inject({
      method: 'GET', url: `/v1/plans/${plan.id}`, headers: { host: 'app.internal', cookie: otherCookie },
    });
    expect(crossSession.statusCode).toBe(404);
  });

  it('版本失败不消耗确认和图片速率额度', async () => {
    const context = await setup({ config: { executeRatePerMinute: 1, imagesRatePerHour: 1 } });
    const plan = (await createPlan(context)).json().data;
    const failed = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"2"' },
    });
    expect(failed.statusCode).toBe(412);
    const accepted = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    expect(accepted.statusCode).toBe(202);
    await waitForTerminal(context.app, accepted.json().data.id, context.cookie);
  });

  it('过期计划不可执行', async () => {
    const context = await setup({ config: { planTtlSeconds: 60 } });
    const plan = (await createPlan(context)).json().data;
    context.app;
    const db = new GatewayDatabase(context.config);
    db.raw.prepare('UPDATE plans SET expires_at = ? WHERE id = ?').run(Date.now() - 1, plan.id);
    db.close();
    const response = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    expect([409, 410]).toContain(response.statusCode);
    expect(context.executor.execute).not.toHaveBeenCalled();
  });

  it('执行中取消不会自动重试', async () => {
    const executor = fakeExecutor(500);
    const context = await setup({ executor });
    const plan = (await createPlan(context)).json().data;
    const started = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    const id = started.json().data.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await context.app.inject({
      method: 'POST', url: `/v1/executions/${id}/cancel`, headers: context.mutationHeaders,
    });
    expect(['executing', 'cancelled']).toContain(cancelled.json().data.status);
    const terminal = await waitForTerminal(context.app, id, context.cookie);
    expect(terminal.status).toBe('cancelled');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});

describe('SSE event contract', () => {
  it('executing 状态映射为 execution.started', () => {
    const events = new ExecutionEvents();
    const listener = vi.fn();
    const unsubscribe = events.subscribe('execution', listener);
    events.emitState({
      id: 'execution', planId: 'plan', status: 'executing', cancelRequested: false, error: null,
      outputAssets: [], createdAt: new Date(0).toISOString(), startedAt: new Date(1).toISOString(),
      completedAt: null, updatedAt: new Date(1).toISOString(),
    });
    expect(listener).toHaveBeenCalledWith('execution.started', expect.objectContaining({ status: 'executing' }));
    unsubscribe();
  });
});

describe('restart recovery', () => {
  it('executing 在重启时变为 failed_unknown，queued 不会被重复创建', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const now = Date.now();
    const plan: RestrictedAgentPlanSnapshot = {
      id: 'plan-recovery', version: 1, status: 'awaiting_confirmation',
      expiresAt: new Date(now + 60_000).toISOString(), originalRequest: '恢复测试', summary: '测试',
      steps: [{ title: '生成', operation: 'generate' }],
      generation: { exactPrompt: '测试', action: 'generate', size: '1024x1024', quality: 'medium', outputFormat: 'png', outputCompression: null, imageCount: 1 },
      inputs: [], assumptions: [], warnings: [], policyVersion: 'restricted-image-v1',
    };
    db.insertPlan(plan, 'session', [], now);
    const execution = db.createExecution(plan.id, 'session', 1, now).execution;
    db.claimNextExecution(now + 1);
    db.close();
    const reopened = new GatewayDatabase(config);
    expect(reopened.recoverInterruptedExecutions(now + 2)).toBe(1);
    expect(reopened.getExecution(execution.id, 'session').status).toBe('failed_unknown');
    expect(reopened.recoverInterruptedExecutions(now + 3)).toBe(0);
    reopened.close();
  });
});
