import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type GatewayConfig } from '../src/config.js';
import { AssetStore } from '../src/assets.js';
import { GatewayDatabase } from '../src/db.js';
import { ExecutionEvents } from '../src/events.js';
import type { ImageExecutor } from '../src/executor.js';
import { decodeRestrictedAgentPlanSnapshot, getPlanOperation } from '../src/plan.js';
import {
  hashComposerSnapshot,
  plannerJsonSchema,
  toolAgentPlannerJsonSchema,
  validateAndConstrainToolAgentDraft,
} from '../src/policy.js';
import { ResponsesPlanner, type Planner } from '../src/planner.js';
import { createApp } from '../src/server.js';
import { ExecutionWorker } from '../src/worker.js';
import type {
  PlanInputView,
  RestrictedAgentPlanSnapshot,
  StoredAsset,
  ToolAgentPlanV3Snapshot,
} from '../src/types.js';
import type { WebSearchService } from '../src/webSearch.js';
import {
  RESTRICTED_EXECUTION_RESPONSE_FIXTURE,
  RESTRICTED_PLAN_RESPONSE_FIXTURE,
  TOOL_AGENT_V3_PLAN_FIXTURE,
  createDeterministicExecutorFixture,
  createDeterministicPlannerFixture,
  normalizeRestrictedExecutionResponse,
  normalizeRestrictedPlanResponse,
} from './fixtures.js';

interface ContractFixture {
  canonicalComposer: { manifest: Record<string, unknown>; expectedHash: string };
  validPlans: { tool: Record<string, unknown>; legacy: Record<string, unknown> };
  invalidPlanMutations: Array<{
    name: string;
    base: 'tool' | 'legacy';
    path: Array<string | number>;
    value: unknown;
  }>;
}

const contractFixture = JSON.parse(readFileSync(
  new URL('../../test-fixtures/restricted-agent-contract.json', import.meta.url),
  'utf8',
)) as ContractFixture;

function applyInvalidPlanMutation(mutation: ContractFixture['invalidPlanMutations'][number]) {
  const plan = structuredClone(contractFixture.validPlans[mutation.base]);
  let target: Record<string | number, unknown> = plan;
  for (const key of mutation.path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  target[mutation.path.at(-1)!] = structuredClone(mutation.value);
  return plan;
}

function findStrictObjectSchemaIssues(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findStrictObjectSchemaIssues(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  const schema = value as Record<string, unknown>;
  const issues: string[] = [];
  if (schema.type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? Object.keys(schema.properties)
      : null;
    const required = Array.isArray(schema.required) && schema.required.every((item) => typeof item === 'string')
      ? schema.required as string[]
      : null;
    if (!properties) issues.push(`${path}: properties 缺失`);
    if (!required) issues.push(`${path}: required 缺失`);
    if (schema.additionalProperties !== false) issues.push(`${path}: additionalProperties 必须为 false`);
    if (properties && required) {
      const missing = properties.filter((key) => !required.includes(key));
      const extra = required.filter((key) => !properties.includes(key));
      if (missing.length) issues.push(`${path}: required 缺少 ${missing.join(', ')}`);
      if (extra.length) issues.push(`${path}: required 多出 ${extra.join(', ')}`);
    }
  }
  return issues.concat(Object.entries(schema).flatMap(([key, item]) => (
    findStrictObjectSchemaIssues(item, `${path}.${key}`)
  )));
}

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
  vi.restoreAllMocks();
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
    plannerTimeoutMs: 1000, executorTimeoutMs: 1000,
    webSearchEnabled: false, webSearchBaseUrl: null, webSearchTimeoutMs: 1000, webSearchMaxResults: 5, webSearchRatePerMinute: 20,
    logLevel: 'silent', ...overrides,
  };
}

function fakeExecutor(delayMs = 0, outputs: Buffer[] = [png]): ImageExecutor & { executeGeneration: ReturnType<typeof vi.fn> } {
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

function composerSnapshot(options: {
  request?: string;
  inputs?: Array<{
    browserImageId: string;
    bytes: Buffer;
    role?: 'reference' | 'mask_target';
    ordinal?: number;
  }>;
  mask?: { bytes: Buffer; targetBrowserImageId: string };
  params?: Partial<{
    size: string;
    quality: 'auto' | 'low' | 'medium' | 'high';
    outputFormat: 'png' | 'jpeg' | 'webp';
    outputCompression: number | null;
    moderation: 'auto' | 'low';
    imageCount: number;
  }>;
  overrides?: Record<string, unknown>;
} = {}) {
  const inputs = options.inputs ?? [];
  return JSON.stringify({
    schemaVersion: 2,
    scope: 'tool',
    prompt: options.request ?? '生成一张红色图片',
    inputs: inputs.map((input, index) => ({
      browserImageId: input.browserImageId,
      contentSha256: createHash('sha256').update(input.bytes).digest('hex'),
      role: input.role ?? 'reference',
      ordinal: input.ordinal ?? index,
    })),
    mask: options.mask
      ? {
          targetBrowserImageId: options.mask.targetBrowserImageId,
          contentSha256: createHash('sha256').update(options.mask.bytes).digest('hex'),
        }
      : null,
    params: {
      size: '1024x1024',
      quality: 'medium',
      outputFormat: 'png',
      outputCompression: null,
      moderation: 'auto',
      imageCount: 1,
      ...options.params,
    },
    temporaryProfile: { id: null, name: null, missing: false },
    ...options.overrides,
  });
}

async function setup(overrides: { config?: Partial<GatewayConfig>; planner?: Planner; executor?: ImageExecutor; webSearch?: WebSearchService } = {}) {
  const config = await makeConfig(overrides.config);
  const executor = overrides.executor ?? fakeExecutor();
  const app = await createApp({ config, planner: overrides.planner ?? createDeterministicPlannerFixture(), executor, webSearch: overrides.webSearch });
  apps.push(app);
  const capabilities = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: { host: 'app.internal' } });
  const cookie = capabilities.headers['set-cookie']!.split(';')[0]!;
  const csrf = capabilities.json().data.csrfToken as string;
  const mutationHeaders = { host: 'app.internal', origin: 'http://app.internal', cookie, 'x-csrf-token': csrf };
  return { app, config, executor, cookie, csrf, mutationHeaders };
}

async function createPlan(context: Awaited<ReturnType<typeof setup>>, fields: Record<string, string> = { request: '生成一张红色图片' }) {
  const request = fields.request ?? '生成一张红色图片';
  const form = multipart({
    size: '1024x1024',
    quality: 'medium',
    outputFormat: 'png',
    imageCount: '1',
    ...fields,
    composerSnapshot: fields.composerSnapshot ?? composerSnapshot({
      request,
      params: {
        size: fields.size ?? '1024x1024',
        quality: (fields.quality as 'auto' | 'low' | 'medium' | 'high' | undefined) ?? 'medium',
        outputFormat: (fields.outputFormat as 'png' | 'jpeg' | 'webp' | undefined) ?? 'png',
        outputCompression: fields.outputFormat === 'png' || !fields.outputFormat
          ? null
          : fields.outputCompression ? Number(fields.outputCompression) : 90,
        imageCount: fields.imageCount ? Number(fields.imageCount) : 1,
      },
    }),
  });
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

describe('v3 Gateway action contract', () => {
  type MutablePlan = {
    actions: Array<Record<string, unknown>>;
    finalOutputSpec: Record<string, unknown>;
    [key: string]: unknown;
  };

  const cloneV3Plan = (): MutablePlan => JSON.parse(JSON.stringify(TOOL_AGENT_V3_PLAN_FIXTURE)) as MutablePlan;
  const expectInvalidPlan = (plan: unknown) => {
    expect(() => decodeRestrictedAgentPlanSnapshot(plan))
      .toThrowError(expect.objectContaining({ code: 'invalid_plan_snapshot' }));
  };

  it('解码合法 v3 action 链，同时保持 v1/v2 快照兼容', () => {
    const v3 = decodeRestrictedAgentPlanSnapshot(cloneV3Plan());
    expect(v3).toMatchObject({
      schemaVersion: 3,
      actions: [{ type: 'image.generate' }, { type: 'image.transform' }, { type: 'metadata.assert' }],
    });
    expect(() => getPlanOperation(v3)).toThrowError(expect.objectContaining({ code: 'v3_actions_require_auto_execution' }));
    expect(decodeRestrictedAgentPlanSnapshot(structuredClone(contractFixture.validPlans.tool))).toMatchObject({ schemaVersion: 2 });
    expect(decodeRestrictedAgentPlanSnapshot(structuredClone(contractFixture.validPlans.legacy))).not.toHaveProperty('schemaVersion');
  });

  it('拒绝超过三步、错误顺序、前向引用、生成后多图与不成对尺寸', () => {
    const tooManyActions = cloneV3Plan();
    tooManyActions.actions.push(structuredClone(tooManyActions.actions[2]!));
    expectInvalidPlan(tooManyActions);

    const wrongOrder = cloneV3Plan();
    [wrongOrder.actions[1], wrongOrder.actions[2]] = [wrongOrder.actions[2]!, wrongOrder.actions[1]!];
    expectInvalidPlan(wrongOrder);

    const forwardReference = cloneV3Plan();
    ((forwardReference.actions[1]!.input as Record<string, unknown>).actionIndex) = 1;
    expectInvalidPlan(forwardReference);

    const multipleGeneratedImages = cloneV3Plan();
    (((multipleGeneratedImages.actions[0]!.generation as Record<string, unknown>).imageCount)) = 2;
    expectInvalidPlan(multipleGeneratedImages);

    const missingHeight = cloneV3Plan();
    delete missingHeight.finalOutputSpec.height;
    delete (missingHeight.actions[1]!.transform as Record<string, unknown>).height;
    delete (missingHeight.actions[2]!.expected as Record<string, unknown>).height;
    expectInvalidPlan(missingHeight);
  });

  it('对透明 JPEG 与 Planner asset UUID fail closed', () => {
    const transparentJpeg = cloneV3Plan();
    transparentJpeg.finalOutputSpec.outputFormat = 'jpeg';
    transparentJpeg.finalOutputSpec.transparent = true;
    (transparentJpeg.actions[1]!.transform as Record<string, unknown>).outputFormat = 'jpeg';
    (transparentJpeg.actions[2]!.expected as Record<string, unknown>).outputFormat = 'jpeg';
    (transparentJpeg.actions[2]!.expected as Record<string, unknown>).transparent = true;
    expectInvalidPlan(transparentJpeg);

    expect(JSON.stringify(toolAgentPlannerJsonSchema)).not.toContain('assetId');
    expect(findStrictObjectSchemaIssues(toolAgentPlannerJsonSchema)).toEqual([]);
  });

  it('v3 Planner 使用 action 链 schema，并要求 transform 与 assert 参数', async () => {
    const config = await makeConfig();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: '严格尺寸生成',
        actions: [
          {
            type: 'image.generate',
            generation: {
              exactPrompt: '生成横幅', action: 'generate', size: '1536x1024', quality: 'medium',
              outputFormat: 'png', outputCompression: null, imageCount: 1,
            },
          },
          {
            type: 'image.transform', input: { kind: 'action_output', actionIndex: 0 },
            transform: {
              width: 870, height: 220, fit: 'cover', position: 'center', crop: null, rotate: null, flip: null,
              background: null, outputFormat: 'png', outputCompression: null,
            },
          },
          {
            type: 'metadata.assert', input: { kind: 'action_output', actionIndex: 1 },
            expected: {
              width: 870, height: 220, fit: 'cover', position: 'center', crop: null, rotate: null, flip: null,
              outputFormat: 'png', transparent: null, background: null, outputCompression: null,
            },
          },
        ],
        assumptions: [], warnings: [],
      }),
    }), { status: 200 }));
    const finalOutputSpec = { width: 870, height: 220, fit: 'cover' as const, position: 'center' as const };
    await new ResponsesPlanner(config).createDraft({
      request: '生成横幅', preferences: {}, assets: [], allowOpenShop: true,
      outputSchemaVersion: 3, finalOutputSpec,
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.text.format).toMatchObject({
      name: 'tool_agent_action_chain_plan', strict: true, schema: toolAgentPlannerJsonSchema,
    });
    expect(requestBody.input[0].content[0].text).toContain('不得输出 assetId');
    expect(requestBody.input[0].content[0].text).toContain('"width":870');
  });

  it('约束纯 transform 为 transform → assert，并规范化 JPEG contain 白底', async () => {
    const config = await makeConfig();
    const inputAsset: PlanInputView = {
      assetId: '55555555-5555-4555-8555-555555555555',
      role: 'reference',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      width: 1600,
      height: 900,
    };
    const finalOutputSpec = {
      width: 870,
      height: 220,
      fit: 'contain',
      position: 'center',
      outputFormat: 'jpeg',
    };
    const draft = {
      summary: '缩放已有图片',
      actions: [
        {
          type: 'image.transform',
          input: { kind: 'plan_input', inputIndex: 0 },
          transform: {
            width: 870, height: 220, fit: 'contain', position: 'center', crop: null, rotate: null, flip: null,
            background: '#ffffff', outputFormat: 'jpeg', outputCompression: 90,
          },
        },
        {
          type: 'metadata.assert',
          input: { kind: 'action_output', actionIndex: 0 },
          expected: {
            width: 870, height: 220, fit: 'contain', position: 'center', crop: null, rotate: null, flip: null,
            outputFormat: 'jpeg', transparent: null, background: '#ffffff', outputCompression: 90,
          },
        },
      ],
      assumptions: [],
      warnings: [],
    };
    const constrained = validateAndConstrainToolAgentDraft(draft, {}, [inputAsset], config, finalOutputSpec);
    expect(constrained.actions.map((action) => action.type)).toEqual(['image.transform', 'metadata.assert']);
    expect(constrained.finalOutputSpec).toMatchObject({ outputFormat: 'jpeg', background: '#ffffff', outputCompression: 90 });
    expect(constrained.assumptions).toContain('JPEG contain 输出未指定背景，已使用白色背景。');

    const transparentJpeg = {
      ...finalOutputSpec,
      transparent: true,
    };
    expect(() => validateAndConstrainToolAgentDraft(draft, {}, [inputAsset], config, transparentJpeg))
      .toThrowError(expect.objectContaining({ code: 'transparent_jpeg_conflict' }));
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
    expect(context.executor.executeGeneration).not.toHaveBeenCalled();
    expect(text).not.toContain('planner-fixed');
    expect(text).not.toContain('image-fixed');
    expect(text).not.toContain('upstream.invalid');
    expect(response.json().data.composerSnapshotHash).toBe('a7230805750d5b6731760b0bb4ed54bb305692369f8bc0059e868e7bf3d06f31');
    expect(hashComposerSnapshot(contractFixture.canonicalComposer.manifest as never))
      .toBe(contractFixture.canonicalComposer.expectedHash);
    expect(normalizeRestrictedPlanResponse(response.json().data)).toEqual(RESTRICTED_PLAN_RESPONSE_FIXTURE);
  });

  it('开启联网搜索后将受限来源写入冻结计划并传递给 Planner', async () => {
    const planner = createDeterministicPlannerFixture();
    const webSearch: WebSearchService = {
      search: vi.fn(async () => [{
        title: '参考资料', url: 'https://example.com/reference', description: '用于验证的搜索摘要', engine: 'duckduckgo',
      }]),
    };
    const context = await setup({
      config: { webSearchEnabled: true, webSearchBaseUrl: 'http://web-search.internal' },
      planner,
      webSearch,
    });
    const response = await createPlan(context, { request: '生成一张红色图片', webSearchEnabled: 'true' });
    expect(response.statusCode, response.body).toBe(201);
    expect(webSearch.search).toHaveBeenCalledWith('生成一张红色图片');
    expect(response.json().data.webSearch).toEqual({ enabled: true, sources: [{
      title: '参考资料', url: 'https://example.com/reference', description: '用于验证的搜索摘要', engine: 'duckduckgo',
    }] });
    expect(planner.createDraft).toHaveBeenCalledWith(expect.objectContaining({ webSearchSources: [{
      title: '参考资料', url: 'https://example.com/reference', description: '用于验证的搜索摘要', engine: 'duckduckgo',
    }] }));
  });

  it('联网搜索失败时降级为离线计划并保留可见警告', async () => {
    const context = await setup({
      config: { webSearchEnabled: true, webSearchBaseUrl: 'http://web-search.internal' },
      webSearch: { search: vi.fn(async () => { throw new Error('upstream unavailable'); }) },
    });
    const response = await createPlan(context, { request: '生成一张红色图片', webSearchEnabled: 'true' });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data.webSearch).toEqual({ enabled: true, sources: [] });
    expect(response.json().data.warnings).toContain('联网搜索未完成：upstream unavailable；本计划按离线信息生成。');
  });

  it('旧客户端仍读取原形 v1 generation 计划并可按旧确认语义执行', async () => {
    const context = await setup();
    const form = multipart({ request: '生成一张红色图片' });
    const response = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'content-type': form.contentType },
    });
    expect(response.statusCode).toBe(201);
    const legacy = response.json().data;
    expect(legacy.schemaVersion).toBeUndefined();
    expect(legacy.operation).toBeUndefined();
    expect(legacy.composerSnapshotHash).toBeUndefined();
    expect(legacy.generation.action).toBe('generate');
    expect(legacy.steps).toEqual([{ title: '生成图片', operation: 'generate' }]);

    const accepted = await context.app.inject({
      method: 'POST', url: `/v1/plans/${legacy.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    expect(accepted.statusCode).toBe(202);
    await waitForTerminal(context.app, accepted.json().data.id, context.cookie);
  });

  it('runtime decoder fail-closed 拒绝未知 schema、actions、混合字段与对象命令', async () => {
    const context = await setup();
    const plan = (await createPlan(context)).json().data;
    for (const invalid of [
      { ...plan, schemaVersion: 4 },
      { ...plan, actions: [] },
      { ...plan, generation: plan.operation.generation },
      {
        ...plan,
        operation: {
          type: 'openshop.edit', inputAssetId: '00000000-0000-4000-8000-000000000000', outputFormat: 'png',
          commands: [{ schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: { objectId: 'forbidden' } }],
        },
      },
    ]) {
      expect(() => decodeRestrictedAgentPlanSnapshot(invalid)).toThrowError(expect.objectContaining({ code: 'invalid_plan_snapshot' }));
    }
    expect(decodeRestrictedAgentPlanSnapshot(structuredClone(contractFixture.validPlans.tool))).toBeTruthy();
    expect(decodeRestrictedAgentPlanSnapshot(structuredClone(contractFixture.validPlans.legacy))).toBeTruthy();
    for (const mutation of contractFixture.invalidPlanMutations) {
      expect(
        () => decodeRestrictedAgentPlanSnapshot(applyInvalidPlanMutation(mutation)),
        mutation.name,
      ).toThrowError(expect.objectContaining({ code: 'invalid_plan_snapshot' }));
    }
  });

  it('拒绝 model、tools、upstream 等未知客户端字段', async () => {
    const context = await setup();
    for (const field of ['model', 'tools', 'upstream']) {
      const response = await createPlan(context, { request: '测试', [field]: 'attacker-controlled' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('unknown_field');
    }
    expect(context.executor.executeGeneration).not.toHaveBeenCalled();
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
    const form = multipart({
      request: '把图片改成蓝色',
      size: '1024x1024',
      quality: 'medium',
      outputFormat: 'png',
      imageCount: '1',
      composerSnapshot: composerSnapshot({
        request: '把图片改成蓝色',
        inputs: [{ browserImageId: 'indexeddb-image-1', bytes: png }],
      }),
    }, [{ field: 'reference', bytes: png }]);
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

  it('创建 OpenShop 单 operation，并只在本地 binding 中关联 Gateway 与 IndexedDB ID', async () => {
    const context = await setup({ planner: createDeterministicPlannerFixture('openshop.edit') });
    const form = multipart({
      request: '顺时针旋转图片',
      size: '1024x1024',
      quality: 'medium',
      outputFormat: 'png',
      imageCount: '1',
      composerSnapshot: composerSnapshot({
        request: '顺时针旋转图片',
        inputs: [{ browserImageId: 'indexeddb-source-image', bytes: png }],
      }),
    }, [{ field: 'reference', bytes: png }]);
    const response = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'content-type': form.contentType },
    });

    expect(response.statusCode).toBe(201);
    const plan = response.json().data;
    expect(plan).not.toHaveProperty('generation');
    expect(plan).not.toHaveProperty('steps');
    expect(plan).not.toHaveProperty('actions');
    expect(plan.operation).toEqual({
      type: 'openshop.edit',
      inputAssetId: plan.inputs[0].assetId,
      commands: [{ schemaVersion: 1, id: 'canvas.rotate', target: 'document', args: { degrees: 90 } }],
      outputFormat: 'png',
    });
    expect(plan.operation).not.toHaveProperty('inputBrowserImageId');
    expect(JSON.stringify(plan.operation)).not.toMatch(/objectId|layerId/);
    expect(context.executor.executeGeneration).not.toHaveBeenCalled();
  });

  it('拒绝 OpenShop 缺少单一已有图片、非法命令和超过五条命令', async () => {
    const missingInput = await setup({ planner: createDeterministicPlannerFixture('openshop.edit') });
    const noInputResponse = await createPlan(missingInput, { request: '旋转图片' });
    expect(noInputResponse.statusCode).toBe(400);
    expect(noInputResponse.json().error.code).toBe('invalid_openshop_input');

    const invalidCommandPlanner: Planner = {
      createDraft: vi.fn(async () => ({
        summary: '非法编辑',
        operation: {
          type: 'openshop.edit',
          inputIndex: 0,
          commands: [{ schemaVersion: 1, id: 'object.remove', target: 'document', args: { objectId: 'forbidden' } }],
          outputFormat: 'png',
        },
        assumptions: [],
        warnings: [],
      })),
    };
    const invalidCommand = await setup({ planner: invalidCommandPlanner });
    const invalidForm = multipart({
      request: '删除对象',
      size: '1024x1024', quality: 'medium', outputFormat: 'png', imageCount: '1',
      composerSnapshot: composerSnapshot({ request: '删除对象', inputs: [{ browserImageId: 'source', bytes: png }] }),
    }, [{ field: 'reference', bytes: png }]);
    const invalidResponse = await invalidCommand.app.inject({
      method: 'POST', url: '/v1/plans', payload: invalidForm.payload,
      headers: { ...invalidCommand.mutationHeaders, 'content-type': invalidForm.contentType },
    });
    expect(invalidResponse.statusCode).toBe(502);
    expect(invalidResponse.json().error.code).toBe('invalid_planner_output');

    const tooManyPlanner: Planner = {
      createDraft: vi.fn(async () => ({
        summary: '过多命令',
        operation: {
          type: 'openshop.edit',
          inputIndex: 0,
          commands: Array.from({ length: 6 }, () => ({ schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} })),
          outputFormat: 'png',
        },
        assumptions: [],
        warnings: [],
      })),
    };
    const tooMany = await setup({ planner: tooManyPlanner });
    const tooManyForm = multipart({
      request: '扁平化',
      size: '1024x1024', quality: 'medium', outputFormat: 'png', imageCount: '1',
      composerSnapshot: composerSnapshot({ request: '扁平化', inputs: [{ browserImageId: 'source', bytes: png }] }),
    }, [{ field: 'reference', bytes: png }]);
    const tooManyResponse = await tooMany.app.inject({
      method: 'POST', url: '/v1/plans', payload: tooManyForm.payload,
      headers: { ...tooMany.mutationHeaders, 'content-type': tooManyForm.contentType },
    });
    expect(tooManyResponse.statusCode).toBe(502);
  });

  it('OpenShop crop 接受 8000 万像素边界并拒绝超限 Planner 输出', async () => {
    const cropPlanner = (width: number, height: number): Planner => ({
      createDraft: vi.fn(async () => ({
        summary: '裁剪现有图片',
        operation: {
          type: 'openshop.edit', inputIndex: 0, outputFormat: 'png',
          commands: [{ schemaVersion: 1, id: 'canvas.crop', target: 'document', args: { x: 0, y: 0, width, height } }],
        },
        assumptions: [], warnings: [],
      })),
    });
    const createCrop = async (width: number, height: number) => {
      const context = await setup({ planner: cropPlanner(width, height) });
      const form = multipart({
        request: '裁剪图片', size: '1024x1024', quality: 'medium', outputFormat: 'png', imageCount: '1',
        composerSnapshot: composerSnapshot({ request: '裁剪图片', inputs: [{ browserImageId: 'source', bytes: png }] }),
      }, [{ field: 'reference', bytes: png }]);
      return context.app.inject({
        method: 'POST', url: '/v1/plans', payload: form.payload,
        headers: { ...context.mutationHeaders, 'content-type': form.contentType },
      });
    };

    const boundary = await createCrop(10_000, 8_000);
    expect(boundary.statusCode).toBe(201);
    expect(boundary.json().data.operation.commands[0].args).toMatchObject({ width: 10_000, height: 8_000 });

    const overLimit = await createCrop(10_001, 8_000);
    expect(overLimit.statusCode).toBe(502);
    expect(overLimit.json().error.code).toBe('invalid_planner_output');
  });

  it('Planner schema 与 system prompt 同时明示 crop 8000 万像素约束', async () => {
    const serializedSchema = JSON.stringify(plannerJsonSchema);
    expect(serializedSchema).toContain('width * height');
    expect(serializedSchema).toContain('80_000_000');
    expect(serializedSchema).not.toContain('"oneOf"');
    expect(serializedSchema).toContain('"anyOf"');
    expect(findStrictObjectSchemaIssues(plannerJsonSchema)).toEqual([]);
    const config = await makeConfig();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: '生成图片',
        operation: {
          type: 'image.generate',
          generation: {
            exactPrompt: '生成图片', action: 'generate', size: '1024x1024', quality: 'medium',
            outputFormat: 'png', outputCompression: null, imageCount: 1,
          },
        },
        assumptions: [], warnings: [],
      }),
    }), { status: 200 }));
    await new ResponsesPlanner(config).createDraft({ request: '裁剪图片', preferences: {}, assets: [], allowOpenShop: true });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.input[0].content[0].text).toContain('width * height <= 80_000_000');
  });

  it('Planner 上游错误返回可诊断且脱敏的信息', async () => {
    const config = await makeConfig();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_json_schema',
        param: 'text.format.schema',
        message: '不支持 oneOf；authorization=Bearer upstream-secret；key=sk-test-secret-value',
      },
    }), { status: 400 }));

    await expect(new ResponsesPlanner(config).createDraft({
      request: '裁剪图片', preferences: {}, assets: [], allowOpenShop: true,
    })).rejects.toMatchObject({
      statusCode: 502,
      code: 'planner_upstream_error',
      message: 'Planner 上游返回 HTTP 400：不支持 oneOf；authorization=Bearer [REDACTED]；key=[REDACTED]',
      details: {
        upstreamStatus: 400,
        upstreamType: 'invalid_request_error',
        upstreamCode: 'invalid_json_schema',
        upstreamParam: 'text.format.schema',
      },
    });
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
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    const [first, second] = await Promise.all([request(), request()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 202]);
    expect(first.json().data.id).toBe(second.json().data.id);
    const completed = await waitForTerminal(context.app, first.json().data.id, context.cookie);
    expect(normalizeRestrictedExecutionResponse(completed, plan.id)).toEqual(RESTRICTED_EXECUTION_RESPONSE_FIXTURE);
    expect(executor.executeGeneration).toHaveBeenCalledTimes(1);
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
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
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
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash, 'content-type': 'application/json' },
    });
    expect(bodyResponse.statusCode).toBe(400);
    const missingHashResponse = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"' },
    });
    expect(missingHashResponse.statusCode).toBe(428);
    expect(missingHashResponse.json().error.code).toBe('composer_snapshot_hash_required');
    const staleHashResponse = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': '0'.repeat(64) },
    });
    expect(staleHashResponse.statusCode).toBe(412);
    expect(staleHashResponse.json().error.code).toBe('composer_snapshot_mismatch');
    const versionResponse = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"2"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    expect(versionResponse.statusCode).toBe(412);
    const otherCapabilities = await context.app.inject({ method: 'GET', url: '/v1/capabilities', headers: { host: 'app.internal' } });
    const otherCookie = otherCapabilities.headers['set-cookie']!.split(';')[0]!;
    const crossSession = await context.app.inject({
      method: 'GET', url: `/v1/plans/${plan.id}`, headers: { host: 'app.internal', cookie: otherCookie },
    });
    expect(crossSession.statusCode).toBe(404);
  });

  it('OpenShop 计划确认先校验快照，再稳定拒绝浏览器 operation 且不消费执行额度', async () => {
    const context = await setup({
      config: { executeRatePerMinute: 1, imagesRatePerHour: 1 },
      planner: createDeterministicPlannerFixture('openshop.edit'),
    });
    const form = multipart({
      request: '顺时针旋转图片',
      size: '1024x1024', quality: 'medium', outputFormat: 'png', imageCount: '1',
      composerSnapshot: composerSnapshot({
        request: '顺时针旋转图片',
        inputs: [{ browserImageId: 'source', bytes: png }],
      }),
    }, [{ field: 'reference', bytes: png }]);
    const planResponse = await context.app.inject({
      method: 'POST', url: '/v1/plans', payload: form.payload,
      headers: { ...context.mutationHeaders, 'content-type': form.contentType },
    });
    const plan = planResponse.json().data;

    const stale = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': '0'.repeat(64) },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe('composer_snapshot_mismatch');

    const unsupported = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().error.code).toBe('client_operation_requires_browser');
    expect(context.executor.executeGeneration).not.toHaveBeenCalled();

    const repeated = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe('client_operation_requires_browser');
  });

  it('版本失败不消耗确认和图片速率额度', async () => {
    const context = await setup({ config: { executeRatePerMinute: 1, imagesRatePerHour: 1 } });
    const plan = (await createPlan(context)).json().data;
    const failed = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"2"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    expect(failed.statusCode).toBe(412);
    const accepted = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
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
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    expect([409, 410]).toContain(response.statusCode);
    expect(context.executor.executeGeneration).not.toHaveBeenCalled();
  });

  it('执行中取消不会自动重试', async () => {
    const executor = fakeExecutor(500);
    const context = await setup({ executor });
    const plan = (await createPlan(context)).json().data;
    const started = await context.app.inject({
      method: 'POST', url: `/v1/plans/${plan.id}/execute`,
      headers: { ...context.mutationHeaders, 'if-match': '"1"', 'x-composer-snapshot-hash': plan.composerSnapshotHash },
    });
    const id = started.json().data.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await context.app.inject({
      method: 'POST', url: `/v1/executions/${id}/cancel`, headers: context.mutationHeaders,
    });
    expect(['executing', 'cancelled']).toContain(cancelled.json().data.status);
    const terminal = await waitForTerminal(context.app, id, context.cookie);
    expect(terminal.status).toBe('cancelled');
    expect(executor.executeGeneration).toHaveBeenCalledTimes(1);
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

describe('plan audit metadata compatibility', () => {
  it('image plan 同时保留 action 与 operation，OpenShop 仅记录 operation', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const legacy = decodeRestrictedAgentPlanSnapshot(structuredClone(contractFixture.validPlans.legacy));
    const tool = decodeRestrictedAgentPlanSnapshot({
      ...structuredClone(contractFixture.validPlans.tool),
      id: '33333333-3333-4333-8333-333333333333',
    });
    const openShop = decodeRestrictedAgentPlanSnapshot({
      ...structuredClone(contractFixture.validPlans.tool),
      id: '44444444-4444-4444-8444-444444444444',
      operation: {
        type: 'openshop.edit',
        inputAssetId: '55555555-5555-4555-8555-555555555555',
        commands: [{ schemaVersion: 1, id: 'canvas.flatten', target: 'document', args: {} }],
        outputFormat: 'png',
      },
      inputs: [{
        assetId: '55555555-5555-4555-8555-555555555555', role: 'reference', sha256: 'a'.repeat(64),
        mimeType: 'image/png', width: 1, height: 1,
      }],
    });
    db.insertPlan(legacy, 'session', []);
    db.insertPlan(tool, 'session', []);
    db.insertPlan(openShop, 'session', []);
    const rows = db.raw.prepare("SELECT entity_id, metadata_json FROM audit_events WHERE event_type = 'plan.created'")
      .all() as Array<{ entity_id: string; metadata_json: string }>;
    db.close();
    const metadata = new Map(rows.map((row) => [row.entity_id, JSON.parse(row.metadata_json) as Record<string, unknown>]));

    expect(metadata.get(legacy.id)).toMatchObject({ action: 'generate', operation: 'image.generate' });
    expect(metadata.get(tool.id)).toMatchObject({ action: 'generate', operation: 'image.generate' });
    expect(metadata.get(openShop.id)).toMatchObject({ operation: 'openshop.edit' });
    expect(metadata.get(openShop.id)).not.toHaveProperty('action');
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

describe('v3 execution action persistence', () => {
  function v3Plan(id = TOOL_AGENT_V3_PLAN_FIXTURE.id): ToolAgentPlanV3Snapshot {
    return decodeRestrictedAgentPlanSnapshot({
      ...structuredClone(TOOL_AGENT_V3_PLAN_FIXTURE),
      id,
    }) as ToolAgentPlanV3Snapshot;
  }

  function outputAsset(executionId: string, planId: string, id = '99999999-9999-4999-8999-999999999999'): StoredAsset {
    return {
      id,
      planId,
      executionId,
      sessionId: 'session',
      direction: 'output',
      role: 'generated',
      mimeType: 'image/png',
      sha256: 'b'.repeat(64),
      storagePath: `/test/${id}.png`,
      byteSize: 95,
      width: 870,
      height: 220,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    };
  }

  it('打开旧 v2 SQLite 时前向创建 v3 action 表且仍可读取旧计划', async () => {
    const config = await makeConfig();
    const legacy = decodeRestrictedAgentPlanSnapshot(structuredClone(contractFixture.validPlans.tool));
    const beforeMigration = new GatewayDatabase(config);
    try {
      beforeMigration.insertPlan(legacy, 'session', []);
      // 用当前基线初始化后移除 v3 表，精确模拟仍停留在 v2 的已部署数据库。
      beforeMigration.raw.exec('DROP TABLE execution_action_artifacts; DROP TABLE execution_actions;');
      beforeMigration.raw.pragma('user_version = 2');
    } finally {
      beforeMigration.close();
    }

    const migrated = new GatewayDatabase(config);
    try {
      expect(migrated.getPlan(legacy.id, 'session')).toMatchObject({ schemaVersion: 2, id: legacy.id });
      expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_actions'").get()).toBeTruthy();
      expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_action_artifacts'").get()).toBeTruthy();
      expect(migrated.raw.pragma('user_version', { simple: true })).toBe(3);
    } finally {
      migrated.close();
    }

    const replayed = new GatewayDatabase(config);
    try {
      expect(replayed.getPlan(legacy.id, 'session')).toMatchObject({ schemaVersion: 2, id: legacy.id });
      expect(replayed.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_actions'").get()).toBeTruthy();
      expect(replayed.raw.pragma('user_version', { simple: true })).toBe(3);
    } finally {
      replayed.close();
    }
  });

  it('同一 execution 的 action index 与幂等键均只能写入一次，并隔离跨会话读取', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    try {
      const { execution } = db.insertAutoPlanAndExecution(v3Plan(), 'session', []);
      const first = db.getExecutionActions(execution.id, 'session')[0]!;

      expect(() => db.insertExecutionAction({
        executionId: execution.id,
        actionIndex: first.actionIndex,
        action: first.normalizedParams,
        idempotencyKey: `${first.idempotencyKey}-different`,
      })).toThrow(/UNIQUE/);
      expect(() => db.insertExecutionAction({
        executionId: execution.id,
        actionIndex: 99,
        action: first.normalizedParams,
        idempotencyKey: first.idempotencyKey,
      })).toThrow(/UNIQUE/);
      try {
        db.getExecutionActions(execution.id, 'other-session');
        throw new Error('跨会话读取不应成功');
      } catch (error) {
        expect(error).toMatchObject({ code: 'execution_not_found' });
      }
    } finally {
      db.close();
    }
  });

  it('queued action 可在重启后保留，执行中的 action 会标为 failed_unknown 并终止后续 action', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const now = Date.now();
    let executionId = '';
    try {
      executionId = db.insertAutoPlanAndExecution(v3Plan(), 'session', [], now).execution.id;
    } finally {
      db.close();
    }

    const resumed = new GatewayDatabase(config);
    try {
      expect(resumed.getExecutionActions(executionId, 'session').map((action) => action.status)).toEqual(['queued', 'queued', 'queued']);
      expect(resumed.claimNextExecution(now + 1)?.id).toBe(executionId);
      expect(resumed.claimNextAction(executionId, now + 2)).toMatchObject({ actionIndex: 0, status: 'executing' });
    } finally {
      resumed.close();
    }

    const restarted = new GatewayDatabase(config);
    try {
      expect(restarted.recoverInterruptedExecutions(now + 3)).toBe(1);
      expect(restarted.getExecution(executionId, 'session')).toMatchObject({ status: 'failed_unknown' });
      expect(restarted.getExecutionActions(executionId, 'session').map((action) => action.status))
        .toEqual(['failed_unknown', 'cancelled', 'cancelled']);
    } finally {
      restarted.close();
    }
  });

  it('仅在 metadata.assert 成功后暴露 v3 最终产物，action 失败会同步取消未启动步骤', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const now = Date.now();
    try {
      const { execution } = db.insertAutoPlanAndExecution(v3Plan(), 'session', [], now);
      db.claimNextExecution(now + 1);
      const generated = db.claimNextAction(execution.id, now + 2)!;
      const asset = outputAsset(execution.id, execution.planId);
      db.insertOutputAssets([asset]);
      db.completeAction(generated.id, [asset.id], now + 3);

      const transformed = db.claimNextAction(execution.id, now + 4)!;
      expect(transformed.inputAssets.map((input) => input.id)).toEqual([asset.id]);
      db.completeAction(transformed.id, [asset.id], now + 5);
      expect(db.getExecution(execution.id, 'session').outputAssets).toEqual([]);

      const asserted = db.claimNextAction(execution.id, now + 6)!;
      expect(asserted.inputAssets.map((input) => input.id)).toEqual([asset.id]);
      db.completeAction(asserted.id, [asset.id], now + 7);
      expect(db.getExecution(execution.id, 'session')).toMatchObject({
        status: 'completed',
        outputAssets: [expect.objectContaining({ id: asset.id, width: 870, height: 220 })],
      });

      const failed = db.insertAutoPlanAndExecution(v3Plan('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'session', [], now + 8).execution;
      db.claimNextExecution(now + 9);
      const failedAction = db.claimNextAction(failed.id, now + 10)!;
      db.failAction(failedAction.id, { code: 'test_failure', message: '测试失败' }, now + 11);
      expect(db.getExecution(failed.id, 'session')).toMatchObject({ status: 'failed' });
      expect(db.getExecutionActions(failed.id, 'session').map((action) => action.status))
        .toEqual(['failed', 'cancelled', 'cancelled']);
    } finally {
      db.close();
    }
  });
});

describe('v3 action Worker', () => {
  function v3GenerationPlan(id: string): ToolAgentPlanV3Snapshot {
    return decodeRestrictedAgentPlanSnapshot({
      ...structuredClone(TOOL_AGENT_V3_PLAN_FIXTURE),
      id,
    }) as ToolAgentPlanV3Snapshot;
  }

  function v3TransformPlan(id: string, input: StoredAsset): ToolAgentPlanV3Snapshot {
    const finalOutputSpec = {
      width: 870,
      height: 220,
      fit: 'cover' as const,
      position: 'center' as const,
      rotate: 90 as const,
      flip: 'horizontal' as const,
      outputFormat: 'png' as const,
      outputCompression: null,
    };
    return decodeRestrictedAgentPlanSnapshot({
      schemaVersion: 3,
      id,
      version: 1,
      status: 'queued',
      expiresAt: '2099-01-01T00:00:00.000Z',
      originalRequest: '将参考图旋转并输出严格尺寸',
      composerSnapshotHash: 'c'.repeat(64),
      summary: '确定性处理参考图',
      inputs: [{
        assetId: input.id,
        role: 'reference',
        sha256: input.sha256,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
      }],
      assumptions: [],
      warnings: [],
      policyVersion: 'tool-operation-v3',
      finalOutputSpec,
      actions: [
        {
          type: 'image.transform',
          input: { kind: 'plan_input', assetId: input.id },
          transform: finalOutputSpec,
        },
        {
          type: 'metadata.assert',
          input: { kind: 'action_output', actionIndex: 0 },
          expected: finalOutputSpec,
        },
      ],
    }) as ToolAgentPlanV3Snapshot;
  }

  async function createReferenceAsset(
    config: GatewayConfig,
    id: string,
    bytes = png,
    width = 2,
    height = 2,
  ): Promise<StoredAsset> {
    const storagePath = path.join(config.assetsDir, `${id}.png`);
    await writeFile(storagePath, bytes);
    return {
      id,
      planId: null,
      executionId: null,
      sessionId: 'session',
      direction: 'input',
      role: 'reference',
      mimeType: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storagePath,
      byteSize: bytes.byteLength,
      width,
      height,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    };
  }

  function actionExecutor(outputs: Buffer[], delayMs = 0): ImageExecutor & { executeGeneration: ReturnType<typeof vi.fn> } {
    const executeGeneration = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
      }
      return outputs;
    });
    return { executeGeneration } as unknown as ImageExecutor & { executeGeneration: ReturnType<typeof vi.fn> };
  }

  async function waitForDatabaseTerminal(db: GatewayDatabase, executionId: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const execution = db.getExecution(executionId, 'session');
      if (['completed', 'failed', 'cancelled', 'failed_unknown'].includes(execution.status)) return execution;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('v3 execution did not finish');
  }

  async function waitForActionStatus(db: GatewayDatabase, executionId: string, status: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (db.getExecutionActions(executionId, 'session')[0]?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`action did not reach ${status}`);
  }

  it('transform 按确定性顺序写入新资产，contain JPEG 默认白底，metadata.assert 读取真实文件', async () => {
    const config = await makeConfig();
    const store = new AssetStore(config);
    await store.initialize();
    const widePng = await sharp({
      create: { width: 40, height: 20, channels: 4, background: '#ff0000ff' },
    }).png().toBuffer();
    const input = await createReferenceAsset(
      config,
      '11111111-1111-4111-8111-111111111111',
      widePng,
      40,
      20,
    );
    const inputSha256 = createHash('sha256').update(readFileSync(input.storagePath)).digest('hex');

    const transformed = await store.transform(input, {
      sessionId: 'session',
      planId: '22222222-2222-4222-8222-222222222222',
      executionId: '33333333-3333-4333-8333-333333333333',
    }, {
      width: 40,
      height: 40,
      fit: 'contain',
      position: 'center',
      crop: { x: 0, y: 0, width: 40, height: 20 },
      rotate: 90,
      flip: 'horizontal',
      outputFormat: 'jpeg',
      outputCompression: 90,
    });

    expect(transformed.id).not.toBe(input.id);
    expect(transformed.storagePath).not.toBe(input.storagePath);
    expect(createHash('sha256').update(readFileSync(input.storagePath)).digest('hex')).toBe(inputSha256);
    await expect(sharp(transformed.storagePath).metadata()).resolves.toMatchObject({ format: 'jpeg', width: 40, height: 40 });
    const raw = await sharp(transformed.storagePath).raw().toBuffer();
    expect(raw[0]).toBeGreaterThan(240);
    expect(raw[1]).toBeGreaterThan(240);
    expect(raw[2]).toBeGreaterThan(240);
    await expect(store.assertMetadata(transformed, { width: 40, height: 40, outputFormat: 'jpeg' })).resolves.toBeUndefined();

    const filled = await store.transform(input, {
      sessionId: 'session',
      planId: '22222222-2222-4222-8222-222222222222',
      executionId: '33333333-3333-4333-8333-333333333333',
    }, {
      width: 30,
      height: 10,
      fit: 'fill',
      outputFormat: 'webp',
      outputCompression: 90,
    });
    await expect(sharp(readFileSync(filled.storagePath)).metadata()).resolves.toMatchObject({ format: 'webp', width: 30, height: 10 });

    await writeFile(transformed.storagePath, png);
    await expect(store.assertMetadata(transformed, { width: 40, height: 40, outputFormat: 'jpeg' }))
      .rejects.toMatchObject({ code: 'metadata_assertion_failed' });
  });

  it('生成 → transform → assert 按 action 顺序执行，并只在 assert 后发布最终资产', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const store = new AssetStore(config);
    const events = new ExecutionEvents();
    const executor = actionExecutor([png]);
    const worker = new ExecutionWorker(db, store, executor, events);
    const progressEvents: string[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
      await store.initialize();
      const execution = db.insertAutoPlanAndExecution(v3GenerationPlan('44444444-4444-4444-8444-444444444444'), 'session', []).execution;
      unsubscribe = events.subscribe(execution.id, (event, data) => {
        if (event.startsWith('action.')) {
          const action = data as { type: string };
          progressEvents.push(`${event}:${action.type}`);
        } else if (event === 'asset.ready') {
          progressEvents.push(event);
        }
      });
      worker.start();
      const terminal = await waitForDatabaseTerminal(db, execution.id);

      expect(terminal).toMatchObject({
        status: 'completed',
        outputAssets: [expect.objectContaining({ width: 870, height: 220, mimeType: 'image/png' })],
      });
      expect(executor.executeGeneration).toHaveBeenCalledTimes(1);
      expect(progressEvents).toEqual([
        'action.started:image.generate',
        'action.completed:image.generate',
        'action.started:image.transform',
        'action.completed:image.transform',
        'action.started:metadata.assert',
        'action.completed:metadata.assert',
        'asset.ready',
      ]);
    } finally {
      unsubscribe?.();
      await worker.shutdown();
      db.close();
    }
  });

  it('纯 transform → assert 不调用 Images executor，取消会终止当前及后续 action', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const store = new AssetStore(config);
    const events = new ExecutionEvents();
    const executor = actionExecutor([png]);
    const worker = new ExecutionWorker(db, store, executor, events);
    let delayedWorker: ExecutionWorker | undefined;
    try {
      await store.initialize();
      const input = await createReferenceAsset(config, '55555555-5555-4555-8555-555555555555');
      const execution = db.insertAutoPlanAndExecution(v3TransformPlan('66666666-6666-4666-8666-666666666666', input), 'session', [input]).execution;
      worker.start();
      const terminal = await waitForDatabaseTerminal(db, execution.id);
      expect(terminal).toMatchObject({
        status: 'completed',
        outputAssets: [expect.objectContaining({ width: 870, height: 220, mimeType: 'image/png' })],
      });
      expect(executor.executeGeneration).not.toHaveBeenCalled();

      delayedWorker = new ExecutionWorker(db, store, actionExecutor([png], 500), events);
      const delayed = db.insertAutoPlanAndExecution(v3GenerationPlan('77777777-7777-4777-8777-777777777777'), 'session', []).execution;
      delayedWorker.start();
      await waitForActionStatus(db, delayed.id, 'executing');
      const cancellation = db.requestCancellation(delayed.id, 'session');
      delayedWorker.abort(delayed.id);
      const cancelled = await waitForDatabaseTerminal(db, delayed.id);
      expect(cancellation.status).toBe('executing');
      expect(cancelled.status).toBe('cancelled');
      expect(db.getExecutionActions(delayed.id, 'session').map((action) => action.status))
        .toEqual(['cancelled', 'cancelled', 'cancelled']);
    } finally {
      await delayedWorker?.shutdown();
      await worker.shutdown();
      db.close();
    }
  });

  it('shutdown 将当前 v3 action 标为 failed_unknown，并阻止 transform 完成后误报成功', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const store = new AssetStore(config);
    const events = new ExecutionEvents();
    const worker = new ExecutionWorker(db, store, actionExecutor([png]), events);
    const actualTransform = store.transform.bind(store);
    const failedUnknown = vi.fn();
    let resolveTransformStarted!: () => void;
    const transformStarted = new Promise<void>((resolve) => {
      resolveTransformStarted = resolve;
    });
    let releaseTransform: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    vi.spyOn(store, 'transform').mockImplementation(async (input, context, transform) => {
      resolveTransformStarted();
      await new Promise<void>((resolve) => {
        releaseTransform = resolve;
      });
      return actualTransform(input, context, transform);
    });
    try {
      await store.initialize();
      const input = await createReferenceAsset(config, '88888888-8888-4888-8888-888888888888');
      const execution = db.insertAutoPlanAndExecution(
        v3TransformPlan('99999999-9999-4999-8999-999999999999', input),
        'session',
        [input],
      ).execution;
      unsubscribe = events.subscribe(execution.id, (event, data) => {
        if (event === 'action.failed_unknown') failedUnknown(data);
      });
      worker.start();
      await transformStarted;

      const shutdown = worker.shutdown();
      releaseTransform?.();
      await shutdown;

      const terminal = db.getExecution(execution.id, 'session');
      expect(terminal).toMatchObject({
        status: 'failed_unknown',
        error: expect.objectContaining({ code: 'gateway_shutdown' }),
        outputAssets: [],
      });
      expect(db.getExecutionActions(execution.id, 'session').map((action) => action.status))
        .toEqual(['failed_unknown', 'cancelled']);
      expect(failedUnknown).toHaveBeenCalledWith(expect.objectContaining({
        type: 'image.transform',
        status: 'failed_unknown',
        error: expect.objectContaining({ code: 'gateway_shutdown' }),
      }));
    } finally {
      unsubscribe?.();
      releaseTransform?.();
      await worker.shutdown();
      db.close();
    }
  });

  it('metadata.assert 读取被篡改的实际文件并令 v3 execution 失败，不发布最终资产', async () => {
    const config = await makeConfig();
    const db = new GatewayDatabase(config);
    const store = new AssetStore(config);
    const events = new ExecutionEvents();
    const executor = actionExecutor([png]);
    const worker = new ExecutionWorker(db, store, executor, events);
    const actualTransform = store.transform.bind(store);
    const assetReady = vi.fn();
    let unsubscribe: (() => void) | undefined;
    vi.spyOn(store, 'transform').mockImplementation(async (input, context, transform) => {
      const output = await actualTransform(input, context, transform);
      await writeFile(output.storagePath, jpeg);
      return output;
    });
    try {
      await store.initialize();
      const input = await createReferenceAsset(config, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const execution = db.insertAutoPlanAndExecution(
        v3TransformPlan('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', input),
        'session',
        [input],
      ).execution;
      unsubscribe = events.subscribe(execution.id, (event) => {
        if (event === 'asset.ready') assetReady();
      });
      worker.start();
      const terminal = await waitForDatabaseTerminal(db, execution.id);

      expect(terminal).toMatchObject({
        status: 'failed',
        error: expect.objectContaining({ code: 'metadata_assertion_failed' }),
        outputAssets: [],
      });
      expect(db.getExecutionActions(execution.id, 'session').map((action) => action.status))
        .toEqual(['completed', 'failed']);
      expect(executor.executeGeneration).not.toHaveBeenCalled();
      expect(assetReady).not.toHaveBeenCalled();
    } finally {
      unsubscribe?.();
      await worker.shutdown();
      db.close();
    }
  });
});
