# 统一图片 Agent 设计

> 状态：设计已确认，待用户复核本文档
>
> 日期：2026-08-13
>
> 对应 PRD：[统一图片 Agent PRD](./2026-08-13-unified-image-agent-prd.md)

## 1. 范围与已确认决策

本次实现 PRD 的 P0 和 P1：统一 Agent 体验、自动路由、统一会话，以及严格尺寸 Tool Pipeline。P2 的 OpenShop 跨链编排不在本次范围；OpenShop 仍可作为单独的、不可与其他 action 串联的兼容 action。

已确认的产品默认值：

- Tool Pipeline 不要求用户确认。计划生成并校验后自动入队，计划卡只显示进度、审计、取消、失败和重试。
- 用户仅给出精确宽高、未说明裁切策略时，默认 `cover + center`。
- 有显式参考图、但无硬约束的语义编辑优先使用 Responses，以保留流式文本和 partial image。
- Responses 不可用时，整个 Agent 阻断；Tool Pipeline 不能单独作为降级入口。
- Gateway 不可用时，无硬约束的普通请求仍可使用可用的 Responses；包含硬约束的请求明确失败，绝不回退到 Responses。
- 含后处理 action 的生成或编辑固定产出一张图片，避免未定义的多图扇出。普通无硬约束生成仍可按现有能力请求多图。

## 2. 总体架构

前台只保留一个 Agent 工作区和一个提交入口。每个回合先由纯函数路由器解析请求，再执行对应后端路径：

```text
用户输入、显式附件、当前会话
        │
        ▼
AgentRoute（规则优先的硬约束提取）
        │
        ├─ responses_image ──► Responses 流式生成 / 语义编辑
        │
        ├─ tool_pipeline ────► Gateway
        │                         image.generate | image.edit
        │                              → image.transform → metadata.assert
        │
        ├─ clarify ──────────► 当前会话中的澄清回合
        │
        └─ unsupported ──────► 当前会话中的明确失败回合
```

新增 `src/lib/agentRoute.ts`，输出固定的路由合同：

```ts
type AgentRoute = 'responses_image' | 'tool_pipeline' | 'clarify' | 'unsupported'

interface AgentRouteDecision {
  route: AgentRoute
  routeReason: string
  hardConstraints: string[]
  fallbackForbidden: boolean
  finalOutputSpec: FinalOutputSpec | null
}
```

硬约束包括精确像素宽高、固定比例或画布、裁切、旋转、翻转、缩放、格式、透明背景、压缩、文件交付要求和明确工具要求。命中任一项时，路由器只能返回 `tool_pipeline`、`clarify` 或 `unsupported`，并令 `fallbackForbidden` 为 `true`。

路由防线分为三层：

1. 统一提交入口先调用路由器，只有 `responses_image` 可以进入 Responses 执行器。
2. `legacyAgentExecutor` 在真正发起 `/responses` 前再次断言没有硬约束，避免未来调用点遗漏路由。
3. Gateway 对 Tool Pipeline 的 action、最终规格和 action 顺序重新做白名单校验；非法 Planner 输出直接失败，不存在返回 Responses 的代码分支。

服务端统一配置部署中，普通 Responses 请求通过 Gateway 的受控流式代理，并由同一套路由规则再次校验和记录审计。使用本地 API Key 的 BYOK 部署仍可直接调用 Responses；浏览器直连不是可由服务端完全强制的安全边界，但应用内有前两层守卫，且硬约束路径绝不会由受支持的 UI 进入直连 Responses。

Agent 可用性由 Responses 决定。Responses 配置缺失、不可用或健康检查失败时，Agent 工作区和输入直接提示不可用；Gateway 不会单独解锁 Tool Pipeline。Gateway 仅影响 `tool_pipeline`：其不可用时，普通 Responses 回合可继续，硬约束回合明确失败。

## 3. 统一会话与交互

`AgentMode`、Chat/Tool tab、`agent-mode-v1` 偏好、按模式活动任务和 `gallery | chat | tool` 草稿范围移除。新的 Composer scope 为 `gallery | agent`。

每次 Agent 提交都基于当前统一会话创建或续接 `agentConversationId`，并在提交时立即建立本地回合任务。Tool Pipeline 的规划中、排队中、执行中和完成状态均写在该回合上，因此任务完成不会抢占用户正在阅读的其他会话。

新回合统一记录以下信息；旧字段继续保留用于读取旧数据和恢复：

```ts
{
  origin: 'agent',
  agentConversationId: string,
  agentTurn: number,
  agentExecutionRoute:
    | 'responses_image'
    | 'gateway_image_generate'
    | 'gateway_image_edit'
    | 'image_transform'
    | 'openshop',
  agentRouteReason?: string,
  agentHardConstraints?: string[],
  agentFallbackForbidden?: boolean,
  agentFinalOutputSpec?: FinalOutputSpec,
  agentPlanId?: string,
  agentExecutionId?: string,
}
```

计划卡状态改为“分析执行方式 → 排队 → 执行 action → 校验 → 完成/失败/已取消”。不显示确认或“返回修改”按钮；取消会向 Gateway 发送取消请求，重试会基于原始不可变输入创建新的回合和新资产。

历史聚合规则：

- 新的 Responses 和 Tool Pipeline 回合都按 `agentConversationId` 聚合，并按 `agentTurn`、创建时间排序。
- 旧 Chat 继续使用已有会话 ID；缺少 ID 的旧记录各自显示为兼容会话。
- 旧 Tool Run 与旧 OpenShop Run 各自显示为一个只读兼容会话；不根据时间、标题或 Prompt 自动合并。
- 删除当前会话时选择相邻会话；后台任务完成只更新对应条目，不改当前选择。

历史图片不会因“上一张”“刚才的图”等文本指代而自动上传。只有附件、`@图片`、结果卡“继续编辑”或“作为参考图”建立的显式绑定可作为 API 输入；未绑定时新增澄清回合。

草稿迁移将从旧 `chat` 和 `tool` 草稿中选择非空且 `composerVersion` 更高的一份；版本相同时选 Chat。迁移完成后仅写入 `agent`，保留旧草稿字段一个兼容版本周期但不再更新。

## 4. Tool Pipeline 与严格输出

Gateway 新增 schema v3，同时保留 schema v1/v2 的只读和恢复兼容。v3 计划最多包含三个、固定顺序的 action；计划一经创建即在服务端原子地创建 execution 并入队，不进入 `awaiting_confirmation`。

允许的 action 目录为：

```text
image.generate
image.edit
image.transform
metadata.assert
openshop.edit
```

P1 的有效线性链：

```text
image.generate | image.edit → image.transform → metadata.assert
image.transform → metadata.assert
openshop.edit
```

`openshop.edit` 在本期仅允许单独执行，不参与生成、尺寸处理或导出链。每个 action 记录规范化参数、输入 artifact、输出 artifact、状态、错误、开始时间、结束时间与幂等键。数据库新增 action 和 artifact 关联表，使用 `execution_id + action_index` 保证同一执行中的步骤唯一；运行时在 `gateway/src/db.ts` 执行幂等前向迁移，不能只依赖未接入运行时的 SQL 文件。

`image.transform` 由 Gateway 的 `sharp` 实现，并始终写入新资产。规范化参数覆盖：

```ts
{
  width?: number,
  height?: number,
  fit?: 'cover' | 'contain' | 'fill',
  position?: 'center' | 'left' | 'right' | 'top' | 'bottom',
  crop?: { x: number, y: number, width: number, height: number },
  rotate?: 90 | -90 | 180 | -180,
  flip?: 'horizontal' | 'vertical',
  background?: string,
  outputFormat: 'png' | 'jpeg' | 'webp',
  outputCompression?: number | null,
}
```

`metadata.assert` 读取实际产物 metadata，断言要求的宽高、格式和透明能力。断言失败即令 action 与 execution 失败，不能将任务显示为完成，也不能回退到 Responses。纯旋转、翻转、裁切或缩放不调用 Images API。

尺寸策略如下：

- 仅给宽高：`cover + center`。
- 明确“不裁切”：`contain`。
- 明确允许变形：`fill`。
- JPEG 与透明背景冲突时返回 `clarify`；PNG/WebP 可以保留透明。
- `contain` 输出 JPEG 且用户未给背景色时使用白色背景，并将该假设记录在审计中。

生成候选尺寸仍使用 Images API 支持的合法尺寸；`FinalOutputSpec` 单独表达最终的宽高、格式、适配策略、位置、背景和压缩，不能复用候选生成尺寸字段。

## 5. 自动执行、恢复与失败处理

新增 Gateway 自动提交接口，将“创建不可变计划”和“以该版本创建 execution”作为同一事务完成。现有带 `If-Match` 与 Composer 快照哈希的确认接口保留给旧计划、兼容读取和恢复，但新统一 Agent 不展示也不调用用户确认流程。

自动执行使用提交时冻结的 Composer 快照和哈希。用户随后修改输入只会影响下一回合，不会使已入队回合静默改变。取消会终止当前 action 并阻止后续 action；不会覆盖原图。重启恢复、队列和幂等执行沿用现有 Gateway 机制并扩展至 action 级状态。

失败策略：

- Gateway 不可用且请求包含硬约束：当前回合失败，说明严格规格无法保证；不调用 Responses。
- Planner 返回未注册 action、非法 action 顺序或超出三步：fail closed。
- transform 或 metadata.assert 失败：execution 失败，已生成的中间资产可用于审计但不作为成功结果。
- 历史图片未显式绑定：返回 `clarify`，不上传图片。
- 约束冲突或当前工具无法表达：返回 `clarify` 或 `unsupported`，不猜测近似值。
- OpenShop 浏览器刷新中断：标记中断，不自动重放；已导出但保存失败时只重试保存。

## 6. 页面与可访问性

`AgentWorkspace`、`AgentHistoryPanel`、`AgentMainWorkspace` 与 `InputBar` 改为单一 Agent 视图。底部提示文案统一为：

> 描述想生成或编辑的图片；可添加参考图，也可指定尺寸、裁剪或旋转。

发送按钮统一为“发送”。执行路径只在 `AgentExecutionDetails` 的折叠审计中展示业务语义，例如“图片生成”“严格尺寸处理”“确定性编辑”，不暴露 Chat/Tool/API 等要求用户选择的模式。计划进度、取消、重试、详情和结果卡都必须具有可访问名称；移动端抽屉和焦点约束沿用现有实现并做回归测试。

## 7. 兼容与迁移

- 旧 `origin: 'agent' | 'restricted-agent' | 'openshop'` 全部可读；新 Tool 回合使用 `origin: 'agent'`。
- `agentMode` 旧偏好只读忽略，不再写回；不存在自动模式选择。
- schema v1/v2 Gateway 计划、旧 execution 和 asset URL 保持读取与取消/恢复兼容；新增 schema v3 不改变旧记录。
- 旧 Tool Run 不重放，旧中断的 OpenShop Run 不重放。
- 不覆盖原图，不覆盖用户已有的未跟踪工作区内容。

## 8. 验证策略

前端单元测试覆盖：

1. 路由器对 `870×220`、比例、格式、裁切、旋转和历史图片指代的决策。
2. 硬约束请求不会调用 Responses API；普通生成继续产生流式和 partial image。
3. Responses 不可用时 Agent 整体阻断；Gateway 不可用时仅硬约束失败。
4. 单一草稿、单一历史、后台完成不抢占会话、旧记录兼容聚合与显式图片引用。
5. 计划卡无确认控件，具备 action 进度、取消和失败状态的可访问名称。

Gateway 集成测试覆盖：

1. schema v3 action 链、三步上限、非法 action 与非法顺序 fail closed。
2. `generate/edit → transform → metadata.assert` 的真实产物尺寸与格式校验。
3. 纯 transform 的 Images API 调用次数为零。
4. metadata 不匹配时 execution 不完成，且没有 Responses 回退。
5. 取消、幂等、重启恢复、旧 schema 读取和数据库前向迁移。

端到端测试覆盖桌面端和移动端的统一 Agent 工作区、无模式切换、连续多轮会话、流式普通生成、严格尺寸处理以及焦点管理。仓库存在 Docker 部署配置；是否另行进行 Docker 集成测试将在实现验证前由用户明确确认，测试产生的镜像或临时产物会在完成后清理。

## 9. 实施边界

本实现不增加无限循环式规划、DAG、历史图片自动上传、原图覆盖、OpenShop 跨链编排或通用工作流引擎。与本功能无关的未跟踪内容 `docs/openshop-agent-tool-evaluation.md` 和 `image-sample-library/` 不纳入任何提交。
