import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import sharp from 'sharp';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import type { AssetRole, FinalOutputSpec, ImageTransform, StoredAsset } from './types.js';

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

function mimeForFormat(format: string): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionForFormat(format: 'png' | 'jpeg' | 'webp'): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function transformPosition(position: ImageTransform['position']): 'centre' | 'left' | 'right' | 'top' | 'bottom' {
  return position === 'center' || position === undefined ? 'centre' : position;
}

function outputBackground(transform: ImageTransform): string | { r: number; g: number; b: number; alpha: number } | undefined {
  if (transform.background) return transform.background;
  if (transform.fit !== 'contain') return undefined;
  return transform.outputFormat === 'jpeg'
    ? '#ffffff'
    : { r: 0, g: 0, b: 0, alpha: 0 };
}

function isExpectedFormat(format: string | undefined, expected: FinalOutputSpec['outputFormat']): boolean {
  return expected === undefined || format === expected;
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

  /**
   * 对已持久化资产执行确定性后处理。每次调用都创建新文件，绝不覆盖输入资产。
   * Sharp 操作顺序固定为 crop → rotate → flip → resize → encode。
   */
  async transform(
    input: StoredAsset,
    context: Pick<StoredAsset, 'sessionId' | 'planId' | 'executionId'>,
    transform: ImageTransform,
  ): Promise<StoredAsset> {
    const id = randomUUID();
    const extension = extensionForFormat(transform.outputFormat);
    const temporaryPath = path.join(this.config.assetsDir, `.${id}.${extension}`);
    const finalPath = path.join(this.config.assetsDir, `${id}.${extension}`);
    try {
      const inputBytes = await readFile(input.storagePath);
      const inputMetadata = await sharp(inputBytes, {
        limitInputPixels: this.config.maxImagePixels,
        animated: false,
        failOn: 'error',
      }).metadata();
      if (!inputMetadata.format || !ALLOWED_FORMATS.has(inputMetadata.format) || !inputMetadata.width || !inputMetadata.height) {
        throw new AppError(422, 'invalid_transform_input', '变换输入不是有效的 PNG、JPEG 或 WebP 图片');
      }
      if (inputMetadata.width * inputMetadata.height > this.config.maxImagePixels) {
        throw new AppError(413, 'too_many_pixels', '变换输入图片像素数量超过限制');
      }

      const sharpOptions = {
        limitInputPixels: this.config.maxImagePixels,
        animated: false,
        failOn: 'error',
      } as const;
      let image = sharp(inputBytes, sharpOptions);
      if (transform.crop) {
        const cropped = await image.extract({
          left: transform.crop.x,
          top: transform.crop.y,
          width: transform.crop.width,
          height: transform.crop.height,
        }).png().toBuffer();
        image = sharp(cropped, sharpOptions);
      }
      if (transform.rotate) {
        const rotated = await image.rotate(transform.rotate).png().toBuffer();
        image = sharp(rotated, sharpOptions);
      }
      if (transform.flip === 'horizontal') {
        const flipped = await image.flop().png().toBuffer();
        image = sharp(flipped, sharpOptions);
      }
      if (transform.flip === 'vertical') {
        const flipped = await image.flip().png().toBuffer();
        image = sharp(flipped, sharpOptions);
      }
      if (transform.width !== undefined && transform.height !== undefined) {
        const resized = await image.resize({
          width: transform.width,
          height: transform.height,
          fit: transform.fit ?? 'cover',
          position: transformPosition(transform.position),
          background: outputBackground(transform),
        }).png().toBuffer();
        image = sharp(resized, sharpOptions);
      }
      if (transform.outputFormat === 'jpeg') image = image.jpeg({ quality: transform.outputCompression ?? 90 });
      else if (transform.outputFormat === 'webp') image = image.webp({ quality: transform.outputCompression ?? 90 });
      else image = image.png({ compressionLevel: 9 });
      await image.toFile(temporaryPath);
      await rename(temporaryPath, finalPath);

      const bytes = await readFile(finalPath);
      if (bytes.byteLength > this.config.maxFileBytes * 2) {
        throw new AppError(413, 'transformed_file_too_large', '变换后的图片大小超过限制');
      }
      const metadata = await sharp(bytes, {
        limitInputPixels: this.config.maxImagePixels,
        animated: false,
        failOn: 'error',
      }).metadata();
      if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
        throw new AppError(500, 'invalid_transform_output', '变换后未生成有效图片');
      }
      if (metadata.width * metadata.height > this.config.maxImagePixels) {
        throw new AppError(413, 'too_many_pixels', '变换后的图片像素数量超过限制');
      }
      return {
        id,
        planId: context.planId,
        executionId: context.executionId,
        sessionId: context.sessionId,
        direction: 'output',
        role: 'generated',
        mimeType: mimeForFormat(metadata.format),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        storagePath: finalPath,
        byteSize: bytes.byteLength,
        width: metadata.width,
        height: metadata.height,
        expiresAt: Date.now() + this.config.assetTtlSeconds * 1000,
        createdAt: Date.now(),
      };
    } catch (error) {
      await Promise.all([rm(temporaryPath, { force: true }), rm(finalPath, { force: true })]);
      if (error instanceof AppError) throw error;
      throw new AppError(422, 'transform_failed', '无法按指定规格处理图片');
    }
  }

  /** 直接读取磁盘中的实际图片 metadata，不信任数据库中的宽高、格式或 alpha 字段。 */
  async assertMetadata(asset: StoredAsset, expected: FinalOutputSpec): Promise<void> {
    try {
      const bytes = await readFile(asset.storagePath);
      const metadata = await sharp(bytes, {
        limitInputPixels: this.config.maxImagePixels,
        animated: false,
        failOn: 'error',
      }).metadata();
      if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
        throw new AppError(422, 'metadata_assertion_failed', '最终产物不是有效的 PNG、JPEG 或 WebP 图片');
      }
      const mismatches: string[] = [];
      if (expected.width !== undefined && metadata.width !== expected.width) mismatches.push('宽度');
      if (expected.height !== undefined && metadata.height !== expected.height) mismatches.push('高度');
      if (!isExpectedFormat(metadata.format, expected.outputFormat)) mismatches.push('格式');
      if (expected.transparent !== undefined && Boolean(metadata.hasAlpha) !== expected.transparent) mismatches.push('透明通道');
      if (mismatches.length > 0) {
        throw new AppError(422, 'metadata_assertion_failed', `最终产物不符合规格：${mismatches.join('、')}`);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(422, 'metadata_assertion_failed', '无法读取最终产物的真实 metadata');
    }
  }

  createReadStream(asset: StoredAsset) {
    return createReadStream(asset.storagePath);
  }

  async remove(asset: Pick<StoredAsset, 'storagePath'>): Promise<void> {
    await rm(asset.storagePath, { force: true });
  }
}
