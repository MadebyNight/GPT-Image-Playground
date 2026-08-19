import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssetStore } from './assets.js';
import { loadConfig, type GatewayConfig } from './config.js';
import { GatewayDatabase } from './db.js';
import { AppError } from './errors.js';
import { ExecutionEvents } from './events.js';
import { DeterministicImagesExecutor, type ImageExecutor } from './executor.js';
import {
  ALLOWED_SIZES,
  LEGACY_POLICY_VERSION,
  POLICY_VERSION,
  hashComposerSnapshot,
  normalizeComposerSnapshot,
  parseComposerSnapshotManifest,
  validateAndConstrainDraft,
} from './policy.js';
import { ResponsesPlanner, type Planner } from './planner.js';
import { getImageGeneration, getPlanOperation, isToolAgentPlan } from './plan.js';
import {
  getOrCreateSession,
  requireCsrf,
  requireSameOrigin,
  SlidingWindowRateLimiter,
  type SessionContext,
} from './security.js';
import type {
  ComposerSnapshotManifest,
  PlanInputView,
  PlanPreferences,
  PlannerDraft,
  RestrictedAgentPlanSnapshot,
  StoredAsset,
  ToolOperation,
} from './types.js';
import { ExecutionWorker } from './worker.js';
import { OpenWebSearchService, type WebSearchService } from './webSearch.js';

const fieldSchema = z.object({
  request: z.string().trim().min(1).max(16_000),
  size: z.enum(ALLOWED_SIZES).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(),
  outputCompression: z.coerce.number().int().min(0).max(100).optional(),
  imageCount: z.coerce.number().int().min(1).optional(),
  composerSnapshot: z.string().max(64_000).optional(),
  webSearchEnabled: z.string().optional().refine((value) => value === undefined || value === 'true' || value === 'false'),
}).strict();

export interface CreateAppOptions {
  config?: GatewayConfig;
  planner?: Planner;
  executor?: ImageExecutor;
  webSearch?: WebSearchService;
}

function sessionForMutation(request: FastifyRequest, reply: Parameters<typeof getOrCreateSession>[1], config: GatewayConfig): SessionContext {
  requireSameOrigin(request, config);
  const session = getOrCreateSession(request, reply, config);
  requireCsrf(request, session);
  return session;
}

function parseIfMatch(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new AppError(428, 'if_match_required', '确认执行必须携带 If-Match 计划版本');
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(value.trim());
  if (!match) throw new AppError(400, 'invalid_if_match', 'If-Match 格式无效');
  return Number(match[1]);
}

function ensureEmptyBody(request: FastifyRequest): void {
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > 0 || request.body !== undefined) {
    throw new AppError(400, 'body_not_allowed', '此接口不接受请求体');
  }
}

function assetToPlanInput(asset: StoredAsset): PlanInputView {
  if (asset.role === 'generated') throw new Error('生成资源不能作为计划输入');
  return {
    assetId: asset.id,
    role: asset.role,
    sha256: asset.sha256,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
  };
}

type UploadedPlanAsset = StoredAsset & {
  uploadedByteSize: number;
  roleOrdinal: number;
};

function assertComposerFields(
  manifest: ComposerSnapshotManifest,
  fields: z.infer<typeof fieldSchema>,
): ComposerSnapshotManifest {
  const normalized = normalizeComposerSnapshot(manifest);
  if (normalized.prompt !== fields.request) {
    throw new AppError(400, 'composer_snapshot_mismatch', 'Composer Prompt 与计划请求不一致');
  }
  const expected = normalized.params;
  const actual = {
    size: fields.size,
    quality: fields.quality,
    outputFormat: fields.outputFormat,
    outputCompression: fields.outputFormat === 'png' ? null : fields.outputCompression ?? 90,
    imageCount: fields.imageCount,
  };
  if (actual.size === undefined || actual.quality === undefined || actual.outputFormat === undefined
    || actual.imageCount === undefined
    || actual.size !== expected.size
    || actual.quality !== expected.quality
    || actual.outputFormat !== expected.outputFormat
    || actual.outputCompression !== expected.outputCompression
    || actual.imageCount !== expected.imageCount) {
    throw new AppError(400, 'composer_snapshot_mismatch', 'Composer 参数与计划请求不一致');
  }
  return normalized;
}

function bindComposerUploads(
  manifest: ComposerSnapshotManifest,
  uploads: UploadedPlanAsset[],
): UploadedPlanAsset[] {
  const byBinding = new Map(uploads.map((asset) => [`${asset.role}:${asset.roleOrdinal}`, asset]));
  const ordered: UploadedPlanAsset[] = [];
  for (const input of manifest.inputs) {
    const asset = byBinding.get(`${input.role}:${input.ordinal}`);
    if (!asset || asset.sourceSha256 !== input.contentSha256) {
      throw new AppError(400, 'composer_asset_binding_mismatch', 'Composer 输入与上传资产的 role + ordinal 或内容哈希不一致');
    }
    ordered.push(asset);
    byBinding.delete(`${input.role}:${input.ordinal}`);
  }
  if (manifest.mask) {
    const mask = byBinding.get('mask:0');
    if (!mask || mask.sourceSha256 !== manifest.mask.contentSha256) {
      throw new AppError(400, 'composer_asset_binding_mismatch', 'Composer mask 与上传内容哈希不一致');
    }
    ordered.push(mask);
    byBinding.delete('mask:0');
  }
  if (byBinding.size > 0 || ordered.length !== uploads.length) {
    throw new AppError(400, 'composer_asset_binding_mismatch', 'Composer 输入数量与上传资产不一致');
  }
  return ordered;
}

function resolveToolOperation(draftOperation: PlannerDraft['operation'], inputs: PlanInputView[]): ToolOperation {
  if (draftOperation.type === 'image.generate' || draftOperation.type === 'image.edit') {
    return draftOperation;
  }
  const editableInputs = inputs.filter((input) => input.role !== 'mask');
  const input = editableInputs[draftOperation.inputIndex];
  if (!input) throw new AppError(400, 'invalid_openshop_input', 'OpenShop inputIndex 未引用有效输入');
  return {
    type: 'openshop.edit',
    inputAssetId: input.assetId,
    commands: draftOperation.commands,
    outputFormat: 'png',
  };
}

function parseComposerSnapshotHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || null;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : {
      level: config.logLevel,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-csrf-token',
        'res.headers.set-cookie',
      ],
    },
    bodyLimit: config.maxUploadBytes,
    trustProxy: true,
    requestTimeout: Math.max(config.plannerTimeoutMs, config.executorTimeoutMs) + 10_000,
  });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxFileBytes,
      files: config.maxReferenceImages + 2,
      fields: 7,
      parts: config.maxReferenceImages + 8,
    },
  });

  const db = new GatewayDatabase(config);
  const assetStore = new AssetStore(config);
  await assetStore.initialize();
  const planner = options.planner ?? new ResponsesPlanner(config);
  const executor = options.executor ?? new DeterministicImagesExecutor(config);
  const webSearch = options.webSearch ?? new OpenWebSearchService(config);
  const events = new ExecutionEvents();
  const worker = new ExecutionWorker(db, assetStore, executor, events);
  const rateLimiter = new SlidingWindowRateLimiter();
  const recovered = db.recoverInterruptedExecutions();
  if (recovered > 0) app.log.warn({ recovered }, '已将重启时的 executing 任务标记为 failed_unknown');
  worker.start();

  const cleanupExpiredAssets = async () => {
    const expired = db.listExpiredAssets();
    for (const asset of expired) {
      await assetStore.remove(asset);
      db.deleteAssetRecord(asset.id);
    }
  };
  await cleanupExpiredAssets();
  const cleanupTimer = setInterval(() => void cleanupExpiredAssets().catch((error) => {
    app.log.warn({ err: error }, '清理过期资源失败');
  }), 5 * 60_000);
  cleanupTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
    await worker.shutdown();
    db.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const multipartCode = (error as { code?: string }).code;
    if (multipartCode?.startsWith('FST_')) {
      void reply.status(multipartCode.includes('TOO_LARGE') ? 413 : 400).send({
        error: { code: 'invalid_multipart', message: '上传数据不符合限制' },
      });
      return;
    }
    app.log.error({ err: error }, 'Gateway 未处理异常');
    void reply.status(500).send({ error: { code: 'internal_error', message: 'Gateway 内部错误' } });
  });

  app.get('/healthz', async () => {
    db.raw.prepare('SELECT 1').get();
    return { status: 'ok' };
  });

  app.get('/v1/capabilities', async (request, reply) => {
    const session = getOrCreateSession(request, reply, config);
    reply.header('cache-control', 'no-store');
    return {
      data: {
        enabled: true,
        policyVersion: POLICY_VERSION,
        planSchemaVersions: [1, 2],
        operationTypes: ['image.generate', 'image.edit', 'openshop.edit'],
        csrfToken: session.csrfToken,
        limits: {
          planTtlSeconds: config.planTtlSeconds,
          assetTtlSeconds: config.assetTtlSeconds,
          maxReferenceImages: config.maxReferenceImages,
          maxFileBytes: config.maxFileBytes,
          maxUploadBytes: config.maxUploadBytes,
          maxImagePixels: config.maxImagePixels,
          maxOutputImages: config.maxOutputImages,
          maxQueue: config.maxQueue,
          maxConcurrency: config.maxConcurrency,
          planRatePerMinute: config.planRatePerMinute,
          executeRatePerMinute: config.executeRatePerMinute,
          imagesRatePerHour: config.imagesRatePerHour,
          webSearchRatePerMinute: config.webSearchRatePerMinute,
        },
        parameters: {
          sizes: ALLOWED_SIZES,
          qualities: ['auto', 'low', 'medium', 'high'],
          outputFormats: ['png', 'jpeg', 'webp'],
        },
      },
    };
  });

  app.post('/v1/plans', async (request, reply) => {
    const session = sessionForMutation(request, reply, config);
    rateLimiter.consume(`plan:${session.id}`, config.planRatePerMinute, 60_000);
    if (!request.isMultipart()) throw new AppError(415, 'multipart_required', '创建计划必须使用 multipart/form-data');

    const rawFields: Record<string, string> = {};
    const uploads: UploadedPlanAsset[] = [];
    const roleCounts = new Map<string, number>();
    let totalUploadedBytes = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (!(part.fieldname in fieldSchema.shape)) throw new AppError(400, 'unknown_field', `不允许字段 ${part.fieldname}`);
          if (rawFields[part.fieldname] !== undefined) throw new AppError(400, 'duplicate_field', `字段 ${part.fieldname} 重复`);
          if (typeof part.value !== 'string') throw new AppError(400, 'invalid_field', `字段 ${part.fieldname} 必须是文本`);
          rawFields[part.fieldname] = part.value;
          continue;
        }
        if (!['reference', 'mask_target', 'mask'].includes(part.fieldname)) {
          part.file.resume();
          throw new AppError(400, 'unknown_file_field', `不允许文件字段 ${part.fieldname}`);
        }
        const role = part.fieldname as 'reference' | 'mask_target' | 'mask';
        const roleOrdinal = roleCounts.get(role) ?? 0;
        const count = roleOrdinal + 1;
        roleCounts.set(role, count);
        if (role === 'reference' && count > config.maxReferenceImages) throw new AppError(400, 'too_many_references', '参考图数量超过限制');
        if (role !== 'reference' && count > 1) throw new AppError(400, 'duplicate_mask_input', `${role} 只能上传一张`);
        const stored = await assetStore.storeUpload(part, session.id, role);
        uploads.push({ ...stored, roleOrdinal });
        totalUploadedBytes += Math.max(stored.uploadedByteSize, stored.byteSize);
        if (totalUploadedBytes > config.maxUploadBytes) throw new AppError(413, 'upload_too_large', '上传总大小超过限制');
      }

      const parsedFields = fieldSchema.safeParse(rawFields);
      if (!parsedFields.success) throw new AppError(400, 'invalid_plan_request', '计划请求字段无效');
      if (parsedFields.data.imageCount && parsedFields.data.imageCount > config.maxOutputImages) {
        throw new AppError(400, 'invalid_image_count', `输出图片数量必须为 1-${config.maxOutputImages}`);
      }
      const preferences: PlanPreferences = {
        size: parsedFields.data.size,
        quality: parsedFields.data.quality,
        outputFormat: parsedFields.data.outputFormat,
        outputCompression: parsedFields.data.outputCompression,
        imageCount: parsedFields.data.imageCount,
      };
      const webSearchRequested = parsedFields.data.webSearchEnabled === 'true';
      let webSearchSources: import('./types.js').WebSearchSource[] | undefined;
      let webSearchWarning: string | null = null;
      if (webSearchRequested) {
        try {
          rateLimiter.consume(`web-search:${session.id}`, config.webSearchRatePerMinute, 60_000);
          webSearchSources = await webSearch.search(parsedFields.data.request);
        } catch (error) {
          webSearchSources = [];
          webSearchWarning = `联网搜索未完成：${error instanceof Error ? error.message : '服务不可用'}；本计划按离线信息生成。`;
        }
      }
      const manifest = parsedFields.data.composerSnapshot
        ? assertComposerFields(parseComposerSnapshotManifest(parsedFields.data.composerSnapshot, config), parsedFields.data)
        : null;
      const orderedUploads = manifest ? bindComposerUploads(manifest, uploads) : uploads;
      const inputs = orderedUploads.map(assetToPlanInput);
      const draft = validateAndConstrainDraft(
        await planner.createDraft({
          request: parsedFields.data.request,
          preferences,
          assets: orderedUploads,
          allowOpenShop: Boolean(manifest),
          webSearchSources,
        }),
        preferences,
        inputs,
        config,
        Boolean(manifest),
      );
      const id = randomUUID();
      const basePlan = {
        id,
        version: 1,
        status: 'awaiting_confirmation' as const,
        expiresAt: new Date(Date.now() + config.planTtlSeconds * 1000).toISOString(),
        originalRequest: parsedFields.data.request,
        summary: draft.summary,
        inputs,
        assumptions: draft.assumptions,
        warnings: draft.warnings,
        ...(webSearchRequested ? { webSearch: { enabled: true as const, sources: webSearchSources ?? [] } } : {}),
        ...(webSearchWarning ? { warnings: [...draft.warnings, webSearchWarning] } : {}),
      };
      let plan: RestrictedAgentPlanSnapshot;
      if (manifest) {
        plan = {
          ...basePlan,
          schemaVersion: 2,
          composerSnapshotHash: hashComposerSnapshot(manifest),
          operation: resolveToolOperation(draft.operation, inputs),
          policyVersion: POLICY_VERSION,
        };
      } else {
        if (draft.operation.type === 'openshop.edit') {
          throw new AppError(502, 'invalid_planner_output', '旧版客户端计划不能包含 OpenShop operation');
        }
        plan = {
          ...basePlan,
          steps: [{
            title: draft.operation.type === 'image.generate' ? '生成图片' : '编辑图片',
            operation: draft.operation.generation.action,
          }],
          generation: draft.operation.generation,
          policyVersion: LEGACY_POLICY_VERSION,
        };
      }
      db.insertPlan(plan, session.id, orderedUploads);
      reply.header('etag', `"${plan.version}"`).header('cache-control', 'no-store').status(201);
      return { data: plan };
    } catch (error) {
      await Promise.all(uploads.map((asset) => assetStore.remove(asset)));
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/plans/:id', async (request, reply) => {
    const session = getOrCreateSession(request, reply, config);
    const plan = db.getPlan(request.params.id, session.id);
    reply.header('etag', `"${plan.version}"`).header('cache-control', 'no-store');
    return { data: plan };
  });

  app.post<{ Params: { id: string } }>('/v1/plans/:id/execute', async (request, reply) => {
    const session = sessionForMutation(request, reply, config);
    ensureEmptyBody(request);
    const expectedVersion = parseIfMatch(request.headers['if-match']);
    const plan = db.getPlan(request.params.id, session.id);
    if (plan.version !== expectedVersion) {
      throw new AppError(412, 'plan_version_mismatch', '计划版本已变化，请重新查看');
    }
    if (plan.status === 'expired') throw new AppError(410, 'plan_expired', '计划已过期');
    if (isToolAgentPlan(plan)) {
      const composerSnapshotHash = parseComposerSnapshotHeader(request.headers['x-composer-snapshot-hash']);
      if (!composerSnapshotHash) {
        throw new AppError(428, 'composer_snapshot_hash_required', '确认执行必须携带 Composer 快照哈希');
      }
      if (composerSnapshotHash !== plan.composerSnapshotHash) {
        throw new AppError(412, 'composer_snapshot_mismatch', 'Composer 输入已变化，旧计划不可确认');
      }
    }
    const existing = db.findExecutionByPlan(request.params.id, session.id);
    if (existing) {
      reply.header('cache-control', 'no-store');
      return { data: existing };
    }
    if (getPlanOperation(plan).type === 'openshop.edit') {
      throw new AppError(409, 'client_operation_requires_browser', 'OpenShop 编辑必须由当前浏览器确认后执行');
    }
    const generation = getImageGeneration(plan)!;
    const releaseExecuteRate = rateLimiter.consume(`execute:${session.id}`, config.executeRatePerMinute, 60_000);
    let releaseImageRate: (() => void) | undefined;
    let result: ReturnType<GatewayDatabase['createExecution']>;
    try {
      releaseImageRate = rateLimiter.consume(`images:${session.id}`, config.imagesRatePerHour, 3_600_000, generation.imageCount);
      result = db.createExecution(request.params.id, session.id, expectedVersion);
      if (!result.created) {
        releaseExecuteRate();
        releaseImageRate();
      }
    } catch (error) {
      releaseExecuteRate();
      releaseImageRate?.();
      throw error;
    }
    if (result.created) {
      worker.notify();
      reply.status(202);
    }
    reply.header('cache-control', 'no-store');
    return { data: result.execution };
  });

  app.get<{ Params: { id: string } }>('/v1/executions/:id', async (request, reply) => {
    const session = getOrCreateSession(request, reply, config);
    reply.header('cache-control', 'no-store');
    return { data: db.getExecution(request.params.id, session.id) };
  });

  app.post<{ Params: { id: string } }>('/v1/executions/:id/cancel', async (request, reply) => {
    const session = sessionForMutation(request, reply, config);
    ensureEmptyBody(request);
    const execution = db.requestCancellation(request.params.id, session.id);
    if (execution.status === 'executing') worker.abort(execution.id);
    events.emitState(execution);
    reply.header('cache-control', 'no-store');
    return { data: execution };
  });

  app.get<{ Params: { id: string } }>('/v1/assets/:id', async (request, reply) => {
    const session = getOrCreateSession(request, reply, config);
    const asset = db.getAsset(request.params.id, session.id);
    reply.header('content-type', asset.mimeType);
    reply.header('content-length', asset.byteSize);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(assetStore.createReadStream(asset));
  });

  app.get<{ Params: { id: string } }>('/v1/executions/:id/events', async (request, reply) => {
    const session = getOrCreateSession(request, reply, config);
    const current = db.getExecution(request.params.id, session.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const writeEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    writeEvent(current.status === 'executing' ? 'execution.started' : `execution.${current.status}`, {
      executionId: current.id,
      planId: current.planId,
      status: current.status,
      updatedAt: current.updatedAt,
    });
    const unsubscribe = events.subscribe(current.id, writeEvent);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({ config });
  const shutdown = async () => {
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await app.listen({ host: config.host, port: config.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // 配置错误时不启动任何监听，保持 fail closed。
    process.stderr.write(`受限 Agent Gateway 启动失败: ${error instanceof Error ? error.message : '未知错误'}\n`);
    process.exitCode = 1;
  });
}
