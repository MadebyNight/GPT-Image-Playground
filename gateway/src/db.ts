import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import DatabaseConstructor from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { GatewayConfig } from './config.js';
import { AppError } from './errors.js';
import {
  decodeRestrictedAgentPlanSnapshot,
  getPlanOperation,
  isToolAgentPlanV3,
} from './plan.js';
import type {
  ExecutionActionInsert,
  ExecutionActionStatus,
  ExecutionActionView,
  ExecutionAssetView,
  ExecutionStatus,
  ExecutionView,
  RestrictedAgentPlanSnapshot,
  StoredAsset,
  ToolAction,
  ToolAgentPlanV3Snapshot,
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

/**
 * 运行时迁移不能只依赖发布包外的 .sql 文件：容器升级时需要保证旧 SQLite
 * 数据库也能立即创建 v3 表。保持与 migrations/002-v3-actions.sql 同步。
 */
const V3_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_actions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  action_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  normalized_params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(execution_id, action_index),
  UNIQUE(execution_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS execution_actions_execution_idx ON execution_actions(execution_id, action_index);
CREATE INDEX IF NOT EXISTS execution_actions_status_idx ON execution_actions(status, created_at);
CREATE TABLE IF NOT EXISTS execution_action_artifacts (
  execution_action_id TEXT NOT NULL REFERENCES execution_actions(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('input', 'output')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(execution_action_id, relation, asset_id)
);
CREATE INDEX IF NOT EXISTS execution_action_artifacts_lookup_idx
  ON execution_action_artifacts(execution_action_id, relation, created_at);
`;

const V3_SCHEMA_VERSION = 3;

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

interface ExecutionActionRow {
  id: string;
  execution_id: string;
  action_index: number;
  type: ToolAction['type'];
  normalized_params_json: string;
  status: ExecutionActionStatus;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
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

function mapAssetView(row: AssetRow): ExecutionAssetView {
  return {
    id: row.id,
    url: `/agent-api/v1/assets/${row.id}`,
    mimeType: row.mime_type,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
  };
}

function parseAction(row: ExecutionActionRow): ToolAction {
  try {
    const action = JSON.parse(row.normalized_params_json) as ToolAction;
    if (!action || typeof action !== 'object' || action.type !== row.type) throw new Error('action type mismatch');
    return action;
  } catch {
    throw new AppError(500, 'invalid_execution_action', '执行 action 持久化数据无效');
  }
}

function actionIdempotencyKey(executionId: string, actionIndex: number, action: ToolAction): string {
  return createHash('sha256')
    .update(`${executionId}:${actionIndex}:${JSON.stringify(action)}`)
    .digest('hex');
}

export class GatewayDatabase {
  readonly raw: DatabaseType;

  constructor(private readonly config: GatewayConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.raw = new DatabaseConstructor(config.dbPath);
    this.raw.pragma('busy_timeout = 5000');
    this.raw.exec(SCHEMA);
    this.applyMigrations();
  }

  close(): void {
    this.raw.close();
  }

  recoverInterruptedExecutions(now = Date.now()): number {
    return this.raw.transaction(() => {
      const rows = this.raw.prepare("SELECT * FROM executions WHERE status = 'executing'").all() as ExecutionRow[];
      for (const row of rows) {
        const activeActions = this.raw.prepare("SELECT * FROM execution_actions WHERE execution_id = ? AND status = 'executing'")
          .all(row.id) as ExecutionActionRow[];
        const failAction = this.raw.prepare(`UPDATE execution_actions
          SET status = 'failed_unknown', error_code = 'gateway_restarted',
            error_message = 'Gateway 在 action 执行期间重启，步骤不会自动重试',
            completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'executing'`);
        for (const action of activeActions) {
          failAction.run(now, now, action.id);
          this.audit(row.session_id, 'execution_action', action.id, 'action.failed_unknown', { reason: 'gateway_restarted' }, now);
        }
        this.finishExecutionRow(
          row,
          'failed_unknown',
          {
            code: 'gateway_restarted',
            message: 'Gateway 在上游调用期间重启，任务不会自动重试',
          },
          now,
        );
      }
      return rows.length;
    })();
  }

  insertPlan(plan: RestrictedAgentPlanSnapshot, sessionId: string, assets: StoredAsset[], now = Date.now()): void {
    this.raw.transaction(() => {
      this.insertPlanRows(plan, sessionId, assets, now);
    })();
  }

  /** 将 v3 不可变计划、执行记录和所有 action 作为一个事务自动入队。 */
  insertAutoPlanAndExecution(
    plan: ToolAgentPlanV3Snapshot,
    sessionId: string,
    assets: StoredAsset[],
    now = Date.now(),
  ): { execution: ExecutionView; created: boolean } {
    return this.raw.transaction(() => {
      const existingPlan = this.raw.prepare('SELECT id, session_id FROM plans WHERE id = ?').get(plan.id) as { id: string; session_id: string } | undefined;
      if (existingPlan) {
        if (existingPlan.session_id !== sessionId) throw new AppError(404, 'plan_not_found', '计划不存在');
        const existingExecution = this.raw.prepare('SELECT * FROM executions WHERE plan_id = ? AND session_id = ?')
          .get(plan.id, sessionId) as ExecutionRow | undefined;
        if (existingExecution) return { execution: this.mapExecution(existingExecution), created: false };
        throw new AppError(409, 'auto_execution_missing', '自动计划缺少对应的执行记录');
      }

      const queued = this.raw.prepare("SELECT COUNT(*) AS count FROM executions WHERE status = 'queued'").get() as { count: number };
      if (queued.count >= this.config.maxQueue) throw new AppError(503, 'queue_full', '执行队列已满');

      const autoPlan: ToolAgentPlanV3Snapshot = { ...plan, status: 'queued' };
      const executionId = randomUUID();
      this.insertPlanRows(autoPlan, sessionId, assets, now);
      this.raw.prepare(`INSERT INTO executions
        (id, plan_id, session_id, status, cancel_requested, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', 0, ?, ?)`)
        .run(executionId, autoPlan.id, sessionId, now, now);

      const inputAssets = this.getPlanAssets(autoPlan.id, sessionId);
      for (const [actionIndex, action] of autoPlan.actions.entries()) {
        const actionRow = this.insertExecutionActionRow({
          executionId,
          actionIndex,
          action,
          status: 'queued',
        }, now);
        if (action.type === 'image.generate' || action.type === 'image.edit') {
          for (const input of inputAssets) this.linkActionArtifact(actionRow.id, 'input', input.id, now);
        }
        this.audit(sessionId, 'execution_action', actionRow.id, 'action.queued', {
          executionId,
          actionIndex,
          type: action.type,
        }, now);
      }
      this.audit(sessionId, 'execution', executionId, 'execution.queued', { automatic: true }, now);
      return { execution: this.getExecution(executionId, sessionId), created: true };
    })();
  }

  /**
   * 低层 action 写入 API 主要供迁移/测试使用；正常 v3 流程必须通过
   * insertAutoPlanAndExecution 原子地创建完整 action 链。
   */
  insertExecutionAction(input: ExecutionActionInsert, now = Date.now()): ExecutionActionView {
    return this.raw.transaction(() => this.mapExecutionAction(this.insertExecutionActionRow(input, now)))();
  }

  getExecutionActions(executionId: string, sessionId?: string): ExecutionActionView[] {
    if (sessionId) {
      const execution = this.raw.prepare('SELECT id FROM executions WHERE id = ? AND session_id = ?').get(executionId, sessionId);
      if (!execution) throw new AppError(404, 'execution_not_found', '执行记录不存在');
    }
    const rows = this.raw.prepare('SELECT * FROM execution_actions WHERE execution_id = ? ORDER BY action_index').all(executionId) as ExecutionActionRow[];
    return rows.map((row) => this.mapExecutionAction(row));
  }

  /** 获取已完成 action 的实际输出资产，供后续 action 以真实 artifact 继续执行。 */
  getActionOutputAsset(executionId: string, actionIndex: number): StoredAsset | null {
    const row = this.raw.prepare(`SELECT assets.* FROM execution_actions
      JOIN execution_action_artifacts ON execution_action_artifacts.execution_action_id = execution_actions.id
      JOIN assets ON assets.id = execution_action_artifacts.asset_id
      WHERE execution_actions.execution_id = ?
        AND execution_actions.action_index = ?
        AND execution_actions.status = 'completed'
        AND execution_action_artifacts.relation = 'output'
      ORDER BY execution_action_artifacts.created_at, assets.created_at
      LIMIT 1`)
      .get(executionId, actionIndex) as AssetRow | undefined;
    return row ? mapAsset(row) : null;
  }

  /** 原子领取当前 execution 中第一个所有前置步骤均已完成的 action。 */
  claimNextAction(executionId: string, now = Date.now()): ExecutionActionView | null {
    return this.raw.transaction(() => {
      const execution = this.getExecutionRow(executionId);
      if (execution.status !== 'executing') return null;
      const action = this.raw.prepare(`SELECT * FROM execution_actions AS candidate
        WHERE candidate.execution_id = ?
          AND candidate.status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM execution_actions AS previous
            WHERE previous.execution_id = candidate.execution_id
              AND previous.action_index < candidate.action_index
              AND previous.status <> 'completed'
          )
        ORDER BY candidate.action_index
        LIMIT 1`)
        .get(executionId) as ExecutionActionRow | undefined;
      if (!action) return null;

      this.bindActionInputs(action, execution, now);
      const changed = this.raw.prepare(`UPDATE execution_actions
        SET status = 'executing', started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'`)
        .run(now, now, action.id);
      if (changed.changes !== 1) return null;
      this.audit(execution.session_id, 'execution_action', action.id, 'action.started', {
        executionId,
        actionIndex: action.action_index,
        type: action.type,
      }, now);
      return this.mapExecutionAction(this.getExecutionActionRow(action.id));
    })();
  }

  completeAction(actionId: string, outputAssetIds: readonly string[] = [], now = Date.now()): ExecutionActionView {
    return this.raw.transaction(() => {
      const action = this.getExecutionActionRow(actionId);
      if (action.status === 'completed') return this.mapExecutionAction(action);
      if (action.status !== 'executing') {
        throw new AppError(409, 'action_not_executing', '当前 action 不处于可完成状态');
      }
      const execution = this.getExecutionRow(action.execution_id);
      const normalized = parseAction(action);
      const resolvedOutputIds = outputAssetIds.length > 0
        ? [...new Set(outputAssetIds)]
        : normalized.type === 'metadata.assert'
          ? this.getActionArtifactIds(action.id, 'input')
          : [];
      for (const assetId of resolvedOutputIds) {
        this.assertExecutionOutputAsset(execution, assetId);
        this.linkActionArtifact(action.id, 'output', assetId, now);
      }
      this.raw.prepare(`UPDATE execution_actions
        SET status = 'completed', error_code = NULL, error_message = NULL,
          completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'executing'`)
        .run(now, now, action.id);
      this.audit(execution.session_id, 'execution_action', action.id, 'action.completed', {
        executionId: execution.id,
        actionIndex: action.action_index,
        type: action.type,
      }, now);

      const incomplete = this.raw.prepare("SELECT COUNT(*) AS count FROM execution_actions WHERE execution_id = ? AND status <> 'completed'")
        .get(execution.id) as { count: number };
      if (incomplete.count === 0) this.finishExecutionRow(execution, 'completed', undefined, now);
      return this.mapExecutionAction(this.getExecutionActionRow(action.id));
    })();
  }

  failAction(actionId: string, error: { code: string; message: string }, now = Date.now()): ExecutionActionView {
    return this.raw.transaction(() => {
      const action = this.getExecutionActionRow(actionId);
      if (['completed', 'failed', 'cancelled', 'failed_unknown'].includes(action.status)) return this.mapExecutionAction(action);
      const execution = this.getExecutionRow(action.execution_id);
      this.raw.prepare(`UPDATE execution_actions
        SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'executing')`)
        .run(error.code, error.message, now, now, action.id);
      this.audit(execution.session_id, 'execution_action', action.id, 'action.failed', {
        executionId: execution.id,
        actionIndex: action.action_index,
        type: action.type,
        errorCode: error.code,
      }, now);
      this.finishExecutionRow(execution, 'failed', error, now);
      return this.mapExecutionAction(this.getExecutionActionRow(action.id));
    })();
  }

  /**
   * Gateway 关闭时，当前 action 的外部副作用是否已完成无法确定。
   * 该 action 与 execution 必须在同一事务中进入 failed_unknown，避免恢复时留下 executing 孤儿步骤。
   */
  failExecutingActionUnknown(
    executionId: string,
    error: { code: string; message: string },
    now = Date.now(),
  ): ExecutionActionView | null {
    return this.raw.transaction(() => {
      const execution = this.getExecutionRow(executionId);
      const action = this.raw.prepare(`SELECT * FROM execution_actions
        WHERE execution_id = ? AND status = 'executing'
        ORDER BY action_index
        LIMIT 1`)
        .get(executionId) as ExecutionActionRow | undefined;
      if (!action) return null;

      this.raw.prepare(`UPDATE execution_actions
        SET status = 'failed_unknown', error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'executing'`)
        .run(error.code, error.message, now, now, action.id);
      this.audit(execution.session_id, 'execution_action', action.id, 'action.failed_unknown', {
        executionId,
        actionIndex: action.action_index,
        type: action.type,
        errorCode: error.code,
      }, now);
      this.finishExecutionRow(execution, 'failed_unknown', error, now);
      return this.mapExecutionAction(this.getExecutionActionRow(action.id));
    })();
  }

  cancelAction(actionId: string, now = Date.now()): ExecutionActionView {
    return this.raw.transaction(() => {
      const action = this.getExecutionActionRow(actionId);
      if (['completed', 'failed', 'cancelled', 'failed_unknown'].includes(action.status)) return this.mapExecutionAction(action);
      const execution = this.getExecutionRow(action.execution_id);
      this.raw.prepare(`UPDATE execution_actions
        SET status = 'cancelled', error_code = 'execution_cancelled', error_message = ?,
          completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'executing')`)
        .run('执行已取消', now, now, action.id);
      this.audit(execution.session_id, 'execution_action', action.id, 'action.cancelled', {
        executionId: execution.id,
        actionIndex: action.action_index,
        reason: 'execution_cancelled',
      }, now);
      this.finishExecutionRow(execution, 'cancelled', undefined, now);
      return this.mapExecutionAction(this.getExecutionActionRow(action.id));
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
      const row = this.getExecutionRow(id);
      if (!['executing', 'queued'].includes(row.status)) return this.mapExecution(row);
      if (status === 'completed') {
        const incomplete = this.raw.prepare("SELECT COUNT(*) AS count FROM execution_actions WHERE execution_id = ? AND status <> 'completed'")
          .get(id) as { count: number };
        if (incomplete.count > 0) {
          throw new AppError(409, 'execution_actions_incomplete', 'v3 action 尚未全部完成，不能标记执行成功');
        }
      }
      this.finishExecutionRow(row, status, error, now);
      return this.getExecutionForWorker(id);
    })();
  }

  requestCancellation(id: string, sessionId: string, now = Date.now()): ExecutionView {
    return this.raw.transaction(() => {
      const row = this.raw.prepare('SELECT * FROM executions WHERE id = ? AND session_id = ?').get(id, sessionId) as ExecutionRow | undefined;
      if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
      if (row.status === 'queued') {
        this.finishExecutionRow(row, 'cancelled', undefined, now);
        return this.getExecution(id, sessionId);
      }
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

  private applyMigrations(): void {
    this.raw.transaction(() => {
      this.raw.exec(V3_ACTIONS_SCHEMA);
      const userVersion = Number(this.raw.pragma('user_version', { simple: true }));
      if (userVersion < V3_SCHEMA_VERSION) this.raw.pragma(`user_version = ${V3_SCHEMA_VERSION}`);
    })();
  }

  private insertPlanRows(plan: RestrictedAgentPlanSnapshot, sessionId: string, assets: StoredAsset[], now: number): void {
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

    if (isToolAgentPlanV3(plan)) {
      const generation = plan.actions.find((action) => action.type === 'image.generate' || action.type === 'image.edit');
      this.audit(sessionId, 'plan', plan.id, 'plan.created', {
        schemaVersion: 3,
        actionTypes: plan.actions.map((action) => action.type),
        finalOutputSpec: plan.finalOutputSpec,
        ...(generation ? {
          promptSha256: createHash('sha256').update(generation.generation.exactPrompt).digest('hex'),
          promptLength: generation.generation.exactPrompt.length,
          action: generation.generation.action,
          imageCount: generation.generation.imageCount,
        } : {}),
      }, now);
      return;
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
  }

  private insertExecutionActionRow(input: ExecutionActionInsert, now: number): ExecutionActionRow {
    this.getExecutionRow(input.executionId);
    const id = input.id ?? randomUUID();
    const normalizedParamsJson = JSON.stringify(input.action);
    const idempotencyKey = input.idempotencyKey ?? actionIdempotencyKey(input.executionId, input.actionIndex, input.action);
    this.raw.prepare(`INSERT INTO execution_actions
      (id, execution_id, action_index, type, normalized_params_json, status, idempotency_key,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.executionId,
        input.actionIndex,
        input.action.type,
        normalizedParamsJson,
        input.status ?? 'queued',
        idempotencyKey,
        now,
        now,
      );
    return this.getExecutionActionRow(id);
  }

  private getExecutionRow(id: string): ExecutionRow {
    const row = this.raw.prepare('SELECT * FROM executions WHERE id = ?').get(id) as ExecutionRow | undefined;
    if (!row) throw new AppError(404, 'execution_not_found', '执行记录不存在');
    return row;
  }

  private getExecutionActionRow(id: string): ExecutionActionRow {
    const row = this.raw.prepare('SELECT * FROM execution_actions WHERE id = ?').get(id) as ExecutionActionRow | undefined;
    if (!row) throw new AppError(404, 'execution_action_not_found', '执行 action 不存在');
    return row;
  }

  private mapExecutionAction(row: ExecutionActionRow): ExecutionActionView {
    return {
      id: row.id,
      executionId: row.execution_id,
      actionIndex: row.action_index,
      type: row.type,
      normalizedParams: parseAction(row),
      status: row.status,
      idempotencyKey: row.idempotency_key,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'action 执行失败' } : null,
      inputAssets: this.getActionArtifactViews(row.id, 'input'),
      outputAssets: this.getActionArtifactViews(row.id, 'output'),
      createdAt: iso(row.created_at)!,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      updatedAt: iso(row.updated_at)!,
    };
  }

  private getActionArtifactViews(actionId: string, relation: 'input' | 'output'): ExecutionAssetView[] {
    const assets = this.raw.prepare(`SELECT assets.* FROM execution_action_artifacts
      JOIN assets ON assets.id = execution_action_artifacts.asset_id
      WHERE execution_action_artifacts.execution_action_id = ?
        AND execution_action_artifacts.relation = ?
      ORDER BY execution_action_artifacts.created_at, assets.created_at`)
      .all(actionId, relation) as AssetRow[];
    return assets.map(mapAssetView);
  }

  private getActionArtifactIds(actionId: string, relation: 'input' | 'output'): string[] {
    return (this.raw.prepare(`SELECT asset_id FROM execution_action_artifacts
      WHERE execution_action_id = ? AND relation = ? ORDER BY created_at`)
      .all(actionId, relation) as Array<{ asset_id: string }>)
      .map((row) => row.asset_id);
  }

  private linkActionArtifact(actionId: string, relation: 'input' | 'output', assetId: string, now: number): void {
    this.raw.prepare(`INSERT OR IGNORE INTO execution_action_artifacts
      (execution_action_id, asset_id, relation, created_at) VALUES (?, ?, ?, ?)`)
      .run(actionId, assetId, relation, now);
  }

  private bindActionInputs(action: ExecutionActionRow, execution: ExecutionRow, now: number): void {
    const normalized = parseAction(action);
    if (normalized.type === 'image.generate' || normalized.type === 'image.edit') return;
    const asset = normalized.input.kind === 'plan_input'
      ? this.raw.prepare(`SELECT * FROM assets
        WHERE id = ? AND plan_id = ? AND session_id = ? AND direction = 'input'`)
        .get(normalized.input.assetId, execution.plan_id, execution.session_id) as AssetRow | undefined
      : this.getActionOutputAsset(execution.id, normalized.input.actionIndex);
    if (!asset) {
      throw new AppError(409, 'action_input_unavailable', 'action 所需的输入产物尚不可用');
    }
    this.linkActionArtifact(action.id, 'input', asset.id, now);
  }

  private assertExecutionOutputAsset(execution: ExecutionRow, assetId: string): void {
    const asset = this.raw.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined;
    if (!asset || asset.session_id !== execution.session_id || asset.execution_id !== execution.id || asset.direction !== 'output') {
      throw new AppError(409, 'invalid_action_output_asset', 'action 输出资源不属于当前执行');
    }
  }

  private finishExecutionRow(
    row: ExecutionRow,
    status: Extract<ExecutionStatus, 'completed' | 'failed' | 'cancelled' | 'failed_unknown'>,
    error: { code: string; message: string } | undefined,
    now: number,
  ): void {
    if (!['executing', 'queued'].includes(row.status)) return;
    if (status !== 'completed') this.cancelUnstartedActions(row, status, now);
    this.raw.prepare(`UPDATE executions
      SET status = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'executing')`)
      .run(status, error?.code ?? null, error?.message ?? null, now, now, row.id);
    this.raw.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.plan_id);
    this.audit(row.session_id, 'execution', row.id, `execution.${status}`, error ? { errorCode: error.code } : {}, now);
  }

  private cancelUnstartedActions(
    execution: ExecutionRow,
    executionStatus: Exclude<ExecutionStatus, 'queued' | 'executing' | 'completed'>,
    now: number,
  ): void {
    const actions = this.raw.prepare("SELECT * FROM execution_actions WHERE execution_id = ? AND status = 'queued'")
      .all(execution.id) as ExecutionActionRow[];
    if (actions.length === 0) return;
    const errorCode = executionStatus === 'cancelled' ? 'execution_cancelled' : 'action_not_started';
    const errorMessage = executionStatus === 'cancelled'
      ? '执行已取消，action 未启动'
      : '前置 action 未成功完成，后续 action 未启动';
    this.raw.prepare(`UPDATE execution_actions
      SET status = 'cancelled', error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE execution_id = ? AND status = 'queued'`)
      .run(errorCode, errorMessage, now, now, execution.id);
    for (const action of actions) {
      this.audit(execution.session_id, 'execution_action', action.id, 'action.cancelled', {
        executionId: execution.id,
        actionIndex: action.action_index,
        reason: executionStatus,
      }, now);
    }
  }

  private mapExecution(row: ExecutionRow): ExecutionView {
    const actions = this.getExecutionActions(row.id);
    const assets = actions.length > 0
      ? this.raw.prepare(`SELECT assets.* FROM execution_actions
        JOIN execution_action_artifacts ON execution_action_artifacts.execution_action_id = execution_actions.id
        JOIN assets ON assets.id = execution_action_artifacts.asset_id
        WHERE execution_actions.execution_id = ?
          AND execution_actions.type = 'metadata.assert'
          AND execution_actions.status = 'completed'
          AND execution_action_artifacts.relation = 'output'
        ORDER BY execution_actions.action_index DESC, execution_action_artifacts.created_at, assets.created_at`)
        .all(row.id) as AssetRow[]
      : this.raw.prepare("SELECT * FROM assets WHERE execution_id = ? AND direction = 'output' ORDER BY created_at").all(row.id) as AssetRow[];
    return {
      id: row.id,
      planId: row.plan_id,
      status: row.status,
      cancelRequested: row.cancel_requested === 1,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? '执行失败' } : null,
      outputAssets: assets.map(mapAssetView),
      actions,
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
