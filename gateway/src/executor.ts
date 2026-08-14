import { readFile } from 'node:fs/promises';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import type { GenerationPlan, StoredAsset } from './types.js';

export interface GenerationExecutorInput {
  generation: GenerationPlan;
  assets: StoredAsset[];
  signal: AbortSignal;
}

export interface ImageExecutor {
  executeGeneration(input: GenerationExecutorInput): Promise<Buffer[]>;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string }>;
}

export class DeterministicImagesExecutor implements ImageExecutor {
  constructor(private readonly config: GatewayConfig) {}

  async executeGeneration({ generation, assets, signal }: GenerationExecutorInput): Promise<Buffer[]> {
    const timeoutSignal = AbortSignal.timeout(this.config.executorTimeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    const endpoint = generation.action === 'generate' ? '/images/generations' : '/images/edits';
    let body: BodyInit;
    let headers: Record<string, string> = { authorization: `Bearer ${this.config.apiKey}` };

    if (generation.action === 'generate') {
      headers = { ...headers, 'content-type': 'application/json' };
      body = JSON.stringify({
        model: this.config.imageModel,
        prompt: generation.exactPrompt,
        size: generation.size,
        quality: generation.quality,
        n: generation.imageCount,
        output_format: generation.outputFormat,
        ...(generation.outputCompression === null ? {} : { output_compression: generation.outputCompression }),
        response_format: 'b64_json',
      });
    } else {
      const form = new FormData();
      form.set('model', this.config.imageModel);
      form.set('prompt', generation.exactPrompt);
      form.set('size', generation.size);
      form.set('quality', generation.quality);
      form.set('n', String(generation.imageCount));
      form.set('output_format', generation.outputFormat);
      if (generation.outputCompression !== null) form.set('output_compression', String(generation.outputCompression));
      form.set('response_format', 'b64_json');
      const editable = assets
        .filter((asset) => asset.role === 'reference' || asset.role === 'mask_target')
        .sort((left, right) => Number(right.role === 'mask_target') - Number(left.role === 'mask_target'));
      for (const [index, asset] of editable.entries()) {
        const blob = new Blob([await readFile(asset.storagePath)], { type: asset.mimeType });
        form.append('image[]', blob, `input-${index}.png`);
      }
      const mask = assets.find((asset) => asset.role === 'mask');
      if (mask) {
        const blob = new Blob([await readFile(mask.storagePath)], { type: mask.mimeType });
        form.set('mask', blob, 'mask.png');
      }
      body = form;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.upstreamBaseUrl}${endpoint}`, {
        method: 'POST', headers, body, redirect: 'error', signal: combinedSignal,
      });
    } catch {
      if (signal.aborted) throw new AppError(499, 'execution_cancelled', '执行已取消');
      if (timeoutSignal.aborted) throw new AppError(504, 'executor_timeout', '图片生成请求超时');
      throw new AppError(502, 'executor_unavailable', '图片上游无法连接');
    }
    if (!response.ok) {
      throw new AppError(502, 'executor_upstream_error', `图片上游返回 HTTP ${response.status}`);
    }

    let payload: ImagesResponse;
    try {
      payload = await response.json() as ImagesResponse;
    } catch {
      throw new AppError(502, 'invalid_executor_response', '图片上游返回了无效 JSON');
    }
    if (!Array.isArray(payload.data) || payload.data.length !== generation.imageCount) {
      throw new AppError(502, 'invalid_output_count', '图片上游返回数量与确认计划不一致');
    }
    return payload.data.map((item) => {
      if (!item.b64_json || typeof item.b64_json !== 'string') {
        throw new AppError(502, 'missing_image_data', '图片上游未返回内嵌图片数据');
      }
      const buffer = Buffer.from(item.b64_json, 'base64');
      if (buffer.byteLength < 1 || buffer.byteLength > this.config.maxFileBytes * 2) {
        throw new AppError(502, 'invalid_image_size', '图片上游返回大小异常');
      }
      return buffer;
    });
  }
}
