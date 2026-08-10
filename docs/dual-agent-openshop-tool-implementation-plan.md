# 双 Agent 与 OpenShop 工具化实施计划

> 状态：已完成对抗式审查的方案计划稿，待实施
>
> 日期：2026-08-10
>
> 依据：当前仓库实现、`docs/openshop-agent-tool-evaluation.md`、并行代码审查结果

## 1. 结论

OpenShop 的确定性图片编辑能力可以封装为 Agent 工具，但不应接入现有 Legacy 流式 Agent。推荐形成两条彼此独立、用户可切换的 Agent 路径：

- **Chat Agent**：保留当前 Legacy 流式对话体验，继续使用 Responses API 的内置 `image_generation` 工具。
- **Tool Agent**：由当前 Restricted Agent 演进，负责结构化规划、用户确认、工具调度、执行状态和结果追踪。

第一阶段的产品目标不是立即让 Agent 自主循环调用任意工具，也不是先建设通用工作流引擎，而是以最小改动证明“双 Agent 并存 + OpenShop 单工具执行”能够产生真实用户价值。

本方案保留用户明确提出的双 Agent 产品形态：Chat 和 Tool 是两个可选择模式。对抗式审查提出了单入口自动路由方案，但该方案改变了已确认的产品方向，因此不作为 MVP；可以在双模式稳定后通过用户行为数据重新评估。

OpenShop MVP 采用单一 Tool operation：输入一张已有图片，执行一批受限 canvas 命令，导出一张 PNG 并保存为新历史。首轮不支持生成后继续 OpenShop、不支持多 Action、不支持对象/图层 ID 规划，也不建设跨 Gateway/浏览器的通用调度系统。

推荐实施顺序：

1. 建立测试、CI、Docker 配置和 Legacy 行为基线。
2. 修正 Chat 能力判断、流状态生命周期、重试和提交快照。
3. 让 Chat Agent 和现有 Restricted Agent 在同一部署中并存。
4. 隔离两种模式的历史、选中状态和完整输入草稿。
5. 独立实现 OpenShop 一次性离屏 iframe Tool Bridge。
6. 将 Restricted Plan 扩展为单一 operation 联合，接入 `openshop.edit`。
7. 验证完整链路后，再决定是否演进到通用 `actions[]`。

## 2. 目标与非目标

### 2.1 目标

- 同一部署中同时保留 Chat Agent 和 Tool Agent。
- 用户能够显式选择当前 Agent 模式。
- 模式切换不终止正在进行的流式响应或工具执行。
- 两种模式的会话、历史、输入草稿和活动任务互不污染。
- Tool Agent 在执行前展示不可变计划，由用户确认后执行。
- 图片生成、图片编辑和 OpenShop 编辑都表示为结构化单一 operation。
- Tool Agent 能展示本次 operation 的状态、输入、输出和失败原因。
- OpenShop 只开放确定性、可验证、可回放的 command。
- 所有输出图片进入现有资产和任务历史体系，不覆盖原图。
- 保持旧 `origin: 'agent'` 和 `origin: 'restricted-agent'` 数据可读。

### 2.2 非目标

- 不把 Legacy Chat Agent 改造成通用本地工具调用 Agent。
- 不在 MVP 中实现模型无限循环规划、执行、观察、再规划。
- 不在 MVP 中开放 OpenShop 的画笔、套索、Liquify、复杂 modal 或插件能力。
- 不在 MVP 中把 OpenShop 迁移到 Gateway 的 headless Chromium。
- 不在首轮改造中批量迁移 IndexedDB 历史数据。
- 不在首轮改造中支持多 Gateway 实例协同调度。
- 不在 MVP 中实现 `actions[]`、DAG、Action 表或通用 Artifact。
- 不在 MVP 中实现 Tool Conversation；Tool 历史先按独立 Run 展示。
- 不在 MVP 中支持 `image.generate -> openshop.edit` 复合链路。
- 不承诺取消操作能够回滚已经完成的 action。

## 3. 当前实现与关键问题

### 3.1 Legacy Chat Agent

当前调用链：

```text
App
  -> InputBar
    -> storeBackedAgentExecutor.submit
      -> legacyAgentExecutor
        -> Responses API
          -> 内置 image_generation
            -> SSE 增量事件
              -> LegacyAgentMainWorkspace
```

关键文件：

- `src/lib/legacyAgentExecutor.ts`
- `src/lib/openaiCompatibleImageApi.ts`
- `src/lib/agentExecutor.ts`
- `src/components/LegacyAgentMainWorkspace.tsx`
- `src/lib/agentConversation.ts`

当前能力：

- 文本增量流。
- `image_generation_call` 状态与 partial image。
- 图片生成、参考图编辑和遮罩编辑。
- 本地多轮对话上下文拼接。
- 最终文本、图片和修订 Prompt 写入 `TaskRecord`。

当前限制：

- `tools` 固定为 Responses API 的内置 `image_generation`。
- 浏览器内没有本地 function-call dispatcher。
- 不能调用 OpenShop 或其他本地自定义工具。
- 进行中的流状态主要保存在内存，刷新后不能恢复增量过程。

### 3.2 Restricted Agent

当前调用链：

```text
InputBar
  -> restrictedAgentStore.createPlanFromCurrentInput
    -> Gateway Planner
      -> 结构化 GenerationPlan
        -> 用户确认
          -> Gateway ExecutionWorker
            -> DeterministicImagesExecutor
              -> Images API
```

关键文件：

- `src/restrictedAgentStore.ts`
- `src/lib/restrictedAgentApi.ts`
- `src/components/AgentPlanCard.tsx`
- `gateway/src/types.ts`
- `gateway/src/policy.ts`
- `gateway/src/planner.ts`
- `gateway/src/executor.ts`
- `gateway/src/worker.ts`
- `gateway/src/db.ts`

可复用能力：

- Planner 与 Executor 分离。
- 用户确认不可变计划。
- `If-Match` 版本确认。
- 一个 Plan 对应一个 Execution 的幂等约束。
- 队列、并发限制、取消请求和重启恢复。
- SSE 通知与轮询校正。
- 图片资产保存和执行历史映射。

当前限制：

- `GenerationPlan` 只能表达一次 `generate` 或 `edit`。
- `PlanStep` 只是展示信息，不是实际可执行 action。
- Executor 固定返回 `Buffer[]`，只适配 Images API。
- Worker 假设一次 Execution 只有一次图片调用。
- 前端 Store 只有一组全局 `phase/plan/execution/taskId`。
- 数据库没有 Action 级状态和中间结果。

### 3.3 当前双 Agent 不是并存关系

当前 `src/components/AgentMainWorkspace.tsx` 通过 `isRestrictedAgentEnabled()` 在两个实现之间二选一。`src/components/InputBar.tsx` 也使用相同能力判断决定提交路径。

这混淆了三个不同概念：

| 概念 | 正确含义 | 当前问题 |
|---|---|---|
| 部署能力 | 环境是否支持某种 Agent | 被当成当前模式 |
| 产品模式 | 用户当前选择 Chat 或 Tool | 当前不存在 |
| 执行状态 | 流式响应、等待确认、执行中等 | 分散在不同 Store/UI 中 |

此外，`src/lib/serverApiConfig.ts` 当前禁止 `serverApi` 与 `restrictedAgent` 同时启用，这会直接阻止双能力部署。

### 3.4 OpenShop 当前边界

宿主与 OpenShop iframe 当前只公开：

- `openshop:hello`
- `openshop:configure`
- `openshop:export`
- 对应 ready/configured/exported/error 响应

关键文件：

- `src/lib/openshopBridge.ts`
- `src/components/OpenShopWorkspace.tsx`
- `public/openshop/index.html`

OpenShop 内部已经存在 command registry、command 规范化和执行机制，位置约为：

- `_getCommandRegistry()`：`public/openshop/index.html:9190`
- `_normalizeCommand()`：`public/openshop/index.html:9461`
- `_executeCommand()`：`public/openshop/index.html:9632`
- iframe bridge：`public/openshop/index.html:17621`

因此 OpenShop 的问题不是缺少编辑能力，而是缺少面向 Agent 的稳定公开协议。

## 4. 目标架构

```text
                         +----------------------+
                         | Agent Workspace      |
                         | mode: chat | tool    |
                         +----------+-----------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
        +---------v----------+              +---------v----------+
        | Chat Agent         |              | Tool Agent         |
        | Legacy 流式路径     |              | 计划确认执行路径    |
        +---------+----------+              +---------+----------+
                  |                                   |
        Responses API                         Tool Planner
        image_generation                            |
                                             Frozen actions[]
                                                    |
                                             User confirmation
                                                    |
                                      +-------------v-------------+
                                      | Tool Dispatcher           |
                                      +------+------+-------------+
                                             |      |
                                  +----------+      +-------------+
                                  |                               |
                         Gateway runtime                   Client runtime
                         image.generate                    openshop.execute
                         image.edit                        hidden iframe
```

### 4.1 架构原则

- Chat Agent 与 Tool Agent 不共享执行器。
- 能力开关只决定模式是否可用，不决定用户当前模式。
- Tool Agent 的 Planner 不直接执行工具。
- 用户确认的是实际将执行的规范化 `actions[]`，不是仅供展示的文本步骤。
- 每个 Tool Action 明确声明执行环境：`gateway_runtime` 或 `client_runtime`。
- 所有 action 输入输出通过 asset/artifact 引用传递，不在计划中传递大体积 data URL。
- 工具目录由应用固定提供，Planner 不能动态定义工具。
- 第一版按固定计划顺序执行，不支持运行中由模型增加 action。

## 5. 产品模式与能力模型

### 5.1 核心类型

```ts
export type AgentMode = 'chat' | 'tool'

export interface AgentCapabilities {
  chatAllowed: boolean
  chatConfigured: boolean
  chatUsable: boolean
  tool: boolean
  openShopTool: boolean
  defaultMode: AgentMode | null
  modeSwitching: boolean
}

export interface AgentWorkspaceState {
  mode: AgentMode
  activeTaskByMode: Record<AgentMode, string | null>
  activeConversationByMode: Record<AgentMode, string | null>
}
```

### 5.2 配置兼容规则

| 可用能力 | UI 行为 |
|---|---|
| 仅 Chat | 隐藏模式切换器，进入 Chat |
| 仅 Tool | 隐藏模式切换器，进入 Tool |
| Chat + Tool | 显示模式切换器，记忆上次选择 |
| 均不可用 | 禁用 Agent 入口并显示配置原因 |

旧配置兼容：

- `serverApi.enabled` 只表示服务端 API 能力，不能单独代表 Chat 是否可用。
- 本地 OpenAI-compatible API Profile 也可以提供 Chat 能力。
- `chatUsable` 由产品开关、服务端能力和本地 Profile 共同计算。
- `restrictedAgent.enabled` 暂时映射为 Tool 能力。
- `restrictedAgent.agentOnly` 只决定是否隐藏 Gallery，不再决定 Agent 内部模式。
- 移除 `serverApi` 和 `restrictedAgent` 不能同时启用的校验。
- 后续再评估将 `restrictedAgent` 配置重命名为 `toolAgent`；首轮保留旧键，避免部署配置立即失效。

### 5.3 模式切换位置

模式切换器放在 `AgentWorkspace` 顶部，位于历史、主工作区和模板区域的共同上方。

切换模式时：

- 不取消正在进行的 Chat 流，且返回 Chat 后必须恢复最新文本、工具状态和 partial image。
- 不取消正在执行的 Tool Execution。
- 恢复目标模式上次选中的会话或任务。
- 恢复目标模式独立的 Prompt、参考图和参数草稿。
- 仅切换可见工作区和提交策略。

## 6. 会话、历史与草稿隔离

### 6.1 任务兼容

首轮不批量迁移现有 `TaskRecord`：

| 旧字段 | 解释 |
|---|---|
| `origin: 'agent'` | Chat Agent |
| `origin: 'restricted-agent'` | Tool Agent |
| `origin: 'gallery'` | 非 Agent 图片任务 |
| `origin: 'openshop'` | 手工 OpenShop 编辑记录 |

建议新增可选字段：

```ts
agentMode?: 'chat' | 'tool'
agentRunId?: string
agentConversationId?: string
```

读取时优先使用 `agentMode`，缺失时通过 `origin` 推导。写入新任务时同时写入 `origin` 和 `agentMode`，待旧版本兼容窗口结束后再评估清理。

### 6.2 历史过滤

- Chat 历史只包含 `agentMode=chat` 或 `origin=agent`。
- Tool 历史只包含 `agentMode=tool` 或 `origin=restricted-agent`。
- Gallery 和手工 OpenShop 记录不进入 Agent 历史。
- Chat 历史继续按 `agentConversationId` 聚合多轮任务。
- 完整目标架构可按 Tool Conversation 聚合 Run；MVP 只展示独立 Run，不建立 Conversation。

### 6.3 草稿隔离

当前 Agent InputBar 共享 Prompt、图片、Mask 和临时 API Profile。双模式后建议引入完整、带版本的草稿快照：

```ts
interface AgentComposerDraft {
  prompt: string
  inputImages: InputImage[]
  params: ImageParams
  maskDraft: MaskDraft | null
  reusedTaskApiProfile: ApiProfileSnapshot | null
  version: number
}

agentDrafts: Record<AgentMode, AgentComposerDraft>
```

Chat 和 Tool 切换时保存当前草稿并恢复目标草稿。提交时冻结来源模式的完整草稿快照；异步完成后只能按 `mode + snapshotVersion` 清理提交来源草稿，不能清理用户后来在另一模式或同一模式中修改的新输入。

Tool 的待确认计划不等同于草稿。Prompt、图片、Mask、参数或临时 Profile 发生变化时，旧 Plan 必须明确标记为过时；`originalRequest` 只有文本，不能用来恢复完整 Composer。

### 6.4 MVP Tool Plan

MVP 不使用 `actions[]`，而是在现有单 Plan/单 Execution 原语上增加判别联合：

```ts
type ToolOperation =
  | { type: 'image.generate'; generation: GenerationPlan }
  | { type: 'image.edit'; generation: GenerationPlan }
  | {
      type: 'openshop.edit'
      inputAssetId: string
      commands: OpenShopCanvasCommand[]
      outputFormat: 'png'
    }

interface ToolAgentPlanSnapshot {
  schemaVersion: 2
  id: string
  version: number
  originalRequest: string
  composerSnapshotHash: string
  operation: ToolOperation
  assumptions: string[]
  warnings: string[]
  policyVersion: string
  expiresAt: string
}
```

MVP 约束：

- 一次 Plan 只有一个 operation。
- `openshop.edit` 只能输入已有图片 asset。
- 首轮不支持前序生成结果引用。
- OpenShop operation 由浏览器执行，不进入多 Action 编排。
- Tool 历史先按独立 Run 展示，不引入 Tool Conversation。

## 7. 完整目标架构：Tool Agent 领域模型

本节描述第二个异构工具和复合工作流需求得到验证后的目标架构，不是 OpenShop MVP 前置条件。MVP 以第 6.4 节的单 operation 模型为准。

### 7.1 Action 联合类型

```ts
type ToolRuntime = 'gateway_runtime' | 'client_runtime'

interface ToolActionBase {
  id: string
  tool: string
  toolVersion: string
  runtime: ToolRuntime
  inputRefs: string[]
  dependsOn: string[]
  approval: 'plan'
}

type ToolAction =
  | (ToolActionBase & {
      tool: 'image.generate'
      runtime: 'gateway_runtime'
      arguments: ImageGenerateArguments
    })
  | (ToolActionBase & {
      tool: 'image.edit'
      runtime: 'gateway_runtime'
      arguments: ImageEditArguments
    })
  | (ToolActionBase & {
      tool: 'openshop.execute'
      runtime: 'client_runtime'
      arguments: OpenShopExecuteArguments
    })
```

### 7.2 计划快照

```ts
interface ToolAgentPlanSnapshot {
  id: string
  version: number
  status: PlanStatus
  originalRequest: string
  summary: string
  actions: ToolAction[]
  inputs: PlanInputView[]
  assumptions: string[]
  warnings: string[]
  policyVersion: string
  expiresAt: string
}
```

约束：

- `actions` 数量 MVP 上限建议为 8。
- `dependsOn` 必须形成无环图；MVP 实际只执行线性序列。
- 每个 action 的参数经过工具 Schema 规范化后写入计划。
- 计划确认后不允许修改 action、参数、工具版本或输入引用。
- 对旧 `generation` 计划提供读取适配器，映射成单个 image action。

### 7.3 Action 状态

```ts
type ToolActionStatus =
  | 'pending'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'failed_unknown'
  | 'skipped'
```

Execution 状态由 action 聚合：

- 所有 action 完成：`completed`。
- 任一 action 明确失败：`failed`，后续 action 标记 `skipped`。
- 用户取消：未开始 action 标记 `cancelled`，已完成 action 保留完成状态。
- 执行环境中断且无法确定结果：当前 action 和 execution 为 `failed_unknown`，禁止自动重试。

### 7.4 Tool Result

```ts
interface ToolResult {
  actionId: string
  artifacts: ArtifactRef[]
  summary: Record<string, unknown>
  startedAt: string
  completedAt: string
}

type ArtifactRef =
  | { kind: 'image'; assetId: string; mimeType: string; width: number; height: number }
  | { kind: 'json'; artifactId: string; schema: string }
  | { kind: 'text'; artifactId: string }
```

首批工具只需要图片和简化 JSON 摘要，但模型应避免把所有结果都塞入 `assets` 表。

## 8. Tool Registry 与执行职责

### 8.1 Tool Registry

Tool Registry 是固定代码注册表，不接受客户端动态工具定义：

```ts
interface ToolDefinition<TArgs, TResult> {
  name: string
  version: string
  runtime: ToolRuntime
  description: string
  normalizeArguments(input: unknown): TArgs
  validatePolicy(args: TArgs, context: ToolPolicyContext): void
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>
}
```

首批注册工具：

- `image.generate`
- `image.edit`
- `openshop.execute`

### 8.2 Planner 职责

Planner：

- 接收用户需求、输入资产和允许工具目录。
- 输出严格 JSON Schema 的 `actions[]`。
- 说明必要假设和用户影响。
- 不执行工具。
- 不创建动态工具名。

Planner 输出后，Gateway Policy 再验证：

- 工具是否注册。
- 参数是否满足工具 Schema。
- 输入引用是否属于当前会话并可用于该工具。
- action 数量、依赖和输出格式是否受支持。
- `client_runtime` action 是否在当前部署能力中可用。

### 8.3 Dispatcher 职责

Dispatcher：

- 按 action 顺序读取计划快照。
- 检查依赖产物是否存在。
- 根据 runtime 路由到 Gateway Executor 或 Client Tool Runner。
- 记录 action 开始、完成和错误。
- 将产物引用注入后续 action。
- 不允许执行计划外 action。

### 8.4 Gateway Worker 演进

现有 Worker 可保留队列、取消和执行级生命周期，但要增加：

- `execution_actions` 持久化。
- Action 级 claim/开始/完成状态。
- Action 输出 artifact 引用。
- 部分完成语义。
- Client runtime 的等待状态与回传接口。

建议不要一次性删除 `DeterministicImagesExecutor`。先将其封装为 `image.generate` 与 `image.edit` 两个 Tool Adapter，确保现有受限图片能力在 action 模型下保持一致。

## 9. 完整目标架构：Client Runtime 执行模型

本节是复合工作流目标方案。OpenShop MVP 不要求 Gateway 暂停并等待浏览器 action，而是由 Tool Agent 前端在确认单一 `openshop.edit` operation 后执行并保存本地结果。

OpenShop 第一版运行在浏览器 iframe，因此 Tool Agent 必须明确支持 Client runtime。

推荐流程：

```text
Gateway 创建 Execution
  -> Worker 执行 Gateway actions
  -> 遇到 client_runtime action
  -> Execution 标记 waiting_for_client
  -> 前端领取该 action
  -> Client Tool Runner 执行 OpenShop
  -> 上传输出资产并提交 Tool Result
  -> Gateway 验证 actionId/planVersion/result
  -> Worker 继续后续 action
```

MVP 简化方案：仅允许 OpenShop action 是计划最后一个 action。这样不需要 Gateway 在客户端执行后继续复杂依赖链，也减少页面关闭时的恢复歧义。

必须明确：

- 页面关闭时，未完成 Client action 不会在服务端自动执行。
- 刷新后可重新领取尚未开始的 Client action。
- 已开始但结果未知的 Client action标记为 `failed_unknown`，不自动重放。
- 输出图片上传成功且 Tool Result 被 Gateway 接受后，action 才算完成。

## 10. OpenShop Tool Bridge

### 10.0 MVP 修订边界

对抗式审查确认，OpenShop 内部 command registry 是 UI 历史重放基础，不等同于稳定的工具 API。MVP 必须收缩为：

- 单输入图片。
- 单 `openshop.edit` operation。
- 每次执行创建一个离屏但具有固定非零尺寸的 iframe，完成后销毁，不复用 dirty iframe。
- Planner 使用 `document`、`primary-image` 等逻辑 target，不冻结运行时随机 objectId/layerId。
- 首轮只开放不依赖图层和对象 ID 的 canvas 命令。
- 不提供 `cancel`、session 复用和 revision conflict；这些能力在一次性 iframe 模型中没有足够价值。
- 结果先复用本地 `saveOpenShopEdit()` 路径保存为新 Task；若后续要求 Gateway 持有 Client 输出，再单独增加上传和补偿流程。

必须新增专用 `_executeToolBatch()`，不能直接假设任意 registry command 都可组合。该方法负责完整预校验、命令排序、统一 no-op 语义、失败索引和快照恢复。

### 10.1 协议命名

保留现有 `openshop:*` v1 给手工编辑工作区使用。MVP 新增独立命名空间：

| 请求 | 响应 | 用途 |
|---|---|---|
| `openshop:tool:hello` | `openshop:tool:ready` | 协商协议与能力 |
| `openshop:tool:configure` | `openshop:tool:configured` | 导入输入图片并创建 session |
| `openshop:tool:execute` | `openshop:tool:executed` | 执行 command 批次 |
| `openshop:tool:export` | `openshop:tool:exported` | 导出 PNG Blob |
| 任意失败 | `openshop:tool:error` | 结构化错误 |

所有请求包含：

```ts
interface OpenShopToolRequestBase {
  version: 1
  id: string
}
```

一次 iframe 只处理一次 Tool execution。session/revision/复用属于后续能力。

### 10.2 Agent 侧工具输入

Agent 不直接操作 Blob，而是引用 asset：

```ts
interface OpenShopExecuteArguments {
  inputAssetId: string
  commands: OpenShopCommand[]
  outputFormat: 'png'
}
```

Client Tool Runner 内部负责：

1. 获取输入 asset Blob。
2. 创建一个离屏、固定非零尺寸的 iframe。
3. 握手并导入图片。
4. 将逻辑 target 解析为当前文档对象。
5. 执行 command 批次。
6. 导出 PNG。
7. 复用现有本地 OpenShop 保存路径创建新 Task。
8. 销毁 iframe。

### 10.3 Descriptor

完整 `describe` 推迟。MVP 只允许 Runner 内部读取最小文档摘要，用于解析 `primary-image` 和校验输出：

- canvas width/height。
- primary image 是否存在及其当前 bounds。

不返回完整 Fabric JSON、像素数据或 data URL。

### 10.4 MVP Command 白名单

MVP 首批开放：

- `canvas.crop`
- `canvas.rotate`
- `canvas.flip`
- `canvas.flatten`

可在真实浏览器组合测试通过后追加：

- `primaryImage.adjust`
- `primaryImage.filter`

暂缓：

- `canvas.resize`：当前语义是改变画布边界，不是图片重采样，需要先重命名或新增真正的 resample command。
- 全部 `layer.*` 和 `object.*`：运行时 ID 不稳定，且 raster 化命令会重建对象。
- `frame.*`：涉及动画状态。
- `macro.sequence`：不直接暴露，由 bridge 内部将 commands 包装成受限批次。
- 画笔、橡皮、套索、clone、healing、smudge、Liquify 等交互能力。
- AI、插件、URL 导入和任意 JavaScript。

### 10.5 执行约束

- MVP 每批最多 5 条 command。
- Bridge 白名单校验后，继续调用 `_normalizeCommand()`。
- `_executeToolBatch()` 必须在执行前验证组合顺序；任一 command 失败时恢复批次前快照。
- 输入仅支持 PNG、JPEG、WebP。
- 输出首批仅支持 PNG。
- 握手超时 5 秒，导入 30 秒，执行 20 秒，导出 30 秒，统一硬上限 60 秒。
- 同步 command 无法可靠中断；硬超时后的恢复方式是销毁本次 iframe 并将 operation 标记失败或结果未知。

### 10.6 错误模型

```ts
interface OpenShopToolError {
  type: 'openshop:tool:error'
  id: string
  sessionId?: string
  code:
    | 'INVALID_REQUEST'
    | 'UNSUPPORTED_COMMAND'
    | 'VALIDATION_FAILED'
    | 'REVISION_CONFLICT'
    | 'BUSY'
    | 'CANCELLED'
    | 'TIMEOUT'
    | 'IMPORT_FAILED'
    | 'EXECUTION_FAILED'
    | 'EXPORT_FAILED'
    | 'SESSION_EXPIRED'
  message: string
  retryable: boolean
  commandIndex?: number
}
```

Tool Agent UI 必须展示稳定错误码对应的用户恢复路径，例如重新规划、重新打开输入图片、返回修改或放弃本次执行。

## 11. 完整目标架构：数据库与 API 演进

MVP 不新增 Action/Artifact 表。数据库改动前必须先补真实 schema version 和 migration runner；当前 `gateway/migrations/001.sql` 没有运行入口，Gateway 实际执行 `gateway/src/db.ts` 内嵌 `SCHEMA`。

### 11.1 建议新增表

```text
execution_actions
  id
  execution_id
  sequence
  tool_name
  tool_version
  runtime
  status
  arguments_json
  input_refs_json
  output_refs_json
  error_code
  error_message
  started_at
  completed_at
  updated_at

artifacts
  id
  execution_id
  action_id
  session_id
  kind
  schema_name
  metadata_json
  storage_path
  created_at
  expires_at
```

现有 `assets` 继续保存图片；`artifacts` 保存非图片 JSON/text 结果。若 MVP 只有图片和少量内联摘要，可先只增加 `execution_actions`，但 API 类型应预留 artifact 概念。

### 11.2 API 兼容策略

建议先新增 v2 端点或在 v1 capabilities 中明确协议版本，不直接改变旧客户端依赖的响应形状。

新增能力至少包括：

- 查询 Agent capabilities。
- 创建 Tool Plan。
- 确认 Tool Plan。
- 查询 Execution 与 action 列表。
- 取消 Execution。
- 领取 Client action。
- 提交 Client action 结果。
- 上传 Client action 输出资产。

旧 restricted plan/execution API 在迁移期继续支持单一 image action。

## 12. 前端组件与状态规划

### 12.1 目标组件结构

```text
AgentWorkspace
  AgentModeSwitcher
  AgentHistoryPanel(mode)
  AgentMainWorkspace(mode)
    ChatAgentMainWorkspace
    ToolAgentMainWorkspace
      ToolPlanCard
      ToolExecutionTimeline
      ToolArtifactPreview
  AgentTemplateRail(mode)
  AgentComposer(mode)
```

### 12.2 Store 拆分

建议：

- `agentWorkspaceStore`：模式、每种模式的 active task/conversation、草稿。
- 保留现有通用 `store.ts`：图片任务和资产历史。
- `toolAgentStore`：plans/runs/actions、当前活动 run、恢复和事件订阅。
- `legacyAgentExecutor`：保持当前职责，不并入 Tool Store。

Tool Store 从单例：

```ts
phase + plan + execution + taskId
```

演进为：

```ts
runsById: Record<string, ToolAgentRun>
activeRunId: string | null
conversationRunIds: Record<string, string[]>
```

### 12.3 UI 交互

- Chat 模式保持当前连续对话式工作区。
- Tool 模式先展示用户请求，再展示可展开的 action 计划。
- 确认按钮确认整个冻结计划。
- 执行期间按 action 展示 queued/executing/completed/failed/skipped。
- Client action 开始前如果页面不满足执行条件，显示明确的“等待本浏览器执行”。
- 完成后的图片沿用现有 `TaskDetailContent` 和历史预览。

## 13. 完整目标架构的原始阶段

本节保留完整目标架构的依赖关系，不能直接作为 MVP 执行顺序。实际执行以第 21 节“对抗式审查后的修订实施计划”为准。

### 阶段 0：契约冻结与回归基线

目标：在改动行为前定义双 Agent 语义并保护现有体验。

主要工作：

- 定义 `AgentMode`、Capabilities、旧数据映射和模式默认规则。
- 明确 Tool Agent MVP 只执行冻结计划，不做自主循环。
- 补齐 Legacy 流式、非流式、多轮、失败和刷新后的回归测试。
- 补齐 Restricted Agent 重复确认、取消、恢复和计划过期测试。

主要文件：

- `src/types.ts`
- `src/lib/serverApiConfig.ts`
- `src/lib/legacyAgentExecutor.test.ts`
- `src/components/LegacyAgentMainWorkspace.test.tsx`
- `src/restrictedAgentStore.test.ts`
- `gateway/tests/server.test.ts`

验收：

- 双 Agent 的术语和兼容规则被测试固定。
- 现有 Chat/Restricted 请求体和结果行为无回归。

### 阶段 1：双模式外壳

目标：同一部署中同时展示 Chat 和 Tool。

主要工作：

- 引入能力解析层。
- 允许 `serverApi` 与 `restrictedAgent` 同时启用。
- 新增模式切换器。
- `AgentMainWorkspace` 改为按显式 `mode` 渲染。
- `InputBar` 改为按显式 `mode` 路由提交。
- 保存 `activeTaskByMode`。

主要文件：

- `src/App.tsx`
- `src/lib/serverApiConfig.ts`
- `src/components/AgentWorkspace.tsx`
- `src/components/AgentMainWorkspace.tsx`
- `src/components/InputBar.tsx`
- 新增小型 `AgentModeSwitcher` 组件或复用现有 segmented control 模式

验收：

- 双能力部署可见两个模式。
- 单能力部署不显示无效切换项。
- 切换模式不会提交到错误执行器。

### 阶段 2：历史、会话和草稿隔离

目标：两种模式互不串联状态。

主要工作：

- 按 Agent 模式过滤历史。
- 分别维护 active task/conversation。
- 隔离 Prompt、输入图片和参数草稿。
- 排除 Gallery/OpenShop 手工记录。
- 明确删除单次 Run 与删除会话的行为。

主要文件：

- `src/components/AgentWorkspace.tsx`
- `src/components/AgentHistoryPanel.tsx`
- `src/components/InputBar.tsx`
- `src/lib/agentConversation.ts`
- `src/types.ts`
- 相关组件和 Store 测试

验收：

- Chat 与 Tool 的草稿、历史和选中状态互不污染。
- 旧任务无需迁移即可在对应模式访问。

### 阶段 3：Tool Store 多 Run 化

目标：Tool 状态不再是全局单流程。

主要工作：

- 将 `restrictedAgentStore` 演进或迁移为 `toolAgentStore`。
- 使用 `runsById + activeRunId`。
- 恢复多个 running/queued execution。
- SSE 仅作通知，查询接口作为最终状态来源。
- 切换模式或 Run 不影响后台状态订阅。

主要文件：

- `src/restrictedAgentStore.ts` 或新建 `src/toolAgentStore.ts`
- `src/lib/restrictedAgentApi.ts`
- `src/components/AgentMainWorkspace.tsx`
- `src/components/AgentPlanCard.tsx`
- 新增 Tool execution timeline 组件

验收：

- 刷新后可恢复待确认与执行中的 Run。
- 多个 Tool 历史 Run 不会覆盖彼此状态。

### 阶段 4：通用 Action 与 Tool Registry

目标：将现有图片计划迁移到通用工具计划。

主要工作：

- `generation` 升级为 `actions[]`。
- 增加 Tool Registry、参数 Schema 和 Policy 验证。
- 将图片生成/编辑封装为 Tool Adapter。
- 增加 Action 级数据库状态和事件。
- 增加 Execution 聚合状态。
- 为旧单 action API 提供兼容适配。

主要文件：

- `gateway/src/types.ts`
- `gateway/src/policy.ts`
- `gateway/src/planner.ts`
- `gateway/src/executor.ts`
- `gateway/src/worker.ts`
- `gateway/src/db.ts`
- `gateway/src/events.ts`
- `gateway/src/server.ts`
- 新增 Tool Registry/Dispatcher 模块
- 新增数据库 migration

验收：

- 现有图片生成/编辑在 action 模型下结果一致。
- 未注册工具、非法参数和错误依赖不会进入执行队列。
- 重复确认仍只创建一个 Execution。

### 阶段 5：OpenShop Tool Bridge

目标：OpenShop 能通过独立协议执行白名单 command。

主要工作：

- 扩展宿主协议类型与消息校验。
- 在 OpenShop 内新增 tool namespace handler。
- 实现 session/revision/describe/execute/export/cancel。
- 实现 command 白名单和批次约束。
- 实现隐藏 iframe Tool Runner。
- 实现输入 asset 获取和输出 asset 上传。

主要文件：

- `src/lib/openshopBridge.ts`
- `src/lib/openshopBridge.test.ts`
- `src/lib/openshopLocale.test.ts`
- `public/openshop/index.html`
- 新增 `src/lib/openShopToolRunner.ts`
- 新增对应测试

注意：修改 OpenShop 内联脚本后，需要同步检查 CSP hash 与现有 PWA/locale 契约测试。

验收：

- 白名单 command 可在隐藏 iframe 中按计划执行。
- 非白名单或非法参数返回稳定错误。
- 导出结果作为新 PNG asset 保存，原图不被覆盖。

### 阶段 6：Client Action 协调

目标：Gateway Plan 能可靠等待并接收浏览器 OpenShop 结果。

主要工作：

- 增加 `waiting_for_client` 状态。
- 增加领取 Client action 和提交结果接口。
- 前端执行条件检查与恢复。
- 页面刷新、关闭、超时和重复提交处理。
- 输出资产与 action/result 绑定。

主要文件：

- `gateway/src/types.ts`
- `gateway/src/server.ts`
- `gateway/src/db.ts`
- `gateway/src/worker.ts`
- `src/lib/restrictedAgentApi.ts`
- `src/toolAgentStore.ts`
- `src/lib/openShopToolRunner.ts`

验收：

- Client action 结果只能提交一次。
- 页面刷新后可恢复尚未开始的 action。
- 结果不确定时不会自动重放编辑。

### 阶段 7：完整验证与发布准备

目标：验证双 Agent、工具执行和 OpenShop 端到端链路。

主要工作：

- 补齐前端、Gateway、bridge 和浏览器 E2E。
- 将测试加入 CI 发布门禁。
- 增加独立能力开关和熔断顺序。
- 验证静态部署、Gateway 部署和 Docker 部署矩阵。
- 验证协议兼容和回滚。

验收：

- Chat Agent 故障与 Tool Agent 故障互不替代。
- OpenShop 工具可独立关闭。
- 执行中切换模式、刷新和取消行为符合状态定义。
- 发布前测试和构建全部通过。

## 14. 测试矩阵

| 范围 | 必测场景 |
|---|---|
| Chat 回归 | 流式、非流式、多轮、partial image、错误、完成结果持久化 |
| 模式能力 | chat only、tool only、双能力、全部禁用 |
| 模式切换 | Chat 流中切 Tool 再返回；Tool 执行中切 Chat 再返回 |
| 状态隔离 | active task、conversation、Prompt、图片、参数草稿独立 |
| 历史兼容 | 旧 `agent`、旧 `restricted-agent`、Gallery、OpenShop 记录归属 |
| 计划 | 严格 Schema、未知工具、非法依赖、过期、版本冲突、重复确认 |
| Action | 成功、失败、跳过、取消、部分完成、failed_unknown |
| 图片工具 | generate/edit 参数映射、输入资产、输出数量和格式 |
| OpenShop bridge | source/origin/version/id/session/revision、迟到与重复响应 |
| OpenShop command | 每个白名单 command 的合法和边界参数、批次回滚 |
| Client runtime | 领取、刷新恢复、超时、重复提交、页面关闭 |
| 资产 | 输入输出引用、上传失败、历史写入、原图不覆盖 |
| 部署 | Gateway 前缀、SSE、运行时配置、Docker health/readiness |
| 协议兼容 | 新前端配旧 Gateway、旧前端配新 Gateway |

建议发布门禁：

```text
npm ci
npm --prefix gateway ci
npm run test:all
npm run build:all
Docker smoke test
Tool Agent Chromium E2E
```

Gateway 要求 Node.js 22，CI 应统一使用 Node.js 22。

## 15. 可观测性

一次 Tool Agent 执行需要贯穿以下标识：

```text
sessionId
  -> conversationId
    -> planId
      -> executionId
        -> actionId
          -> bridgeRequestId
            -> input/output assetId
```

至少记录：

- Agent mode。
- Planner/确认/排队/执行耗时。
- tool name/version/runtime。
- action status 与稳定错误码。
- 输入输出 asset ID、hash、尺寸和字节数。
- Client action 领取、超时和提交结果。
- OpenShop command 名称与数量。

核心指标：

- 计划创建、确认、执行和取消数量。
- Action 成功率、失败率、跳过率、`failed_unknown` 比例。
- Planner、排队、Gateway action、Client action、OpenShop 导入/执行/导出耗时。
- SSE 重连、轮询校正和 iframe 启动失败。
- 队列深度、并发数和资产存储使用量。

## 16. 灰度与回滚

建议三个独立能力开关：

- Chat Agent 开关。
- Tool Agent 开关。
- OpenShop Tool 开关。

回滚顺序：

1. 关闭 OpenShop Tool，Tool Agent 仍可使用图片生成/编辑。
2. 关闭 Tool Agent 新计划和新确认，保留已有执行查询。
3. 回退 Gateway/前端版本。

数据库 migration 只做向前兼容的新增，不依赖紧急回滚时删除表或字段。未知 action/tool/协议版本必须明确失败，不能静默降级为其他图片操作。

## 17. 主要实施风险与控制

本节只讨论需求与当前实现的工程风险。

| 风险 | 影响 | 控制 |
|---|---|---|
| 能力与模式继续混用 | 双 Agent 仍会被配置硬切 | 组件只接收解析后的 capabilities 和显式 mode |
| 历史未隔离 | 不同来源任务串入错误工作区 | 建立统一 `getAgentMode(task)` 兼容函数 |
| Chat 流状态只在内存 | 模式切换卸载后增量 UI 丢失 | 保持执行订阅独立于可见组件，或避免卸载运行中视图状态 |
| Tool Store 仍是单例 | 多 Run 覆盖和恢复失败 | 先完成 runsById，再接通用工具 |
| 展示步骤与实际 action 分离 | 用户确认内容与执行内容不一致 | UI 直接渲染冻结 `actions[]` |
| Worker 只支持一次调用 | 无法表达部分成功 | 增加 Action 持久化和聚合状态 |
| Client action 依赖页面存活 | 页面关闭后执行停滞 | MVP 限制 OpenShop 为最后一步并支持重新领取未开始 action |
| OpenShop command 参数依赖对象 ID | Planner 规划时可能没有稳定 ID | 先 describe，再绑定 ID；必要时限制为单图层图片操作 |
| OpenShop 内联产物体积大 | 修改审查和 CSP 更新容易遗漏 | Bridge 改动集中、增加契约测试和 CSP 检查 |
| 一次性重命名 Restricted Agent | 配置、API、历史兼容范围过大 | 产品文案先称 Tool Agent，代码键分阶段迁移 |

## 18. 里程碑与交付物

| 里程碑 | 可交付结果 |
|---|---|
| M1 双模式并存 | Chat/Tool 可切换，提交路由正确，历史初步隔离 |
| M2 状态稳定 | 草稿隔离、Tool 多 Run、刷新恢复和取消行为稳定 |
| M3 通用工具内核 | 图片生成/编辑迁移到 actions + registry + dispatcher |
| M4 OpenShop Bridge | 白名单 command 可通过隐藏 iframe 原子执行并导出 |
| M5 端到端 Tool Agent | 确认计划后完成图片生成或 OpenShop 编辑并保存历史 |
| M6 发布准备 | CI、E2E、部署矩阵、灰度开关和回滚验证完成 |

## 19. 完成定义

满足以下条件才视为本方案实施完成：

- Chat Agent 的现有流式体验和多轮会话没有行为回归。
- Tool Agent 可独立选择，不再替换 Chat Agent。
- 两种模式的历史、会话、草稿和活动状态隔离。
- Tool Plan 使用实际可执行的冻结 `actions[]`。
- 图片生成/编辑通过 Tool Registry 执行。
- OpenShop 可以执行首批白名单 command 并导出新资产。
- Action 级状态、错误、取消和部分完成在 UI 可见。
- 刷新和模式切换不会造成隐式重复执行。
- 旧任务和旧部署配置在兼容规则下继续工作。
- 单元、集成、Gateway 和 Chromium E2E 通过。

## 20. 对抗式审查问题

创建本计划后，需要从需求和当前实现角度重点挑战以下假设：

1. 用户是否真的需要在 Agent 内显式切换模式，还是应由任务意图自动路由。
2. Tool Agent 是否需要多轮会话，还是 Run 列表已经足够。
3. `client_runtime` 是否会让 Gateway 的执行一致性变得过于复杂。
4. OpenShop 是否应作为一个粗粒度工具，还是拆成多个业务语义工具。
5. `actions[]` 通用化是否过早，能否用更小改动先验证需求。
6. OpenShop command 的对象 ID 是否足够稳定，可否支持基于输入图片的确定性规划。
7. 双模式草稿隔离是否值得首轮实现，还是可以先共享输入区。
8. 当前 TaskRecord 是否适合继续承载 Tool Run 结果。

这些问题已经由五个独立子代理从需求、Legacy、Gateway、OpenShop 和交付五个维度完成审查。结论与修订执行计划如下。

## 21. 对抗式审查结论

### 21.1 保留的核心方向

- 保留 Chat Agent。
- 新增独立 Tool Agent。
- 两种能力在同一部署中并存。
- Tool Agent 使用计划确认后执行的受控流程。
- OpenShop 通过结构化 bridge 执行，不依赖 UI 点击。
- 输出始终保存为新图片，不覆盖原图。

### 21.2 被否定或降级的假设

| 原假设 | 审查结论 | 修订 |
|---|---|---|
| 首轮必须建设通用 `actions[]` | 当前需求只证明单工具单执行 | MVP 使用单一 operation 联合 |
| Tool Agent 首轮需要 Conversation | 没有跨 Run 继承契约 | Tool 历史先展示独立 Run |
| Tool Store 多 Run 是 OpenShop 前置 | 它属于并发体验，不是工具验证前置 | MVP 允许单活动 Plan，历史保存完成 Run |
| OpenShop 可复用隐藏 iframe | dirty modal 和零尺寸布局会阻塞 | 每次创建固定尺寸离屏 iframe，用完销毁 |
| Planner 可以冻结 objectId/layerId | ID 在导入后生成且可能被 raster 操作重建 | Planner 仅输出逻辑 target；MVP 不开放对象/图层命令 |
| 任意白名单 command 可原子组合 | command 会改变文档结构，no-op 语义也不一致 | 新增专用 `_executeToolBatch()` 和组合测试 |
| `serverApi.enabled` 等于 Chat 可用 | 本地 API Profile 也能提供 Chat | 单独计算 chatAllowed/configured/usable |
| 请求继续即可保留流体验 | Legacy 增量状态在组件本地，卸载会丢事件 | 状态外移或切换时保持组件挂载 |
| 现有 migration 文件可直接新增 | Gateway 没有 migration runner | DB 改动前先建立 migration 机制 |
| 阶段 7 再补 CI/E2E | 会让前面阶段无法客观验收 | CI、fixture、E2E 基础前移到阶段 0 |

### 21.3 需求层面的反对意见处理

审查提出“单一 Agent 入口按任务意图自动路由”可能比显式模式更自然。该观点成立，但与当前已确认的“双 Agent”产品方向不同。

本计划的处理：

- MVP 继续提供显式 Chat/Tool 模式切换。
- 模式文案必须以用户任务结果描述，避免要求用户理解内部架构。
- 记录切换率、误提交和从生成转编辑的路径。
- 双模式稳定后，再比较显式选择与自动路由。

### 21.4 当前实现中必须先修正的问题

- Legacy 流状态位于 `LegacyAgentMainWorkspace` 本地 state，条件卸载会丢增量事件。
- Legacy 快速重复提交可能计算相同 conversation turn。
- 通用 `retryTask()` 会丢失 Legacy Agent 来源和会话执行路径。
- 异步提交完成后清理的是当前全局输入，可能误清另一个模式的新草稿。
- Agent 历史和自动选中从全部 Task 开始，没有先按来源过滤。
- Docker 注入脚本与运行时配置同样禁止双能力，不只是前端校验。
- Gateway 只能按已知 ID 查询 Plan/Execution，不支持枚举恢复多个 Run。
- OpenShop 当前没有 Client 输出上传入口；本地 `saveOpenShopEdit()` 与 Gateway asset 是两套存储路径。

## 22. 修订后的 MVP 用户故事

### 22.1 Chat 普通生成

用户选择 Chat，输入图片需求并提交。系统保持现有流式文本、工具状态、partial image 和多轮上下文行为。

验收：切到 Tool 再切回后，最新流状态完整可见；不会误选 Tool Run，也不会丢失 partial image。

### 22.2 已有图片确定性编辑

用户选择 Tool，提供一张已有图片并要求裁剪、旋转、翻转或 flatten。Planner 返回单一 `openshop.edit` operation，用户确认后浏览器执行并保存新图片。

验收：原图保留；新 Task 包含来源、冻结 command snapshot 和输出图片。

### 22.3 待确认时修改需求

用户生成 Plan 后修改 Prompt、输入图片、Mask 或参数。

验收：旧 Plan 标记过时，确认按钮不可执行旧快照；重新提交产生新 Plan，当前草稿不被 `originalRequest` 覆盖。

### 22.4 生成后继续编辑

MVP 不在一个 Tool Plan 中串联生成和 OpenShop。用户先在 Chat 完成生成，再把结果作为 Tool 输入发起新 Run。

验收：选择生成结果进入 Tool 时，输入来源清晰；两个 Run 的历史关系可通过 `sourceTaskId` 追溯，但不创建 Tool Conversation。

## 23. 修订后的实施计划

### 阶段 0：可验证基线

目标：先建立后续改动的客观门禁。

工作：

- 前端和 Gateway CI 统一 Node.js 22。
- PR 执行 `npm run test:all` 和 `npm run build:all`。
- 引入 Chromium E2E 基础和确定性 Planner/Executor fixture。
- 增加运行时配置与 Docker 注入脚本测试。
- 固定 Chat 请求体、流事件、Restricted Plan/Execution 响应 fixture。
- 定义 Docker 验证后的容器、镜像和临时卷清理步骤。

文件：

- `package.json`
- `.github/workflows/deploy.yml`
- `.github/workflows/docker.yml`
- `gateway/package.json`
- 新增 E2E 配置和最小 smoke 测试

验收：

- PR 测试失败时不能进入发布 job。
- Chromium 能跑通当前 Chat 或 OpenShop 手工编辑的最小页面流程。

### 阶段 1：Legacy Chat 兼容修正

目标：双模式不会破坏现有 Chat。

工作：

- 建立 `chatAllowed/chatConfigured/chatUsable` 能力解析。
- 将 Legacy session/event snapshot 移到长生命周期 Store，或在 MVP 中保持 Chat Workspace 挂载。
- 为同一 conversation 增加提交锁或 turn 分配原子化。
- 增加专用 `retryAgentTask()`。
- 明确失败流的 assistant partial text 持久化策略。
- 提交时冻结完整草稿快照，异步完成后按版本清理来源草稿。

文件：

- `src/lib/serverApiConfig.ts`
- `src/lib/legacyAgentExecutor.ts`
- `src/components/LegacyAgentMainWorkspace.tsx`
- `src/components/InputBar.tsx`
- `src/store.ts`
- `src/lib/agentConversation.ts`

验收：

- 本地 API Profile 和 serverApi 两种 Chat 配置均能被正确识别。
- 流中切换模式再返回，文本、工具状态和 partial image 不丢失。
- Agent 重试仍属于原会话并走 Responses Agent 执行路径。

### 阶段 2：双 Agent 并存外壳

目标：同一部署提供 Chat 和 Tool 两条路径。

工作：

- 移除前端和 Docker 配置中的双能力互斥。
- 增加显式模式切换器。
- Workspace 和 InputBar 使用显式 mode，不直接读取 Restricted 能力作为当前模式。
- AgentWorkspace 在排序和自动选中前先按模式过滤 Task。
- 首轮继续用 `origin` 判断模式，不双写 `agentMode`。
- 维护 `activeTaskByMode` 和独立完整草稿。

文件：

- `src/App.tsx`
- `src/components/AgentWorkspace.tsx`
- `src/components/AgentHistoryPanel.tsx`
- `src/components/AgentMainWorkspace.tsx`
- `src/components/InputBar.tsx`
- `src/lib/serverApiConfig.ts`
- `deploy/migrate-api-env.envsh`
- `deploy/inject-api-url.sh`
- `docker-compose.yml`

验收：

- chat only、tool only、双能力和全部不可用四种配置有明确 UI。
- 两种模式不会自动选中对方的 Task。
- 异步完成不会清除另一个模式的新草稿。

### 阶段 3：OpenShop Bridge 独立 MVP

目标：不接 Planner，先证明确定性编辑工具本身可执行。

工作：

- 新增 `tool:hello/configure/execute/export/error`。
- 新增 `_executeToolBatch()`。
- 使用一次性、固定尺寸离屏 iframe。
- 首批仅支持 crop/rotate/flip/flatten。
- 使用逻辑 target，不输出随机 objectId。
- 复用 `saveOpenShopEdit()` 保存本地新 Task。
- 为第二次连续执行、组合命令和像素结果增加真实浏览器测试。

文件：

- `src/lib/openshopBridge.ts`
- `src/lib/openshopBridge.test.ts`
- `src/lib/openshopLocale.test.ts`
- `public/openshop/index.html`
- 新增 `src/lib/openShopToolRunner.ts`
- `src/store.ts`

验收：

- 同一输入重复执行不会出现 dirty modal。
- iframe 始终具有可用布局尺寸。
- command 失败不产生成功 Task。
- 输出 PNG 与预期裁剪/旋转/翻转像素一致。

### 阶段 4：单 Operation Tool Plan

目标：让 Tool Planner 选择图片 API 或 OpenShop，但一次只执行一种 operation。

工作：

- Plan 增加 `schemaVersion` 与 operation 判别联合。
- 保持旧 `generation` 计划读取兼容。
- Planner 可以输出 `image.generate`、`image.edit` 或 `openshop.edit`。
- OpenShop Plan 只接受已有图片和 canvas command。
- Plan 保存完整 Composer snapshot hash。
- Tool UI 直接展示实际 operation 和冻结 command。

文件：

- `gateway/src/types.ts`
- `gateway/src/policy.ts`
- `gateway/src/planner.ts`
- `gateway/src/server.ts`
- `src/types.ts`
- `src/restrictedAgentStore.ts`
- `src/components/AgentPlanCard.tsx`

验收：

- 旧图片生成/编辑行为和计量保持一致。
- OpenShop operation 不包含 objectId/layerId。
- 修改输入后旧 Plan 不可确认。

### 阶段 5：Tool 前端执行整合

目标：确认 `openshop.edit` 后完成浏览器执行和历史保存。

工作：

- 根据 operation 选择 Gateway 图片执行或本地 OpenShop Runner。
- OpenShop 执行使用本地 Run 状态，不新增 Action 表。
- 记录 Plan ID、冻结 command snapshot、sourceTaskId 和本地保存状态。
- 定义页面关闭、超时、导出失败和本地保存失败的恢复路径。
- Tool 历史按独立 Run 展示，不建立 Conversation。

验收：

- 重复确认不会重复创建结果。
- 页面刷新后不会隐式重放已经开始的 OpenShop 编辑。
- 本地保存失败可从导出 Blob 或来源 Task 明确重试。

### 阶段 6：部署验证与 MVP 发布

目标：形成可灰度、可回退的首个 Tool Agent。

验证顺序：

1. 单元与集成测试。
2. 前端和 Gateway build。
3. Docker 镜像构建。
4. 双能力配置注入验证。
5. Gateway/API smoke。
6. Chromium 双 Agent 与 OpenShop E2E。
7. 重启、刷新和重复确认验证。
8. 清理测试容器、镜像和临时卷。

静态部署只验收 Chat 可用性和 Tool 能力正确降级，不要求 OpenShop Tool Gateway E2E。

## 24. MVP 完成定义

MVP 只有在以下可观察结果全部成立时完成：

- 本地 Profile Chat 和 serverApi Chat 均保持现有流式行为。
- Chat/Tool 可以在同一运行时配置中启用并显式切换。
- 模式切换期间 Chat 增量状态不丢失。
- 两种模式的 Task 自动选择、历史和完整草稿不串用。
- Tool Planner 一次只输出一个 operation。
- `openshop.edit` 只接受已有图片和首批 canvas command。
- 用户确认后，Runner 创建一次性离屏 iframe，导入、执行、导出并销毁。
- 输出保存为新 Task，原图不变。
- command、导出或保存失败不会产生完成记录。
- 重复确认和刷新不会导致隐式重复执行。
- 前端、Gateway、Docker 配置和 Chromium E2E 通过。

## 25. 后续演进触发条件

只有满足对应条件后才进入完整目标架构：

| 能力 | 触发条件 |
|---|---|
| `actions[]` | 已确认存在生成后自动编辑或两个以上异构工具串联需求 |
| Tool Registry/Dispatcher | 接入第二个与 OpenShop 不同的工具类型 |
| `execution_actions` | 单 Execution 需要持久化多个步骤或部分成功 |
| Client output 上传 Gateway | 需要跨设备恢复、服务端续跑或统一资产审计 |
| Tool Conversation | 明确跨 Run 追问、上下文继承和删除语义 |
| 多 Run Store | 用户需要同时规划或执行多个 Tool Run |
| layer/object command | 建立稳定 selector 与 raster 化后的重新绑定规则 |
| session/revision | 需要复用 OpenShop session 或支持并发修改 |
| 通用 Artifact | 出现图片以外的工具输出类型 |

## 26. 本轮审查范围说明

本轮对抗式分析严格限定在需求、产品行为、当前实现、数据模型、测试和交付路径，没有把网络安全、渗透或攻防内容纳入方案取舍。
