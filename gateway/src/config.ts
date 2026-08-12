import path from 'node:path';
import { z } from 'zod';

const numberFromEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  AGENT_HOST: z.string().min(1).default('0.0.0.0'),
  AGENT_PORT: numberFromEnv(3000, 1, 65535),
  AGENT_PUBLIC_ORIGIN: z.string().url(),
  AGENT_SESSION_SECRET: z.string().min(32),
  AGENT_UPSTREAM_BASE_URL: z.string().url(),
  AGENT_API_KEY: z.string().min(1),
  AGENT_PLANNER_MODEL: z.string().min(1),
  AGENT_IMAGE_MODEL: z.string().min(1),
  AGENT_DATA_DIR: z.string().min(1).default('/data'),
  AGENT_PLAN_TTL_SECONDS: numberFromEnv(900, 60, 86400),
  AGENT_ASSET_TTL_SECONDS: numberFromEnv(86400, 300, 604800),
  AGENT_MAX_REFERENCE_IMAGES: numberFromEnv(16, 0, 32),
  AGENT_MAX_FILE_BYTES: numberFromEnv(20 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  AGENT_MAX_UPLOAD_BYTES: numberFromEnv(128 * 1024 * 1024, 1024, 512 * 1024 * 1024),
  AGENT_MAX_IMAGE_PIXELS: numberFromEnv(40_000_000, 1_000_000, 200_000_000),
  AGENT_MAX_OUTPUT_IMAGES: numberFromEnv(4, 1, 10),
  AGENT_MAX_QUEUE: numberFromEnv(10, 1, 1000),
  AGENT_MAX_CONCURRENCY: numberFromEnv(2, 1, 32),
  AGENT_PLAN_RATE_PER_MINUTE: numberFromEnv(5, 1, 1000),
  AGENT_EXECUTE_RATE_PER_MINUTE: numberFromEnv(2, 1, 1000),
  AGENT_IMAGES_RATE_PER_HOUR: numberFromEnv(20, 1, 10000),
  AGENT_PLANNER_TIMEOUT_MS: numberFromEnv(60_000, 1000, 300_000),
  AGENT_EXECUTOR_TIMEOUT_MS: numberFromEnv(180_000, 1000, 900_000),
  AGENT_WEB_SEARCH_ENABLED: z.enum(['true', 'false']).default('false'),
  AGENT_WEB_SEARCH_BASE_URL: z.string().url().optional(),
  AGENT_WEB_SEARCH_TIMEOUT_MS: numberFromEnv(10_000, 1_000, 60_000),
  AGENT_WEB_SEARCH_MAX_RESULTS: numberFromEnv(5, 1, 10),
  AGENT_WEB_SEARCH_RATE_PER_MINUTE: numberFromEnv(5, 1, 1000),
  AGENT_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
}).passthrough();

export interface GatewayConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicOrigin: string;
  sessionSecret: string;
  upstreamBaseUrl: string;
  apiKey: string;
  plannerModel: string;
  imageModel: string;
  dataDir: string;
  dbPath: string;
  assetsDir: string;
  planTtlSeconds: number;
  assetTtlSeconds: number;
  maxReferenceImages: number;
  maxFileBytes: number;
  maxUploadBytes: number;
  maxImagePixels: number;
  maxOutputImages: number;
  maxQueue: number;
  maxConcurrency: number;
  planRatePerMinute: number;
  executeRatePerMinute: number;
  imagesRatePerHour: number;
  plannerTimeoutMs: number;
  executorTimeoutMs: number;
  webSearchEnabled: boolean;
  webSearchBaseUrl: string | null;
  webSearchTimeoutMs: number;
  webSearchMaxResults: number;
  webSearchRatePerMinute: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'environment').join(', ');
    throw new Error(`Gateway 配置无效或缺失: ${fields}`);
  }

  const value = parsed.data;
  const origin = new URL(value.AGENT_PUBLIC_ORIGIN);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('AGENT_PUBLIC_ORIGIN 必须是纯 origin，不得包含路径、凭据、查询或片段');
  }
  const upstream = new URL(value.AGENT_UPSTREAM_BASE_URL);
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error('AGENT_UPSTREAM_BASE_URL 仅允许 http/https');
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('AGENT_UPSTREAM_BASE_URL 不得包含凭据、查询或片段');
  }
  let webSearchBaseUrl: string | null = null;
  if (value.AGENT_WEB_SEARCH_ENABLED === 'true') {
    if (!value.AGENT_WEB_SEARCH_BASE_URL) throw new Error('启用联网搜索时必须配置 AGENT_WEB_SEARCH_BASE_URL');
    const webSearch = new URL(value.AGENT_WEB_SEARCH_BASE_URL);
    if (!['http:', 'https:'].includes(webSearch.protocol) || webSearch.username || webSearch.password || webSearch.search || webSearch.hash) {
      throw new Error('AGENT_WEB_SEARCH_BASE_URL 必须是无凭据、无路径的 http/https origin');
    }
    if (webSearch.pathname !== '/') throw new Error('AGENT_WEB_SEARCH_BASE_URL 必须是纯 origin，不得包含路径');
    webSearchBaseUrl = webSearch.origin;
  }

  const dataDir = path.resolve(value.AGENT_DATA_DIR);
  return {
    nodeEnv: value.NODE_ENV,
    host: value.AGENT_HOST,
    port: value.AGENT_PORT,
    publicOrigin: origin.origin,
    sessionSecret: value.AGENT_SESSION_SECRET,
    upstreamBaseUrl: upstream.toString().replace(/\/$/, ''),
    apiKey: value.AGENT_API_KEY,
    plannerModel: value.AGENT_PLANNER_MODEL,
    imageModel: value.AGENT_IMAGE_MODEL,
    dataDir,
    dbPath: path.join(dataDir, 'gateway.sqlite'),
    assetsDir: path.join(dataDir, 'assets'),
    planTtlSeconds: value.AGENT_PLAN_TTL_SECONDS,
    assetTtlSeconds: value.AGENT_ASSET_TTL_SECONDS,
    maxReferenceImages: value.AGENT_MAX_REFERENCE_IMAGES,
    maxFileBytes: value.AGENT_MAX_FILE_BYTES,
    maxUploadBytes: value.AGENT_MAX_UPLOAD_BYTES,
    maxImagePixels: value.AGENT_MAX_IMAGE_PIXELS,
    maxOutputImages: value.AGENT_MAX_OUTPUT_IMAGES,
    maxQueue: value.AGENT_MAX_QUEUE,
    maxConcurrency: value.AGENT_MAX_CONCURRENCY,
    planRatePerMinute: value.AGENT_PLAN_RATE_PER_MINUTE,
    executeRatePerMinute: value.AGENT_EXECUTE_RATE_PER_MINUTE,
    imagesRatePerHour: value.AGENT_IMAGES_RATE_PER_HOUR,
    plannerTimeoutMs: value.AGENT_PLANNER_TIMEOUT_MS,
    executorTimeoutMs: value.AGENT_EXECUTOR_TIMEOUT_MS,
    webSearchEnabled: value.AGENT_WEB_SEARCH_ENABLED === 'true',
    webSearchBaseUrl,
    webSearchTimeoutMs: value.AGENT_WEB_SEARCH_TIMEOUT_MS,
    webSearchMaxResults: value.AGENT_WEB_SEARCH_MAX_RESULTS,
    webSearchRatePerMinute: value.AGENT_WEB_SEARCH_RATE_PER_MINUTE,
    logLevel: value.AGENT_LOG_LEVEL,
  };
}
