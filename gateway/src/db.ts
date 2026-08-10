import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import DatabaseConstructor from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import { decodeRestrictedAgentPlanSnapshot, getPlanOperation } from './plan.js';
import type {
  ExecutionStatus,
  ExecutionView,
  RestrictedAgentPlanSnapshot,
  StoredAsset,
} from './types.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  expires_at INTEGER NOT NULL, original_request TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  policy_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_session_idx ON plans(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id), session_id TEXT NOT NULL,
  status TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executions(status, created_at);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, plan_id TEXT REFERENCES plans(id), execution_id TEXT REFERENCES executions(id),
  session_id TEXT NOT NULL, direction TEXT NOT NULL, role TEXT NOT NULL, mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_plan_idx ON assets(plan_id, direction);
CREATE INDEX IF NOT EXISTS assets_execution_idx ON assets(execution_id, direction);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_events(entity_type, entity_id, id);
`;

interface PlanRow {
  id: string; session_id: string; version: number; status: string; expires_at: number;
  snapshot_json: string; created_at: number; updated_at: number;
}

interface ExecutionRow {
  id: string; plan_id: string; session_id: string; status: ExecutionStatus; cancel_requested: number;
  error_code: string | null; error_message: string | null; created_at: number; started_at: number | null;
  completed_at: number | null; updated_at: number;
}

interface AssetRow {
  id: string; plan_id: string | null; execution_id: string | null; session_id: string;
  direction: 'input' | 'output'; role: StoredAsset['role']; mime_type: string; sha256: string;
  storage_path: string; byte_size: number; width: number; height: number; expires_at: number; created_at: number;
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function mapAsset(row: AssetRow): StoredAsset {
  return {
    id: row.id, planId: row.plan_id, executionId: row.execution_id, sessionId: row.session_id,
    direction: row.direction, role: row.role, mimeType: row.mime_type, sha256: row.sha256,
    storagePath: row.storage_path, byteSize: row.byte_size, width: row.width, height: row.height,
    expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

export class GatewayDatabase {
  readonly raw: DatabaseType;

  constructor(private readonly config: GatewayConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.raw = new DatabaseConstructor(config.dbPath);
    this.raw.pragma('busy_timeout = 5000');
    this.raw.exec(SCHEMA);
  }

  close(): void {
    this.raw.close();
  }

  recoverInterruptedExecutions(now = Date.now()): number {
    return this.raw.transaction(() => {
      const rows = this.raw.prepare("SELECT id, plan_id, session_id FROM executions WHERE status = 'executing'").all() as Array<{id: string; plan_id: string; session_id: string}>;
      const updateExecution = this.raw.prepare("UPDATE executions SET status = 'failed_unknown', error_code = 'gateway_restarted', error_message = 'Gateway 在上游调用期间重启，任务不会自动重试', completed_at = ?, updated_at = ? WHERE id = ?");
      const updatePlan = this.raw.prepare("UPDATE plans SET status = 'failed_unknown', updated_at = ? WHERE id = ?");
      for (const row of rows) {
        updateExecution.run(now, now, row.id);
        updatePlan.run(now, row.plan_id);
        this.audit(row.session_id, 'execution', row.id, 'execution.failed_unknown', { reason: 'gateway_restarted' }, now);
      }
      return rows.length;
    })();
  }

  insertPlan(plan: RestrictedAgentPlanSnapshot, sessionId: string, assets: StoredAsset[], now = Date.now()): void {
    this.raw.transaction(() => {
      this.raw.prepare(`INSERT INTO plans
        (id, session_id, version, status, expires_at, original_request, snapshot_json, policy_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(plan.id, sessionId, plan.version, plan.status, Date.parse(plan.expiresAt), plan.originalRequest, JSON.stringify(plan), plan.policyVersion, now, now);
      const insertAsset = this.raw.prepare(`INSERT INTO assets
        (id, plan_id, execution_id, session_id, direction, role, mime_type, sha256, storage_path, byte_size, width, height, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const asset of assets) {
        insertAsset.run(asset.id, plan.id, null, sessionId, asset.direction, asset.role, asset.mimeType, asset.sha256,
          asset.storagePath, asset.byteSize, asset.width, asset.height, asset.expiresAt, asset.createdAt);
      }
      const operation = getPlanOperation(plan);
      this.audit(sessionId, 'plan', plan.id, 'plan.created', operation.type !== 'openshop.edit'
        ? {
            promptSha256: createHash('sha256').update(operation.generation.exactPrompt).digest('hex'),
            promptLength: operation.generation.exactPrompt.length,
            action: operation.generation.action,
            operation: operation.type,
            imageCount: operation.generation.imageCount,
          }
        : {
            operation: operation.type,
            inputAssetId: operation.inputAssetId,
            commands: operation.commands.map((command) => command.id),
          }, now);
    })();
  }

  getPlan(id: string, sessionId: string, now = Date.now()): RestrictedAgentPlanSnapshot {
    let row = this.raw.prepare('SELECT * FROM plans WHERE id = ? AND session_id = ?').get(id, sessionId) as PlanRow | undefined;
    if (!row) throw new AppError(404, 'plan_not_found', '计划不存在');
    if (row.status === 'awaiting_confirmation' && row.expires_at <= now) {
      this.raw.prepare("UPDATE plans SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'").run(now, id);
      row = { ...row, status: 'expired', updated_at: now };
    }
    const snapshot = decodeRestrictedAgentPlanSnapshot(JSON.parse(row.snapshot_json));
    return { ...snapshot, status: row.status as RestrictedAgentPlanSnapshot['status'] };
  }

  getPlanForWorker(id: string): RestrictedAgentPlanSnapshot {
    const row = this.raw.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    if (!row) throw new AppError(404, 'plan_not_found', '计划不存在');
    return {
      ...decodeRestrictedAgentPlanSnapshot(JSON.parse(row.snapshot_json)),
      status: row.status as RestrictedAgentPlanSnapshot['status'],
    };
  }

  getPlanAssets(planId: string, sessionId?: string): StoredAsset[] {
    const rows = sessionId
      ? this.raw.prepare("SELECT * FROM assets WHERE plan_id = ? AND session_id = ? AND direction = 'input' ORDER BY created_at").all(planId, sessionId)
      : this.raw.prepare("SELECT * FROM assets WHERE plan_id = ? AND direction = 'input' ORDER BY created_at").all(planId);
    return (rows as AssetRow[]).map(mapAsset);
  }

  createExecution(planId: string, sessionId: string, expectedVersion: number, now = Date.now()): { execution: ExecutionView; created: boolean } {
    const executionId = randomUUID();
    return this.raw.transaction(() => {
      const plan = this.raw.prepare('SELECT * FROM plans WHERE id = ? AND session_id = ?').get(planId, sessionId) as PlanRow | undefined;
      if (!plan) throw new AppError(404, 'plan_not_found', '计划不存在');
      const existing = this.raw.prepare('SELECT * FROM executions WHERE plan_id = ? AND session_id = ?').get(planId, sessionId) as ExecutionRow | undefined;
      if (existing) return { execution: this.mapExecution(existing), created: false };
      if (plan.version !== expectedVersion) throw new AppError(412, 'plan_version_mismatch', '计划版本已变化，请重新查看');
      if (plan.expires_at <= now) {
        this.raw.prepare("UPDATE plans SET status = 'expired', updated_at = ? WHERE id = ?").run(now, planId);
        throw new AppError(410, 'plan_expired', '计划已过期');
      }
      if (plan.status !== 'awaiting_confirmation') throw new AppError(409, 'plan_not_executable', '计划当前状态不可执行');
      const queued = this.raw.prepare("SELECT COUNT(*) AS count FROM executions WHERE status = 'queued'").get() as { count: number };
      if (queued.count >= this.config.maxQueue) throw new AppError(503, 'queue_full', '执行队列已满');
      this.raw.prepare(`INSERT INTO executions
        (id, plan_id, session_id, status, cancel_requested, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', 0, ?, ?)`)
        .run(executionId, planId, sessionId, now, now);
      this.raw.prepare("UPDATE plans SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'").run(now, planId);
      this.audit(sessionId, 'execution', executionId, 'execution.queued', {}, now);
      return { execution: this.getExecution(executionId, sessionId), created: true };
    })();
  }

  getExecution(id: string, sessionId: string): ExecutionView {
    const row = this.raw.prepare('SELECT * FROM executions WHERE id = ? AND session_id = ?').get(id, sessionId) as ExecutionRow | undefined;
    if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
    return this.mapExecution(row);
  }

  findExecutionByPlan(planId: string, sessionId: string): ExecutionView | null {
    const row = this.raw.prepare('SELECT * FROM executions WHERE plan_id = ? AND session_id = ?').get(planId, sessionId) as ExecutionRow | undefined;
    return row ? this.mapExecution(row) : null;
  }

  getExecutionForWorker(id: string): ExecutionView {
    const row = this.raw.prepare('SELECT * FROM executions WHERE id = ?').get(id) as ExecutionRow | undefined;
    if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
    return this.mapExecution(row);
  }

  getExecutionSessionId(id: string): string {
    const row = this.raw.prepare('SELECT session_id FROM executions WHERE id = ?').get(id) as { session_id: string } | undefined;
    if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
    return row.session_id;
  }

  claimNextExecution(now = Date.now()): ExecutionView | null {
    return this.raw.transaction(() => {
      const active = this.raw.prepare("SELECT COUNT(*) AS count FROM executions WHERE status = 'executing'").get() as { count: number };
      if (active.count >= this.config.maxConcurrency) return null;
      const row = this.raw.prepare("SELECT * FROM executions WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as ExecutionRow | undefined;
      if (!row) return null;
      const changed = this.raw.prepare("UPDATE executions SET status = 'executing', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, row.id);
      if (changed.changes !== 1) return null;
      this.raw.prepare("UPDATE plans SET status = 'executing', updated_at = ? WHERE id = ?").run(now, row.plan_id);
      this.audit(row.session_id, 'execution', row.id, 'execution.started', {}, now);
      return this.getExecutionForWorker(row.id);
    })();
  }

  insertOutputAssets(assets: StoredAsset[]): void {
    this.raw.transaction(() => {
      const insert = this.raw.prepare(`INSERT INTO assets
        (id, plan_id, execution_id, session_id, direction, role, mime_type, sha256, storage_path, byte_size, width, height, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const asset of assets) {
        insert.run(asset.id, asset.planId, asset.executionId, asset.sessionId, asset.direction, asset.role, asset.mimeType, asset.sha256,
          asset.storagePath, asset.byteSize, asset.width, asset.height, asset.expiresAt, asset.createdAt);
        this.audit(asset.sessionId, 'asset', asset.id, 'asset.ready', { executionId: asset.executionId, mimeType: asset.mimeType, byteSize: asset.byteSize }, asset.createdAt);
      }
    })();
  }

  finishExecution(id: string, status: Extract<ExecutionStatus, 'completed' | 'failed' | 'cancelled' | 'failed_unknown'>, error?: { code: string; message: string }, now = Date.now()): ExecutionView {
    return this.raw.transaction(() => {
      const row = this.raw.prepare('SELECT * FROM executions WHERE id = ?').get(id) as ExecutionRow | undefined;
      if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
      if (!['executing', 'queued'].includes(row.status)) return this.mapExecution(row);
      this.raw.prepare(`UPDATE executions SET status = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(status, error?.code ?? null, error?.message ?? null, now, now, id);
      this.raw.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.plan_id);
      this.audit(row.session_id, 'execution', id, `execution.${status}`, error ? { errorCode: error.code } : {}, now);
      return this.getExecutionForWorker(id);
    })();
  }

  requestCancellation(id: string, sessionId: string, now = Date.now()): ExecutionView {
    return this.raw.transaction(() => {
      const row = this.raw.prepare('SELECT * FROM executions WHERE id = ? AND session_id = ?').get(id, sessionId) as ExecutionRow | undefined;
      if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
      if (row.status === 'queued') return this.finishExecution(id, 'cancelled', undefined, now);
      if (row.status === 'executing') {
        this.raw.prepare('UPDATE executions SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now, id);
        this.audit(sessionId, 'execution', id, 'execution.cancel_requested', {}, now);
      }
      return this.getExecution(id, sessionId);
    })();
  }

  isCancellationRequested(id: string): boolean {
    const row = this.raw.prepare('SELECT cancel_requested FROM executions WHERE id = ?').get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  getAsset(id: string, sessionId: string): StoredAsset {
    const row = this.raw.prepare('SELECT * FROM assets WHERE id = ? AND session_id = ?').get(id, sessionId) as AssetRow | undefined;
    if (!row) throw new AppError(404, 'asset_not_found', '资源不存在');
    if (row.expires_at <= Date.now()) throw new AppError(410, 'asset_expired', '资源已过期');
    return mapAsset(row);
  }

  listExpiredAssets(now = Date.now()): StoredAsset[] {
    const rows = this.raw.prepare(`SELECT a.* FROM assets a
      LEFT JOIN plans p ON p.id = a.plan_id
      WHERE a.expires_at <= ? AND (p.status IS NULL OR p.status NOT IN ('queued', 'executing'))`).all(now) as AssetRow[];
    return rows.map(mapAsset);
  }

  deleteAssetRecord(id: string): void {
    this.raw.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  private mapExecution(row: ExecutionRow): ExecutionView {
    const assets = this.raw.prepare("SELECT * FROM assets WHERE execution_id = ? AND direction = 'output' ORDER BY created_at").all(row.id) as AssetRow[];
    return {
      id: row.id,
      planId: row.plan_id,
      status: row.status,
      cancelRequested: row.cancel_requested === 1,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? '执行失败' } : null,
      outputAssets: assets.map((asset) => ({
        id: asset.id, url: `/agent-api/v1/assets/${asset.id}`, mimeType: asset.mime_type, sha256: asset.sha256,
        width: asset.width, height: asset.height, byteSize: asset.byte_size,
      })),
      createdAt: iso(row.created_at)!,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      updatedAt: iso(row.updated_at)!,
    };
  }

  private audit(sessionId: string, entityType: string, entityId: string, eventType: string, metadata: object, now: number): void {
    this.raw.prepare(`INSERT INTO audit_events
      (session_id, entity_type, entity_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, entityType, entityId, eventType, JSON.stringify(metadata), now);
  }
}
