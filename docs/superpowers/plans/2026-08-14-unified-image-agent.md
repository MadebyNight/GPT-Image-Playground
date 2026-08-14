# 统一图片 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户可见的 Chat/Tool 双模式收敛为单一 Agent，并用自动路由、Gateway action 链和 Sharp 校验交付严格规格的图片。

**Architecture:** 浏览器提交先经纯函数路由器；无硬约束走现有 Responses 流式执行器，硬约束走 Gateway v3 的自动入队 action 链。Gateway 在数据库中持久化 action 与 artifact，在最后一个 `metadata.assert` 成功前不发布最终资产；前端把两种路径都记录为同一会话中的 `origin: 'agent'` 回合。

**Tech Stack:** React 19、TypeScript、Zustand、Vitest、Playwright、Fastify、SQLite、Sharp。

---

## 目标文件结构

| 文件 | 职责 |
| --- | --- |
| `src/lib/agentRoute.ts` | 纯路由、硬约束提取、最终输出规格归一化。 |
| `src/lib/unifiedAgentExecutor.ts` | 统一提交、澄清/失败回合、Responses/Gateway 分派和按任务恢复。 |
| `src/types.ts` | 统一 Agent、路由、规格和 action 进度合同。 |
| `src/store.ts`、`src/lib/agentConversation.ts` | 单一草稿、统一历史、旧数据兼容和任务持久化。 |
| `src/lib/restrictedAgentApi.ts`、`src/restrictedAgentStore.ts` | Gateway v3 自动执行解码、每任务进度、取消与恢复。 |
| `gateway/src/{agentRoute,responsesProxy,types,plan,policy,planner,db,assets,executor,worker,events,server}.ts` | v3 action 链、受控 Responses 流、自动执行 API、Sharp 变换、持久化和 SSE。 |
| `src/components/*`、`src/App.tsx` | 单一 Agent 工作区、无确认计划卡和可访问交互。 |
| `src/**/*.test.ts*`、`gateway/tests/server.test.ts`、`e2e/*.spec.ts` | 合同、路径、恢复和 UI 回归测试。 |

### Task 1: 冻结共享合同与路由器

**Files:**

- Create: `src/lib/agentRoute.ts`
- Create: `src/lib/agentRoute.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: 写出路由器的失败测试。**

```ts
import { describe, expect, it } from 'vitest'
import { routeAgentTurn } from './agentRoute'

describe('routeAgentTurn', () => {
  it('将精确像素尺寸锁定到 tool pipeline', () => {
    expect(routeAgentTurn({ prompt: '生成一张 870×220 px 的夏日咖啡横幅' })).toMatchObject({
      route: 'tool_pipeline',
      fallbackForbidden: true,
      finalOutputSpec: { width: 870, height: 220, fit: 'cover', position: 'center' },
    })
  })

  it('将无硬约束的参考图语义编辑交给 Responses', () => {
    expect(routeAgentTurn({ prompt: '把天空改成黄昏', hasExplicitImageInput: true })).toMatchObject({
      route: 'responses_image',
      fallbackForbidden: false,
    })
  })

  it('拒绝未显式绑定的历史图片指代与 JPEG 透明冲突', () => {
    expect(routeAgentTurn({ prompt: '编辑上一张图' }).route).toBe('clarify')
    expect(routeAgentTurn({ prompt: '输出透明背景 JPEG' }).route).toBe('clarify')
  })
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- src/lib/agentRoute.test.ts`
Expected: FAIL，提示找不到 `./agentRoute`。

- [ ] **Step 3: 在 `src/types.ts` 定义共享合同，并实现最小路由器。**

```ts
export type AgentRoute = 'responses_image' | 'tool_pipeline' | 'clarify' | 'unsupported'
export type AgentExecutionRoute =
  | 'responses_image'
  | 'gateway_image_generate'
  | 'gateway_image_edit'
  | 'image_transform'
  | 'openshop'

export interface FinalOutputSpec {
  width?: number
  height?: number
  fit?: 'cover' | 'contain' | 'fill'
  position?: 'center' | 'left' | 'right' | 'top' | 'bottom'
  crop?: { x: number; y: number; width: number; height: number }
  rotate?: 90 | -90 | 180 | -180
  flip?: 'horizontal' | 'vertical'
  outputFormat?: 'png' | 'jpeg' | 'webp'
  transparent?: boolean
  background?: string
  outputCompression?: number | null
}

export interface AgentRouteDecision {
  route: AgentRoute
  routeReason: string
  hardConstraints: string[]
  fallbackForbidden: boolean
  finalOutputSpec: FinalOutputSpec | null
}

export interface AgentCapabilities {
  agentUsable: boolean
  responsesUsable: boolean
  toolPipelineUsable: boolean
}
```

`routeAgentTurn` 必须识别 `870×220`、`870 x 220`、比例、裁切、旋转、翻转、缩放、格式、透明、压缩、明确工具要求和未绑定的“上一张/刚才”。像素仅给宽高时写入 `fit: 'cover'` 与 `position: 'center'`；“不裁切”覆盖为 `contain`，“允许变形”覆盖为 `fill`。

- [ ] **Step 4: 增加完整边界测试并运行。**

扩展 `agentRoute.test.ts` 覆盖 `1200 x 628`、旋转、翻转、裁剪、压缩、PNG/WebP 透明、含 `@图片` 的历史引用与冲突格式。
Run: `npm test -- src/lib/agentRoute.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交合同与路由器。**

```powershell
git add src/types.ts src/lib/agentRoute.ts src/lib/agentRoute.test.ts
git commit -m "feat: 新增统一 Agent 路由器"
```

### Task 2: 收敛草稿、任务元数据与统一会话

**Files:**

- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Modify: `src/lib/agentConversation.ts`
- Modify: `src/store.test.ts`
- Modify: `src/lib/agentConversation.test.ts`

- [ ] **Step 1: 写出草稿迁移与混合会话的失败测试。**

```ts
it('从旧 chat/tool 草稿迁移为一个 agent 草稿', () => {
  const restored = restorePersistedState({
    composerDrafts: {
      chat: { prompt: 'chat', composerVersion: 3 },
      tool: { prompt: 'tool', composerVersion: 4 },
    },
  })
  expect(restored.composerDrafts.agent.prompt).toBe('tool')
})

it('将新的 Responses 与 Gateway 回合聚合到一个会话', () => {
  expect(getConversationTasks([
    task({ id: 'r', origin: 'agent', agentConversationId: 'c', agentTurn: 1 }),
    task({ id: 'g', origin: 'agent', agentConversationId: 'c', agentTurn: 2, agentExecutionId: 'e' }),
  ], 'c').map((item) => item.id)).toEqual(['r', 'g'])
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- src/store.test.ts src/lib/agentConversation.test.ts`
Expected: FAIL，因 `agent` scope 与 Gateway `origin: 'agent'` 语义尚不存在。

- [ ] **Step 3: 实现单一草稿与任务审计字段。**

将 `ComposerScope` 改为 `'gallery' | 'agent'`，`COMPOSER_SCOPES` 改为 `['gallery', 'agent']`；持久化读取旧 `chat/tool` 时选非空且 `composerVersion` 更高者，平手选 Chat。扩展 `TaskRecord`：

```ts
agentRoute?: AgentRoute
agentRouteReason?: string
agentHardConstraints?: string[]
agentFallbackForbidden?: boolean
agentFinalOutputSpec?: FinalOutputSpec
agentExecutionRoute?: AgentExecutionRoute
agentExecutionSnapshot?: RestrictedAgentExecution
```

新 Tool 回合必须创建为 `origin: 'agent'`。`agentConversation.ts` 对新记录仅按 `agentConversationId` 聚合；旧 `restricted-agent` 与 `openshop` 各产生独立兼容会话，绝不按 Prompt 或时间合并。

- [ ] **Step 4: 修正恢复与排序回归并运行。**

在 `store.test.ts` 覆盖平手选 Chat、空草稿忽略、迁移后仅写 `agent`；在 `agentConversation.test.ts` 覆盖旧 Tool/OpenShop 隔离、按 turn/时间稳定排序。
Run: `npm test -- src/store.test.ts src/lib/agentConversation.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交状态与会话收敛。**

```powershell
git add src/types.ts src/store.ts src/lib/agentConversation.ts src/store.test.ts src/lib/agentConversation.test.ts
git commit -m "feat: 合并 Agent 草稿与会话历史"
```

### Task 3: 加固 Responses 可用性与前后端双侧路由守卫

**Files:**

- Modify: `src/lib/serverApiConfig.ts`
- Modify: `src/lib/serverApiConfig.test.ts`
- Modify: `src/lib/legacyAgentExecutor.ts`
- Modify: `src/lib/legacyAgentExecutor.test.ts`
- Create: `gateway/src/agentRoute.ts`
- Create: `gateway/src/responsesProxy.ts`
- Modify: `gateway/src/server.ts`
- Modify: `gateway/tests/server.test.ts`

- [ ] **Step 1: 为 Agent 可用性和执行器守卫写失败测试。**

```ts
it('Responses 不可用时不因 Gateway 可用而解锁 Agent', () => {
  expect(getAgentCapabilities(settings)).toMatchObject({
    agentUsable: false,
    responsesUsable: false,
    toolPipelineUsable: true,
  })
})

it('拒绝通过旧执行器提交严格尺寸请求', async () => {
  await expect(storeBackedAgentExecutor.submit({
    prompt: '生成 870×220 图片',
    inputImageIds: [],
    params: DEFAULT_PARAMS,
    stream: true,
    imageCount: 1,
  })).rejects.toThrow('严格规格')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('服务端 Responses 代理拒绝硬约束而不访问上游', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/responses/image',
    payload: { request: '生成 870×220 图片', input: [] },
  })
  expect(response.statusCode).toBe(409)
  expect(upstreamFetch).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- src/lib/serverApiConfig.test.ts src/lib/legacyAgentExecutor.test.ts`
Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: FAIL，当前实现仍可在 Chat 缺失时选择 Tool，旧执行器和 Gateway 都不检查路由。

- [ ] **Step 3: 实现可用性规则与执行器断言。**

移除 `AGENT_MODE_PREFERENCE_KEY`、`getAgentModePreference`、`setAgentModePreference` 与 `resolveAgentMode`。`getAgentCapabilities` 以 `chatUsable` 为 Agent 总开关；Gateway 仅提供 `toolUsable` 信息。`legacyAgentExecutor` 在构建 `/responses` 请求前调用 `routeAgentTurn`，若返回值不是 `responses_image`，抛出含 `routeReason` 的错误且不调用 `fetch`。

Gateway 新增独立的服务端同构守卫与流式代理：

```ts
// gateway/src/agentRoute.ts
export function assertGatewayResponsesRoute(request: string) {
  const decision = routeGatewayAgentTurn(request)
  if (decision.route !== 'responses_image') {
    throw new AppError(409, 'hard_constraint_requires_tool_pipeline', decision.routeReason, decision)
  }
  return decision
}

// gateway/src/responsesProxy.ts
export async function relayResponsesImage(request: GuardedResponsesRequest, config: GatewayConfig) {
  assertGatewayResponsesRoute(request.request)
  return fetch(`${config.upstreamBaseUrl}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(request.upstreamBody),
  })
}
```

`POST /v1/responses/image` 只接收由 `legacyAgentExecutor` 构造的严格 JSON 白名单字段，转发 SSE 状态码、`content-type` 与响应字节流。服务器托管的 Responses 配置且 Gateway 可达时，`legacyAgentExecutor` 使用这个端点；BYOK 与 Gateway 不可达的普通请求保留当前直连/同源代理。无论哪条传输，前端路由和执行器断言都会先运行。

- [ ] **Step 4: 运行回归。**

确保普通请求仍覆盖 SSE 文本与 partial image。
Run: `npm test -- src/lib/serverApiConfig.test.ts src/lib/legacyAgentExecutor.test.ts`
Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: PASS；普通 SSE/partial image 不变，硬约束在两端均无上游 Responses 调用。

- [ ] **Step 5: 提交可用性与硬约束防线。**

```powershell
git add src/lib/serverApiConfig.ts src/lib/serverApiConfig.test.ts src/lib/legacyAgentExecutor.ts src/lib/legacyAgentExecutor.test.ts gateway/src/agentRoute.ts gateway/src/responsesProxy.ts gateway/src/server.ts gateway/tests/server.test.ts
git commit -m "feat: 阻断严格约束回退到 Responses"
```

### Task 4: 定义 Gateway v3 action 合同与 Planner 策略

**Files:**

- Modify: `gateway/src/types.ts`
- Modify: `gateway/src/plan.ts`
- Modify: `gateway/src/policy.ts`
- Modify: `gateway/src/planner.ts`
- Modify: `gateway/tests/fixtures.ts`
- Modify: `gateway/tests/server.test.ts`

- [ ] **Step 1: 写 v3 解码和策略失败测试。**

```ts
it('拒绝超过三步、前向引用和生成后多图的 v3 计划', () => {
  expect(() => decodePlan({ schemaVersion: 3, actions: fourActions })).toThrow('actions')
  expect(() => decodePlan(v3PlanWithForwardReference)).toThrow('引用')
  expect(() => decodePlan(v3GeneratePlanWithTwoImages)).toThrow('imageCount')
})

it('将纯 transform 计划约束为 transform 后接 assert', () => {
  expect(validateAndConstrainDraft(transformDraft).actions.map((a) => a.type))
    .toEqual(['image.transform', 'metadata.assert'])
})
```

- [ ] **Step 2: 运行 Gateway 测试确认失败。**

Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: FAIL，当前只接受 schema v1/v2 的单一 `operation`。

- [ ] **Step 3: 实现 schema v3、受限 artifact 引用和 Planner 输出。**

在 `gateway/src/types.ts` 保留 v1/v2 原样，新增：

```ts
export type ArtifactRef =
  | { kind: 'plan_input'; assetId: string }
  | { kind: 'action_output'; actionIndex: number }

export type ToolAction =
  | { type: 'image.generate'; generation: GenerationPlan & { action: 'generate' } }
  | { type: 'image.edit'; generation: GenerationPlan & { action: 'edit' } }
  | { type: 'image.transform'; input: ArtifactRef; transform: ImageTransform }
  | { type: 'metadata.assert'; input: ArtifactRef; expected: FinalOutputSpec }

export interface ToolAgentPlanV3Snapshot extends RestrictedAgentPlanSnapshotBase {
  schemaVersion: 3
  composerSnapshotHash: string
  finalOutputSpec: FinalOutputSpec | null
  actions: ToolAction[]
}
```

`plan.ts` 必须严格验证 1–3 个 action、仅允许 `generate|edit → transform → assert` 或 `transform → assert`、引用仅可指向输入或更早 action、带后处理时 `imageCount === 1`。`planner.ts` 的 JSON schema 必须关闭额外字段，并要求 Planner 只返回 action 类型和索引，不允许模型提供 asset UUID。`policy.ts` 规范化 JPEG 透明冲突、尺寸上限和 `contain` JPEG 白底假设。

- [ ] **Step 4: 扩展兼容回归。**

断言 v1/v2 fixture 仍能 decode，旧 If-Match 确认语义没有变；断言 v3 未知 action、错误顺序、超三步和透明 JPEG 全部 fail closed。
Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交 v3 合同。**

```powershell
git add gateway/src/types.ts gateway/src/plan.ts gateway/src/policy.ts gateway/src/planner.ts gateway/tests/fixtures.ts gateway/tests/server.test.ts
git commit -m "feat: 定义 Gateway 图片 action 链合同"
```

### Task 5: 持久化 v3 execution action 与 artifact

**Files:**

- Create: `gateway/migrations/002-v3-actions.sql`
- Modify: `gateway/src/db.ts`
- Modify: `gateway/src/types.ts`
- Modify: `gateway/tests/server.test.ts`

- [ ] **Step 1: 为前向迁移、幂等和恢复写失败测试。**

```ts
it('启动旧 v2 数据库时创建 v3 action 表且仍可读取旧计划', () => {
  const db = createDatabaseFromFixture('restricted-agent-v2.sqlite')
  expect(db.getPlan(legacyPlan.id, session.id)).toMatchObject({ schemaVersion: 2 })
  expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'execution_actions'").get()).toBeTruthy()
})

it('同一 execution 的 action index 与幂等键只能写入一次', () => {
  expect(() => db.insertExecutionAction(action)).not.toThrow()
  expect(() => db.insertExecutionAction(action)).toThrow('UNIQUE')
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: FAIL，当前运行时 schema 不创建 action 表。

- [ ] **Step 3: 实现幂等 migration 和 action 存储 API。**

在 `GatewayDatabase` 构造时于事务内读取 `PRAGMA user_version`，用 `CREATE TABLE IF NOT EXISTS` 创建：

```sql
CREATE TABLE IF NOT EXISTS execution_actions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
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
```

并创建 `execution_action_artifacts` 保存 action 的 `input`/`output` asset 关联。实现 `insertAutoPlanAndExecution`、`claimNextAction`、`completeAction`、`failAction`、`getActionOutputAsset` 与 `getExecutionActions`。`ExecutionView` 增加 actions，`outputAssets` 只暴露最终 assertion 成功资产。终态 execution 必须同步标记未启动 action 为 cancelled 或 failed_unknown。

- [ ] **Step 4: 运行迁移与恢复测试。**

覆盖 queued action 可恢复、executing action 在重启后 `failed_unknown`、取消不会删除审计资产。
Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交 action 持久化。**

```powershell
git add gateway/migrations/002-v3-actions.sql gateway/src/db.ts gateway/src/types.ts gateway/tests/server.test.ts
git commit -m "feat: 持久化 Gateway action 执行状态"
```

### Task 6: 实现 Sharp 变换、metadata 断言与顺序 Worker

**Files:**

- Modify: `gateway/src/assets.ts`
- Modify: `gateway/src/executor.ts`
- Modify: `gateway/src/worker.ts`
- Modify: `gateway/src/events.ts`
- Modify: `gateway/tests/server.test.ts`

- [ ] **Step 1: 写 transform/assert 与零 Images API 调用测试。**

```ts
it('将生成图片处理为严格的 870×220 PNG', async () => {
  const execution = await submitAutoPlan(generateTransformAssertPlan)
  await waitForExecution(execution.id, 'completed')
  expect(getExecution(execution.id).outputAssets[0]).toMatchObject({ width: 870, height: 220, mimeType: 'image/png' })
})

it('纯旋转与缩放不会调用 Images executor', async () => {
  await submitAutoPlan(transformAssertPlan)
  await waitForAllWork()
  expect(imageExecutor.executeGeneration).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: FAIL，Worker 目前只执行单一 Images generation。

- [ ] **Step 3: 实现不覆盖原图的 action 执行器。**

`AssetStore.transform` 按 `crop → rotate → flip → resize → encode` 执行 Sharp，写入新 asset，并从实际文件重新读取 metadata。`metadata.assert` 直接用 Sharp 检查真实文件的宽高、format、alpha，而不是信任数据库列。`executor.ts` 只导出 `executeGeneration`，Worker 仅在 `image.generate`/`image.edit` action 调用它。

Worker 逐 action 原子 claim，依次 emit：

```ts
await db.startAction(action.id)
events.emitAction('action.started', actionView)
// generate/edit、transform 或 assert
await db.completeAction(action.id, output)
events.emitAction('action.completed', actionView)
```

任一步失败都调用 `failAction` 并终止后续 action；每步前后检查取消信号。只有最后的 assert 成功后调用 `finishExecution(..., 'completed')` 并发送最终 `asset.ready`。

- [ ] **Step 4: 覆盖变换边界与 SSE。**

测试 `cover`、`contain`、`fill`、rotate、flip、crop、JPEG 白底、metadata 失败、取消、SSE action 顺序与中间资产不作为成功输出。
Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交严格输出 Worker。**

```powershell
git add gateway/src/assets.ts gateway/src/executor.ts gateway/src/worker.ts gateway/src/events.ts gateway/tests/server.test.ts
git commit -m "feat: 执行严格尺寸图片 action 链"
```

### Task 7: 提供 Gateway 自动执行 HTTP 合同

**Files:**

- Modify: `gateway/src/server.ts`
- Modify: `gateway/src/types.ts`
- Modify: `gateway/tests/server.test.ts`

- [ ] **Step 1: 写自动提交 API 测试。**

```ts
it('自动创建 v3 计划并在同一请求中入队 execution', async () => {
  const response = await app.inject(autoExecuteMultipartRequest())
  expect(response.statusCode).toBe(202)
  expect(response.json().data).toMatchObject({
    plan: { schemaVersion: 3, status: 'queued' },
    execution: { status: 'queued' },
  })
})

it('拒绝通过旧 execute API 再次执行 v3 计划', async () => {
  const response = await app.inject(executePlanRequest(v3Plan.id))
  expect(response.statusCode).toBe(409)
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: FAIL，当前只有创建计划后等待确认的 API。

- [ ] **Step 3: 新增 `POST /v1/plans/auto-execute`。**

复用现有 multipart 上传、Composer snapshot、CSRF、速率限制和资产清理 helper。此接口只接受 v3 请求和 `finalOutputSpec`，在 `insertAutoPlanAndExecution` 成功后返回：

```ts
reply.status(202)
return { data: { plan, execution, assetBindings } }
```

Images rate 仅在 action 链含 `image.generate` 或 `image.edit` 时消耗；纯 transform 不能消耗 Images rate，也不能有 Responses/Images fallback。`/v1/capabilities` 增加 schema v3、`image.transform` 和 `metadata.assert`。

- [ ] **Step 4: 运行兼容与失败回归。**

断言 v1/v2 `/plans` 与 `/execute` 的 If-Match、Composer hash、取消与恢复仍通过；v3 的非法 Planner、Gateway 失败、assert 失败没有 Responses 回退。
Run: `npm --prefix gateway test -- tests/server.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交自动执行 API。**

```powershell
git add gateway/src/server.ts gateway/src/types.ts gateway/tests/server.test.ts
git commit -m "feat: 自动入队统一图片 Agent 计划"
```

### Task 8: 接入前端 Gateway v3 与统一执行协调器

**Files:**

- Create: `src/lib/unifiedAgentExecutor.ts`
- Create: `src/lib/unifiedAgentExecutor.test.ts`
- Create: `src/test/fixtures/unifiedAgentGateway.ts`
- Modify: `src/lib/restrictedAgentApi.ts`
- Modify: `src/restrictedAgentStore.ts`
- Modify: `src/lib/agentExecutor.ts`
- Modify: `src/components/TaskActionRow.tsx`
- Modify: `src/components/TaskActionRow.test.tsx`

- [ ] **Step 1: 写统一提交的失败测试。**

```ts
it('严格尺寸回合自动提交 Gateway，且不调用确认 API 或 Responses', async () => {
  await submitUnifiedAgentTurn({ prompt: '生成 870×220 横幅', conversationId: 'c' })
  expect(createAutoPipeline).toHaveBeenCalledTimes(1)
  expect(confirmAndExecute).not.toHaveBeenCalled()
  expect(responsesFetch).not.toHaveBeenCalled()
})

it('Gateway 缺失时将硬约束写为失败回合', async () => {
  const taskId = await submitUnifiedAgentTurn({ prompt: '旋转这张图 90 度', conversationId: 'c' })
  expect(getTask(taskId)).toMatchObject({ status: 'error', agentFallbackForbidden: true })
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- src/lib/unifiedAgentExecutor.test.ts src/restrictedAgentStore.test.ts`
Expected: FAIL，当前不存在统一协调器且 Tool Store 只有单一全局确认 flow。

- [ ] **Step 3: 实现 v3 解码、每任务观察与分派。**

`restrictedAgentApi.ts` 新增 v3 decoder、`createAutoPipeline` 与 action SSE decoder。`restrictedAgentStore` 仅保留旧 v1/v2 确认流兼容；新 API 以 `taskId → executionId` 映射监听、更新该任务的 `agentExecutionSnapshot`、写最终资产、取消对应 execution。不能让一个后台执行覆盖另一个回合。

`submitUnifiedAgentTurn` 固定输入快照、创建带 `agentConversationId`/`agentTurn` 的本地任务，然后按 `routeAgentTurn`：

```ts
if (decision.route === 'responses_image') return storeBackedAgentExecutor.submit(snapshot)
if (decision.route === 'tool_pipeline') return createAndObserveAutoPipeline(snapshot, decision)
return createAgentTextTurn(snapshot, decision)
```

`clarify` 与 `unsupported` 产生当前会话的本地文字回合；硬约束的 Gateway 不可用错误必须不调用 Responses 执行器。重试始终创建同会话新 turn，使用原任务冻结的 prompt、显式输入和规格。

- [ ] **Step 4: 运行多执行与重试测试。**

覆盖两个并行 execution 各自更新、取消仅影响对应 task、SSE 恢复、重试 turn 递增和普通 Responses partial image 回归。
Run: `npm test -- src/lib/unifiedAgentExecutor.test.ts src/restrictedAgentStore.test.ts src/components/TaskActionRow.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交统一执行器。**

```powershell
git add src/lib/unifiedAgentExecutor.ts src/lib/unifiedAgentExecutor.test.ts src/test/fixtures/unifiedAgentGateway.ts src/lib/restrictedAgentApi.ts src/restrictedAgentStore.ts src/lib/agentExecutor.ts src/components/TaskActionRow.tsx src/components/TaskActionRow.test.tsx
git commit -m "feat: 接入统一 Agent 自动执行"
```

### Task 9: 替换为单一 Agent 工作区与无确认计划卡

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/components/InputBar.tsx`
- Modify: `src/components/AgentWorkspace.tsx`
- Modify: `src/components/AgentHistoryPanel.tsx`
- Modify: `src/components/AgentMainWorkspace.tsx`
- Modify: `src/components/AgentPlanCard.tsx`
- Modify: `src/components/AgentExecutionDetails.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/components/InputBar.test.ts`
- Modify: `src/components/AgentWorkspace.test.tsx`
- Modify: `src/components/AgentHistoryPanel.test.tsx`
- Modify: `src/components/AgentMainWorkspace.test.tsx`
- Modify: `src/components/AgentPlanCard.test.tsx`
- Modify: `src/components/AgentExecutionDetails.test.tsx`

- [ ] **Step 1: 写 UI 收敛失败测试。**

```tsx
it('不渲染 Chat/Tool 切换器，只渲染一个 Agent 输入框', () => {
  render(<AgentWorkspace active />)
  expect(screen.queryByRole('tab', { name: 'Chat' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Tool' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
})

it('计划卡没有确认控件，展示 action 进度和取消按钮', () => {
  render(<AgentPlanCard plan={v3Plan} execution={runningExecution} />)
  expect(screen.queryByRole('button', { name: /确认/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '取消执行' })).toBeInTheDocument()
  expect(screen.getByText('正在校验输出规格')).toBeInTheDocument()
})
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- src/App.test.tsx src/components/InputBar.test.ts src/components/AgentWorkspace.test.tsx src/components/AgentHistoryPanel.test.tsx src/components/AgentMainWorkspace.test.tsx src/components/AgentPlanCard.test.tsx src/components/AgentExecutionDetails.test.tsx`
Expected: FAIL，当前组件仍接收 `agentMode` 并展示确认按钮。

- [ ] **Step 3: 实现单入口 UI。**

`App.tsx` 仅维护 `activeAgentTaskId` 与当前会话；`getWorkspaceComposerScope('agent')` 固定返回 `'agent'`。`InputBar` 移除 `agentMode` 分支，placeholder 固定为：

```text
描述想生成或编辑的图片；可添加参考图，也可指定尺寸、裁剪或旋转。
```

它调用 `submitUnifiedAgentTurn`，并在 Responses 不可用时禁用整个 Agent。`AgentWorkspace`、历史面板和主区只渲染一套会话；后台任务完成不改变选择。`AgentPlanCard` 删除 `onConfirm`、`onReturnToEditing` 与全部确认文案，按 action `queued/executing/completed/failed/cancelled` 显示业务名称、取消和重试。`AgentExecutionDetails` 只显示“图片生成”“严格尺寸处理”“确定性编辑”等业务语义。

- [ ] **Step 4: 覆盖移动端、焦点和混合会话。**

测试删除当前会话选择相邻项、混合 Responses/Gateway 回合按 turn 渲染、后台完成不抢占、计划卡所有按钮有可访问名、移动端抽屉焦点约束未回归。
Run: `npm test -- src/App.test.tsx src/components/InputBar.test.ts src/components/AgentWorkspace.test.tsx src/components/AgentHistoryPanel.test.tsx src/components/AgentMainWorkspace.test.tsx src/components/AgentPlanCard.test.tsx src/components/AgentExecutionDetails.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交统一工作区。**

```powershell
git add src/App.tsx src/components/InputBar.tsx src/components/AgentWorkspace.tsx src/components/AgentHistoryPanel.tsx src/components/AgentMainWorkspace.tsx src/components/AgentPlanCard.tsx src/components/AgentExecutionDetails.tsx src/App.test.tsx src/components/InputBar.test.ts src/components/AgentWorkspace.test.tsx src/components/AgentHistoryPanel.test.tsx src/components/AgentMainWorkspace.test.tsx src/components/AgentPlanCard.test.tsx src/components/AgentExecutionDetails.test.tsx
git commit -m "feat: 统一图片 Agent 工作区"
```

### Task 10: 更新端到端覆盖、部署文档与完整验证

**Files:**

- Modify: `e2e/agent-responsive-message-flow.spec.ts`
- Create: `e2e/unified-image-agent.spec.ts`
- Modify: `e2e/agent-openshop-smoke.spec.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/nginx.conf`
- Modify: `deploy/dockerLineEndings.test.ts`

- [ ] **Step 1: 写 E2E 失败场景。**

```ts
test('统一 Agent 对硬约束只访问 Gateway 自动执行接口', async ({ page }) => {
  const responsesCalls: string[] = []
  const autoPlanCalls: string[] = []
  await page.route('**/responses', (route) => { responsesCalls.push(route.request().url()); return route.abort() })
  await page.route('**/agent-api/v1/plans/auto-execute', (route) => { autoPlanCalls.push(route.request().url()); return route.fulfill({ json: autoPlanFixture }) })
  await page.getByRole('textbox').fill('生成 870×220 横幅')
  await page.getByRole('button', { name: '发送' }).click()
  expect(responsesCalls).toEqual([])
  expect(autoPlanCalls).toHaveLength(1)
})
```

- [ ] **Step 2: 运行目标 E2E 确认失败。**

Run: `npm run test:e2e -- e2e/unified-image-agent.spec.ts`
Expected: FAIL，统一输入和自动执行接口尚未完全接通。

- [ ] **Step 3: 实现 E2E fixture 与部署/README 同步。**

在 E2E 覆盖普通 SSE 回合、硬约束零 Responses 调用、Gateway 缺失明确失败、无确认控件、桌面/移动可访问名、同会话多回合、OpenShop 不自动重放。README 和 `.env.example` 删除“Chat/Tool 手动切换”和“工具需确认”说明，改为单一 Agent、自动路由、Responses 前置、Gateway 只处理严格约束、自动 action 链。文档还要说明：服务端托管 Responses 且 Gateway 可达时使用受控流式代理；它复用 `AGENT_API_KEY`、`AGENT_UPSTREAM_BASE_URL` 与现有 `/agent-api/` Nginx 路由，不新增环境变量。Docker/Nginx 测试须断言该路径仍可流式转发。

- [ ] **Step 4: 运行分层验证。**

```powershell
npm test
npm run test:gateway
npm run build:all
npm run test:docker-config
npm run test:e2e
```

Expected: 全部 PASS。若 Playwright 提示缺少 Chromium，先经用户批准运行 `npm run test:e2e:install`；不启动 Docker 容器或构建镜像，除非用户另行确认 Docker 集成测试。

- [ ] **Step 5: 复查产物并提交。**

```powershell
git diff --check
git status --short
git add e2e/agent-responsive-message-flow.spec.ts e2e/unified-image-agent.spec.ts e2e/agent-openshop-smoke.spec.ts README.md .env.example docker-compose.yml deploy/nginx.conf deploy/dockerLineEndings.test.ts
git commit -m "test: 覆盖统一图片 Agent 回归"
```

确认提交仅包含本功能的代码、测试和文档，不包含 `docs/openshop-agent-tool-evaluation.md` 或 `image-sample-library/`。

## 计划自检

- PRD P0 的单入口、单历史、单草稿、路由审计、无确认、历史兼容、显式图片引用和可访问性分别由 Task 1–3、8–10 覆盖。
- PRD P1 的 action 链、Sharp transform、metadata 校验、自动入队、取消/恢复、失败闭环和真实调用断言由 Task 4–7 覆盖。
- 已确认的默认值（自动执行、`cover + center`、参考图优先 Responses、Responses 前置、Gateway 缺失时严格请求失败）均有对应测试。
- P2 OpenShop 跨链编排明确不在 v3 链允许列表中；现有单独 OpenShop 兼容路径只做回归。
