# 统一图片 Agent PRD

> 状态：待评审
>
> 日期：2026-08-13
>
> 范围：将当前用户可见的 Chat Agent 与 Tool Agent 合并为单一 Agent 体验；保留两类内部执行能力。

## 1. 背景

当前产品有两条用户可见的 Agent 路径：

- Chat Agent：通过 Responses API 的内置 `image_generation` 工具进行流式文生图、参考图编辑和遮罩编辑。
- Tool Agent：通过 Gateway 进行结构化规划、用户确认、Images API 调用和 OpenShop 确定性编辑。

这会把本应由系统处理的技术选择交给用户。用户需要判断何时应切换 Chat 或 Tool；同一任务中“生成图片 → 调整到指定尺寸 → 旋转/裁剪”的回合也被拆到不同历史中。

同时，Responses 内置生图的输出尺寸由模型和 API 能力决定，不能承诺任意像素尺寸。用户提出 `870×220 px`、严格比例、裁剪或旋转等要求时，若系统改走模型自选尺寸的生图路径，会产生“看似完成、实际不符合交付规格”的问题。

## 2. 产品结论

前台统一为一个 **Agent**：一个入口、一个输入框、一份历史、一个多轮对话流。

后台仍保留并按请求选择两种执行路径：

| 内部路径 | 适用请求 | 用户价值 |
| --- | --- | --- |
| Responses `image_generation` | 无严格交付约束的文生图、语义图生图 | 流式输出、partial image、低等待感 |
| Tool Pipeline | Images API 文生图/图生图、精确尺寸、裁剪、旋转、格式转换等 | 可控、可审计、可验证最终产物 |

Tool Pipeline 保留调用 Images API 的文生图和图生图能力。它不是“只能做确定性编辑”的受限模式；区别在于它可以在生成后继续执行确定性工具，并验证最终交付规格。

## 3. 目标

1. 移除用户可见的 Chat / Tool 模式切换。
2. 在同一会话内连续完成快速生图、图生图、精确尺寸导出和确定性编辑。
3. 将精确宽高、比例、裁剪、旋转、格式等识别为硬约束，并锁定到 Tool Pipeline。
4. 允许 Tool Pipeline 调用 Images API，再通过确定性后处理保证最终尺寸和格式。
5. 工具链无法满足硬约束时，明确澄清或失败；不得静默降级为模型自选尺寸的生图。
6. 保留现有 Chat 流式体验、Gateway 的确认/队列/取消能力，以及旧历史数据可读性。

## 4. 非目标

1. V1 不实现模型无限循环式规划、执行、观察、再规划。
2. V1 不实现 DAG 或通用工作流引擎；仅支持有限数量、顺序执行的 action。
3. V1 不自动把历史图片重新上传给模型。
4. V1 不修改或覆盖原图；每次结果都创建新资产。
5. V1 不把 OpenShop 浏览器操作作为精确尺寸闭环的唯一或关键实现。
6. V1 不要求用户理解或手动选择底层 API、模型、执行器。

## 5. 用户体验

### 5.1 单一 Agent 工作区

页面统一使用“Agent”命名，移除桌面端和移动端的 Chat / Tool tab、模式偏好和按模式拆分的历史。

用户始终面对：

- 一个 Agent 入口；
- 一个输入框；
- 一份会话历史；
- 一个按时间排序的多轮对话流；
- 一套统一的计划、进度、结果、失败和恢复交互。

底部输入框提示文案：

> 描述想生成或编辑的图片；可添加参考图，也可指定尺寸、裁剪或旋转。

发送按钮统一为“发送”。执行路径只作为执行详情展示，不作为用户必须操作的模式。

### 5.2 请求示例

| 用户输入 | 系统内部路径 | 用户可见行为 |
| --- | --- | --- |
| “生成一张雨夜赛博朋克街道” | Responses | 直接流式生成，可出现 partial image |
| “把这张照片的天空改成黄昏” | Responses 或 Tool Pipeline | 显示生成进度，返回编辑结果 |
| “把这张图顺时针旋转 90°” | Tool Pipeline → `image.transform` | 显示“正在旋转图片”，不调用生图 API |
| “做一张 870×220 的夏日咖啡横幅” | Tool Pipeline → Images API → `image.transform` | 显示严格尺寸计划，最终保证 `870×220 px` |
| “把人物移到右侧，并输出 1200×628” | Tool Pipeline → Images API 编辑 → `image.transform` | 语义编辑后再严格输出指定尺寸 |

### 5.3 统一会话示例

同一会话可连续完成：

1. “生成一张雨夜城市”；
2. “把刚生成的图做成 1200×628 横幅”；
3. “再向右旋转 90°”；
4. “基于这张结果生成一个更明亮的版本”。

历史只显示一个会话条目，所有回合按时间连续呈现；用户无需切换模式。

## 6. 路由策略

### 6.1 路由结果

每个用户回合先经过约束提取和路由决策。路由器只输出以下结果：

```ts
type AgentRoute =
  | 'responses_image'
  | 'tool_pipeline'
  | 'clarify'
  | 'unsupported'
```

每次决策记录以下审计信息，默认折叠在执行详情中：

```ts
{
  route,
  routeReason,
  hardConstraints,
  fallbackForbidden,
  finalOutputSpec,
}
```

### 6.2 硬约束

以下内容属于硬约束：

- 明确像素尺寸，例如 `870×220`、`1200 x 628 px`；
- 严格比例或固定画布；
- 裁剪、旋转、翻转、缩放；
- 明确格式、透明背景、压缩或文件交付要求；
- 用户明确要求使用某个工具；
- 生成或图生图之后仍需保证最终像素尺寸。

出现任一硬约束时，路由必须为 `tool_pipeline`、`clarify` 或 `unsupported`，不得进入 `responses_image`。

### 6.3 路由规则

| 条件 | 路由 | 说明 |
| --- | --- | --- |
| 开放式文生图，无硬约束 | `responses_image` | 保留快速流式体验 |
| 有参考图，仅要求语义编辑，无硬约束 | `responses_image` 或 `tool_pipeline` | 依据执行器能力、部署能力和用户偏好选择 |
| 精确尺寸、固定比例、格式或裁剪要求 | `tool_pipeline` | 最终必须经过确定性输出和校验 |
| 纯旋转、翻转、裁剪、缩放 | `tool_pipeline` | 不调用 Images API |
| 指代的历史图片不明确 | `clarify` | 要求用户显式选择或引用图片 |
| 要求彼此冲突，或当前工具无法满足 | `clarify` 或 `unsupported` | 不猜测、不近似完成 |

### 6.4 禁止静默降级

一旦请求被判定为 `tool_pipeline`，`fallbackForbidden` 必须为 `true`。以下情况不得自动改走 Responses 内置生图：

- Gateway 不可用；
- Tool Pipeline 中某 action 失败；
- Planner 输出不支持的 action；
- 最终图片 metadata 与目标规格不一致；
- 用户的硬约束无法由当前工具目录满足。

系统应明确说明原因，并允许用户修改需求或明确接受近似生成。

## 7. 尺寸与输出规格

### 7.1 两层尺寸模型

“生成候选尺寸”与“最终输出规格”必须分离：

| 概念 | 含义 | 示例 |
| --- | --- | --- |
| 生成候选尺寸 | 传给 Images API 或 Responses 的合法尺寸 | `1536×1024` |
| 最终输出规格 | 最终文件必须满足的尺寸、格式和处理策略 | `870×220 px, PNG, cover, right` |

Images API 的允许尺寸只能作为候选生成参数，不能被错误宣传为任意最终输出尺寸。

### 7.2 严格尺寸工作流

示例需求：`生成一张夏日咖啡横幅，870×220 px，主体靠右`。

1. 路由器识别 `870×220` 为硬约束，选择 `tool_pipeline`。
2. Planner 将横幅构图、主体靠右、为裁剪预留安全区域写入生成提示词。
3. Images API 生成候选图。
4. Gateway 执行 `image.transform`，输出严格 `870×220`。
5. Gateway 读取产物 metadata，断言实际 `width === 870` 且 `height === 220`。
6. 断言成功后才将 action 和任务标记为完成。

Gateway 已经使用 `sharp` 处理图片资产，因此应以它实现服务端确定性变换和 metadata 校验。

### 7.3 变换策略

`image.transform` 支持：

```ts
{
  width: number,
  height: number,
  fit: 'cover' | 'contain' | 'fill',
  position: 'center' | 'left' | 'right' | 'top' | 'bottom',
  background?: string,
  outputFormat: 'png' | 'jpeg' | 'webp',
  outputCompression?: number | null,
}
```

| 策略 | 行为 | 适用条件 |
| --- | --- | --- |
| `cover` | 填满目标尺寸，允许裁切 | 用户允许裁切，或计划已明确裁切策略 |
| `contain` | 完整保留画面，可能留白或透明边 | 用户要求不裁切 |
| `fill` | 强制拉伸到目标尺寸 | 仅用户明确允许变形 |

如果用户只给出宽高而未说明裁切、留白或变形策略，计划卡必须展示默认策略。若该选择显著影响画面，系统先发起澄清而不是静默决定。

### 7.4 OpenShop 边界

现有 OpenShop 的 `canvas.resize` 不应被视为可靠的图片重采样能力：它主要改变画布边界，可能产生裁切或留白，不等同于严格缩放。

因此，V1 的精确尺寸闭环由 Gateway `image.transform` 和 metadata 校验实现。OpenShop 保留给其独有的浏览器侧画布编辑能力；浏览器刷新中断后的操作不自动重放。

## 8. 执行流程

### 8.1 普通生成

1. 用户提交无硬约束请求。
2. 对话流新增用户消息。
3. Agent 显示“正在生成图片”。
4. Responses 路径按现有能力输出流式文本和 partial image。
5. 完成后展示结果、实际尺寸、耗时和图片操作。

普通生成不展示完整计划卡，避免把每次文生图都变成两步操作。

### 8.2 工具链生成或编辑

1. 用户提交含硬约束的请求。
2. Agent 显示“正在分析执行方式”。
3. 系统展示统一计划卡，包含：
   - 目标；
   - 输入图片；
   - 最终 Prompt；
   - 严格尺寸、格式和变换策略；
   - 关键步骤，例如“生成 → 裁剪并输出 870×220”；
   - 假设和风险。
4. 用户确认后，计划卡原地显示排队、生成、处理、校验等状态。
5. 完成结果仍显示在当前对话回合中。

V1 复用 Gateway 的不可变计划、`If-Match` 版本确认和 Composer 快照哈希机制。普通生成不需要额外确认；工具链默认需要确认，以透明呈现将要产生的 API 调用和裁剪策略。

### 8.3 Action 链

当前 Gateway 是“一份 Plan 对应一次 operation”。统一 Agent 的 Tool Pipeline 需要演进为有限的线性 action 链：

```text
image.generate / image.edit
  → image.transform
  → metadata.assert
```

纯几何编辑可直接使用：

```text
image.transform
  → metadata.assert
```

V1 约束：

- 最多 3 个 action；
- 固定顺序执行，不支持运行中新增 action；
- 每个 action 通过 asset / artifact 引用传递输入输出；
- 每个 action 都保存规范化参数、状态、错误、开始结束时间和幂等键；
- Planner 只能从应用固定注册的工具目录中选择 action。

支持的 V1 action：

```ts
image.generate
image.edit
image.transform
openshop.edit
metadata.assert
```

## 9. 会话、历史与图片引用

### 9.1 统一历史

历史列表的最小单位统一为会话，而不是 Chat 会话或 Tool Run。

每个会话显示：

- 首轮或用户定义的标题；
- 最近一轮摘要；
- 最近更新时间；
- 总轮数；
- 当前执行中、待确认、失败或完成状态；
- 最近可展示结果缩略图。

不显示 Chat / Tool 标签；执行详情可显示“图片生成”“严格尺寸处理”“确定性编辑”等业务语义。

### 9.2 新回合与选中规则

- 所有统一 Agent 状态下均可新建会话。
- 用户在当前会话发送消息时，新增同一会话回合。
- 用户新建会话并发送第一条消息时，创建并选中该会话。
- 后台会话完成不得抢占当前正在阅读的会话。
- 删除当前会话后选择相邻会话，延续现有选择体验。

### 9.3 历史图片不隐式上传

统一会话不代表自动向 API 提交历史图片。

当用户说“编辑上一张”“基于刚才的图”时：

- 若该图片已通过附件、`@图片`、结果卡的“继续编辑”或“作为参考图”显式选择，可执行；
- 若未选中，Agent 必须要求用户选择具体图片；
- 不得仅依据文本指代上传历史资产。

这保证成本、隐私和引用范围可预期。

## 10. 数据与兼容

新 Agent 回合统一记录：

```ts
{
  origin: 'agent',
  agentConversationId: string,
  agentTurn: number,
  agentExecutionRoute: 'responses_image' | 'gateway_image_generate' | 'gateway_image_edit' | 'image_transform' | 'openshop',
  agentRouteReason?: string,
  agentRunId?: string,
}
```

保留既有 `origin: 'agent' | 'restricted-agent' | 'openshop'` 及计划、执行、本地 Run 字段，用于旧数据读取、失败恢复和来源追溯。

兼容策略：

- 旧 Chat 记录继续按现有 `agentConversationId` 聚合；缺失 ID 的记录按单独兼容会话处理。
- 旧 Tool Run 映射为只含一回合的兼容会话。
- 不基于 Prompt 相似度或时间接近度自动合并旧会话。
- 不自动重放旧的中断 OpenShop Run。
- 废弃 `agentMode` 偏好；升级后忽略旧值，不再写回。
- 原 `chat`、`tool` 草稿收敛为一个 `agent` 草稿，优先恢复最近修改且非空的内容；旧草稿至少保留一个兼容版本周期。

## 11. 失败、恢复与安全边界

| 场景 | 系统行为 |
| --- | --- |
| 规划期间输入发生变化 | 标记计划 stale，要求重新规划 |
| 用户取消 Gateway 执行 | 停止后续 action，不覆盖原图 |
| `image.transform` 输出尺寸不匹配 | action 失败，任务不得完成 |
| Planner 输出非法或未注册 action | fail closed，不执行、不回退 |
| Gateway 不可用但请求有硬约束 | 明确失败，不走 Responses |
| OpenShop 刷新中断 | 标记中断，不自动重放 |
| OpenShop 已导出但保存失败 | 仅允许重试保存，不重复编辑 |
| 历史图片未显式选择 | 发起澄清，不上传历史资产 |

所有 route 与 action 的真实调用路径应记录到执行审计中。测试必须通过可注入路由器或 API spy 验证真实调用，而不是只断言 UI 文案。

## 12. 页面改造范围

移除：

- 桌面端和移动端的 Chat / Tool 切换 tab；
- `agentMode` 用户偏好；
- 按模式拆分的草稿、活动任务、历史和主工作区；
- Tool 独立 Run 作为用户主入口。

保留并统一：

- 现有 Chat 的多轮对话流、自动滚动和 partial image；
- Tool 的计划卡、确认、取消、执行进度和恢复状态；
- `AgentExecutionDetails` 作为技术透明层；
- 结果图片的预览、下载、复用和继续编辑；
- 历史搜索、移动端抽屉和无障碍焦点管理。

## 13. 验收标准

### 13.1 单一体验

1. 页面上不存在用户可操作的 Chat / Tool 模式切换器。
2. 桌面端和移动端均只有一个 Agent 工作区、一份历史、一个输入框。
3. 同一会话可按顺序显示 Responses 生图、Gateway Images API 生图/图生图、确定性处理等回合。
4. 后台任务完成不抢占用户当前正在阅读的会话。
5. 所有计划卡、状态和恢复按钮均有可访问名称，移动端焦点约束不回归。

### 13.2 路由与尺寸

1. 包含明确 `宽×高` 的合成测试请求，100% 路由为 `tool_pipeline`。
2. 严格尺寸请求的真实调用记录中，不得出现 Responses 内置 `image_generation`。
3. Tool Pipeline 仍可以调用 Images API 完成文生图、图生图。
4. 成功产物的实际 metadata 必须与目标宽高完全一致。
5. metadata 断言失败时，任务不得显示为完成。
6. 纯旋转、翻转、裁剪、缩放请求的 Images API 调用次数为 0。
7. 普通无硬约束文生图继续提供流式和 partial image 体验。
8. 无法满足的硬约束返回澄清或失败，日志证明没有生图回退。

### 13.3 兼容与恢复

1. 旧 Chat、Tool 和 OpenShop 历史均可读取并查看结果。
2. 旧 Tool Run 不被错误合并进现有会话。
3. 原 Gateway 的 `If-Match`、Composer 快照哈希、队列、取消和重启恢复能力不回归。
4. OpenShop 双击确认仍只执行一次；中断的本地 Run 不自动重放。
5. 通过文字提及历史图片时，系统不会自动再次上传该图片。

## 14. 分期

### P0：单一 Agent 与路由冻结

- 移除模式切换，合并会话、历史、草稿和活动任务。
- 新增路由决策及审计字段。
- 在前端和服务端建立硬约束守卫，防止严格尺寸请求进入 Responses 路径。
- 统一计划卡和状态呈现。

### P1：严格尺寸 Tool Pipeline

- 增加 Gateway `image.transform` 和 `metadata.assert`。
- 将 Gateway 从单 operation 演进为最多 3 个 action 的线性链。
- 支持 `image.generate/edit → image.transform → metadata.assert`。
- 支持精确尺寸、格式、`cover / contain / fill` 与实际 metadata 校验。

### P2：OpenShop 跨链编排

- 将 OpenShop 扩展为统一工具目录中的浏览器侧 action。
- 设计浏览器断开、回传签名、输出 hash/尺寸校验和恢复策略。
- 再评估“生成 → OpenShop → 严格导出”的复合工作流。

## 15. 风险与决策记录

| 风险 | 决策 |
| --- | --- |
| 模型可能误判用户是否需要工具 | 规则优先抽取硬约束；硬约束命中即锁路由 |
| Images API 不支持任意尺寸 | 把它作为候选生成器，最终由 `image.transform` 兑现规格 |
| OpenShop resize 并非可靠重采样 | 精确尺寸由 Gateway 和 Sharp 校验，不依赖 OpenShop resize |
| 多 action 增加复杂度 | V1 限制为最多 3 个固定顺序 action，不做 DAG |
| 历史图片自动传输存在隐私/成本风险 | 只接受显式附件、引用或结果卡操作 |
| Tool Pipeline 失败后体验割裂 | 在同一回合内展示原因、返回修改和重新规划，不跳转模式 |

## 16. 需要确认的产品默认值

以下默认值建议在实施前确认：

1. Tool Pipeline 是否始终需要用户确认，还是仅在多 action、费用较高、会裁切或覆盖风险较高时确认。
2. 当用户只要求精确宽高、但未说明裁切或留白策略时，是否默认 `cover + center`，还是一律先追问。
3. 有参考图但没有硬约束的语义编辑，是否优先走 Responses 以保持流式体验，还是优先走 Gateway 以统一审计。

