-- GatewayDatabase 在启动事务中执行本迁移并维护 PRAGMA user_version，
-- 因而本文件可安全重放，且不会把未来版本的 user_version 回退。
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

CREATE INDEX IF NOT EXISTS execution_actions_execution_idx
  ON execution_actions(execution_id, action_index);
CREATE INDEX IF NOT EXISTS execution_actions_status_idx
  ON execution_actions(status, created_at);

CREATE TABLE IF NOT EXISTS execution_action_artifacts (
  execution_action_id TEXT NOT NULL REFERENCES execution_actions(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('input', 'output')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(execution_action_id, relation, asset_id)
);

CREATE INDEX IF NOT EXISTS execution_action_artifacts_lookup_idx
  ON execution_action_artifacts(execution_action_id, relation, created_at);
