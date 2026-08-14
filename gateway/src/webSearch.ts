import type { GatewayConfig } from './config.js';

export interface WebSearchSource {
  title: string;
  url: string;
  description: string;
  engine: string;
}

export interface WebSearchService {
  search(query: string): Promise<WebSearchSource[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSource(value: unknown): WebSearchSource | null {
  if (!isRecord(value)
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.description !== 'string'
    || typeof value.engine !== 'string') return null;
  const title = value.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  const description = value.description.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  const engine = value.engine.replace(/\s+/g, ' ').trim().slice(0, 64);
  if (!title || !engine) return null;
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { title, url: url.toString(), description, engine };
  } catch {
    return null;
  }
}

export class OpenWebSearchService implements WebSearchService {
  constructor(private readonly config: GatewayConfig) {}

  async search(query: string): Promise<WebSearchSource[]> {
    if (!this.config.webSearchEnabled || !this.config.webSearchBaseUrl) {
      throw new Error('联网搜索服务未启用');
    }
    const response = await fetch(`${this.config.webSearchBaseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query: query.slice(0, 4_000),
        limit: this.config.webSearchMaxResults,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.webSearchTimeoutMs),
    });
    if (!response.ok) throw new Error(`联网搜索服务返回 HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.status !== 'ok' || !isRecord(payload.data) || !Array.isArray(payload.data.results)) {
      throw new Error('联网搜索服务返回格式无效');
    }
    const seen = new Set<string>();
    const sources: WebSearchSource[] = [];
    for (const item of payload.data.results) {
      const source = normalizeSource(item);
      if (!source || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
      if (sources.length >= this.config.webSearchMaxResults) break;
    }
    return sources;
  }
}
