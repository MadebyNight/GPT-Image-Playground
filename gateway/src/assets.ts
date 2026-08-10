import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import sharp from 'sharp';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import type { AssetRole, StoredAsset } from './types.js';

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

function mimeForFormat(format: string): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

export class AssetStore {
  constructor(private readonly config: GatewayConfig) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.assetsDir, { recursive: true });
  }

  async storeUpload(file: MultipartFile, sessionId: string, role: Exclude<AssetRole, 'generated'>): Promise<StoredAsset & { uploadedByteSize: number }> {
    const id = randomUUID();
    const temporaryPath = path.join(this.config.assetsDir, `.${id}.upload`);
    const normalizedPath = path.join(this.config.assetsDir, `${id}.png`);
    try {
      await pipeline(file.file, createWriteStream(temporaryPath, { flags: 'wx' }));
      if (file.file.truncated) {
        throw new AppError(413, 'file_too_large', `单个图片不得超过 ${this.config.maxFileBytes} 字节`);
      }
      const fileStat = await stat(temporaryPath);
      if (fileStat.size < 1 || fileStat.size > this.config.maxFileBytes) {
        throw new AppError(413, 'file_too_large', `单个图片不得超过 ${this.config.maxFileBytes} 字节`);
      }
      const sourceBytes = await readFile(temporaryPath);

      const image = sharp(temporaryPath, { limitInputPixels: this.config.maxImagePixels, animated: false, failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
        throw new AppError(415, 'unsupported_image', '仅支持真实的 PNG、JPEG 或 WebP 图片');
      }
      if (metadata.width * metadata.height > this.config.maxImagePixels) {
        throw new AppError(413, 'too_many_pixels', '图片像素数量超过限制');
      }

      const outputInfo = await image.rotate().png({ compressionLevel: 9 }).toFile(normalizedPath);
      const normalized = await readFile(normalizedPath);
      if (normalized.byteLength > this.config.maxFileBytes) {
        throw new AppError(413, 'normalized_file_too_large', '图片规范化后的大小超过限制');
      }
      return {
        id,
        planId: null,
        executionId: null,
        sessionId,
        direction: 'input',
        role,
        mimeType: 'image/png',
        sha256: createHash('sha256').update(normalized).digest('hex'),
        sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
        storagePath: normalizedPath,
        byteSize: normalized.byteLength,
        width: outputInfo.width,
        height: outputInfo.height,
        expiresAt: Date.now() + this.config.assetTtlSeconds * 1000,
        createdAt: Date.now(),
        uploadedByteSize: fileStat.size,
      };
    } catch (error) {
      await Promise.all([rm(temporaryPath, { force: true }), rm(normalizedPath, { force: true })]);
      if (error instanceof AppError) throw error;
      throw new AppError(400, 'invalid_image', '无法读取或规范化上传图片');
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async storeGenerated(
    buffer: Buffer,
    sessionId: string,
    planId: string,
    executionId: string,
    format: 'png' | 'jpeg' | 'webp',
    compression: number | null,
  ): Promise<StoredAsset> {
    const id = randomUUID();
    const extension = format === 'jpeg' ? 'jpg' : format;
    const temporaryPath = path.join(this.config.assetsDir, `.${id}.output`);
    const finalPath = path.join(this.config.assetsDir, `${id}.${extension}`);
    try {
      const image = sharp(buffer, { limitInputPixels: this.config.maxImagePixels, animated: false, failOn: 'error' });
      const metadata = await image.metadata();
      if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
        throw new AppError(502, 'invalid_upstream_image', '上游返回了无效图片');
      }
      if (metadata.width * metadata.height > this.config.maxImagePixels) {
        throw new AppError(502, 'upstream_image_too_large', '上游图片像素数量超过限制');
      }

      let transformed = image.rotate();
      if (format === 'jpeg') transformed = transformed.jpeg({ quality: compression ?? 90 });
      else if (format === 'webp') transformed = transformed.webp({ quality: compression ?? 90 });
      else transformed = transformed.png({ compressionLevel: 9 });
      await transformed.toFile(temporaryPath);
      await rename(temporaryPath, finalPath);
      const normalized = await readFile(finalPath);
      if (normalized.byteLength > this.config.maxFileBytes * 2) {
        throw new AppError(502, 'upstream_image_too_large', '上游图片规范化后的大小超过限制');
      }
      const outputMetadata = await sharp(normalized).metadata();
      return {
        id,
        planId,
        executionId,
        sessionId,
        direction: 'output',
        role: 'generated',
        mimeType: mimeForFormat(format),
        sha256: createHash('sha256').update(normalized).digest('hex'),
        storagePath: finalPath,
        byteSize: normalized.byteLength,
        width: outputMetadata.width ?? metadata.width,
        height: outputMetadata.height ?? metadata.height,
        expiresAt: Date.now() + this.config.assetTtlSeconds * 1000,
        createdAt: Date.now(),
      };
    } catch (error) {
      await Promise.all([rm(temporaryPath, { force: true }), rm(finalPath, { force: true })]);
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'invalid_upstream_image', '无法处理上游返回的图片');
    }
  }

  createReadStream(asset: StoredAsset) {
    return createReadStream(asset.storagePath);
  }

  async remove(asset: Pick<StoredAsset, 'storagePath'>): Promise<void> {
    await rm(asset.storagePath, { force: true });
  }
}
