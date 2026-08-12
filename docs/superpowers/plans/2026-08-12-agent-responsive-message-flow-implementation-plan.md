# Agent 响应式消息流实施计划

日期：2026-08-12

状态：待用户确认后实施

依据：`docs/superpowers/specs/2026-08-12-agent-responsive-message-flow-design.md`

## 1. 交付结论

本次改造只重组 Agent 展示层和布局状态，不改变 Gateway、Planner、OpenShop 协议，不修改 `TaskRecord`、Agent 会话或 Tool Run 的持久化结构。

实施采用小步、测试先行的方式，按以下关键路径推进：

1. 建立布局偏好与现有任务动作的行为基线。
2. 抽出共享结果缩略图、操作行和执行详情。
3. 让 Chat 与 Tool 映射到同一消息流骨架。
4. 重构历史栏、模板抽屉和响应式工作区。
5. 将 Agent 输入区嵌入中央列，保留画廊固定输入区。
6. 完成组件回归、真实浏览器视口验证和构建检查。

每个任务都先补失败测试，再做满足测试的最小实现，并形成独立 Git 提交。实施阶段不推送、不部署；全部本地验证通过后，再单独询问是否部署到 Docker/Dokploy 测试环境。

## 2. 约束和保护边界

- 保持 Chat 与 Tool 两套执行状态源不变：Chat 继续使用现有流式 Session，Tool 继续使用 `restrictedAgentStore`。
- 保持 Chat/Tool 工作区同时挂载，模式切换不能中止进行中的流或 Tool 执行。
- 不新增持久化消息模型；消息由现有 `TaskRecord`、会话任务、流式 Session、Plan、Execution 和 Local Run 派生。
- 不修改 Gateway、Planner、OpenShop iframe、IndexedDB schema 或运行时配置协议。
- 不新增“查看原图”按钮；缩略图点击和键盘激活继续调用现有 Lightbox。
- 不把常用动作收进二级菜单；复用配置、编辑输出、高级编辑、遮罩编辑、收藏、适用时重试、删除保持一排可换行按钮。
- 不改变画廊、详情弹窗、Lightbox、Mask Editor 和 OpenShop 的既有业务流程。
- 不删除现有组件文件。即使组件职责缩小，也先保留兼容包装，避免在本次任务中引入文件删除和大范围重命名。
- 不纳入或修改用户当前未跟踪对象：`docs/openshop-agent-tool-evaluation.md`、`image-sample-library/`。

## 3. 计划中的目标文件

预计新增：

- `src/lib/agentLayoutPreferences.ts`
- `src/lib/agentLayoutPreferences.test.ts`
- `src/components/TaskActionRow.tsx`
- `src/components/TaskActionRow.test.tsx`
- `src/components/AgentExecutionDetails.tsx`
- `src/components/AgentExecutionDetails.test.tsx`
- `src/components/AgentResultReply.tsx`
- `src/components/AgentResultReply.test.tsx`
- `src/components/AgentConversationStream.tsx`
- `src/components/AgentConversationStream.test.tsx`

预计修改：

- `package.json`
- `package-lock.json`
- `src/components/icons.tsx`
- `src/components/TaskDetailContent.tsx`
- `src/components/TaskCard.tsx`
- `src/components/TaskCard.test.tsx`
- `src/components/AgentImagePreview.tsx`
- `src/components/LegacyAgentMainWorkspace.tsx`
- `src/components/LegacyAgentMainWorkspace.test.tsx`
- `src/components/AgentMainWorkspace.tsx`
- `src/components/AgentMainWorkspace.test.tsx`
- `src/components/AgentWorkspace.tsx`
- `src/components/AgentWorkspace.test.tsx`
- `src/components/AgentHistoryPanel.tsx`
- `src/components/AgentHistoryPanel.test.tsx`
- `src/components/AgentTemplateRail.tsx`
- `src/components/AgentTemplateRail.test.tsx`
- `src/components/InputBar.tsx`
- `src/components/InputBar.test.ts`
- `src/App.tsx`
- `src/App.test.tsx`
- `e2e/agent-openshop-smoke.spec.ts`

如果实施时能在现有文件内保持清晰边界，则不强制创建全部建议文件；但不能把 Chat 与 Tool 再次堆回两个大型、互不一致的展示组件。

## 4. 分步实施

### Task 1：引入 Lucide 并建立布局偏好存储

目标：满足新 UI 图标规范，并把桌面历史栏、模板栏偏好与业务状态隔离。

文件：

- 修改 `package.json`
- 修改 `package-lock.json`
- 修改 `src/components/icons.tsx`
- 新增 `src/lib/agentLayoutPreferences.ts`
- 新增 `src/lib/agentLayoutPreferences.test.ts`

步骤：

1. 实施前单独说明安装 `lucide-react` 会修改依赖清单和 lockfile，并取得用户授权后执行安装。
2. 先为布局偏好写失败测试，覆盖：
   - 首次读取时历史展开、模板收起。
   - 合法值可保存并恢复。
   - `localStorage` 缺失、getter 抛错、非法 JSON 或字段不合法时回退默认值。
   - 只保存桌面偏好，不保存移动端打开抽屉。
3. 实现 `AGENT_LAYOUT_PREFERENCE_KEY`、默认值、读写函数，采用 `serverApiConfig.ts` 已有的安全 Storage 访问模式。
4. 在 `icons.tsx` 中统一转出本次新 UI 所需的 Lucide 图标；业务组件只从项目图标入口导入，避免散落依赖路径。

验证：

```powershell
npx vitest run src/lib/agentLayoutPreferences.test.ts
```

提交节点：

```text
feat: 建立 Agent 布局偏好基础
```

### Task 2：锁定并抽取任务操作行

目标：让任务详情、历史卡片和 Agent 结果使用同一套动作可见性规则与业务回调，避免重构后出现按钮缺失或行为分叉。

文件：

- 新增 `src/components/TaskActionRow.tsx`
- 新增 `src/components/TaskActionRow.test.tsx`
- 修改 `src/components/TaskDetailContent.tsx`
- 修改 `src/components/TaskCard.tsx`
- 修改 `src/components/TaskCard.test.tsx`
- 修改 `src/components/AgentHistoryPanel.tsx`
- 修改 `src/components/AgentHistoryPanel.test.tsx`

步骤：

1. 先写共享操作行失败测试，锁定以下行为：
   - 输出存在时可编辑输出、高级编辑和遮罩编辑；无输出时禁用。
   - 收藏文案和状态随 `isFavorite` 切换。
   - `restricted-agent` 与 `openshop` 不显示普通 API 重试，其余适用任务保留重试。
   - 删除仍调用现有确认弹窗，删除动作只在确认后执行。
   - 复用和编辑后仍将焦点返回输入编辑器。
   - `presentation="modal"` 时继续关闭详情弹窗，Agent 消息流中不触发额外关闭。
2. 提取共享动作状态和回调，继续调用现有 `reuseConfig`、`editOutputs`、`retryTask`、`removeTask`、`updateTaskInStore`、`setMaskEditorImageId` 和 OpenShop hash。
3. 用 `TaskActionRow` 替换 `TaskDetailContent` 底部手写按钮；`TaskCard` 与 `AgentHistoryPanel` 复用同一可见性判定，保持紧凑卡片视觉不变。
4. 操作行使用 Lucide 图标和可读文字，保留 `title`/`aria-label`，允许在窄屏自然换行，不做横向滚动或更多菜单。

验证：

```powershell
npx vitest run src/components/TaskActionRow.test.tsx src/components/TaskCard.test.tsx src/components/AgentHistoryPanel.test.tsx src/components/DetailModal.test.tsx
```

提交节点：

```text
refactor: 统一任务操作行行为
```

### Task 3：实现 160px 共享结果缩略图和 Lightbox 入口

目标：所有 Agent 最终输出统一显示为最大 `160×160px` 的缩略图，点击或键盘激活直接打开现有 Lightbox。

文件：

- 修改 `src/components/AgentImagePreview.tsx`
- 新增 `src/components/AgentResultReply.tsx`
- 新增 `src/components/AgentResultReply.test.tsx`

步骤：

1. 先写失败测试，覆盖：
   - 单图包含明确的 `max-h-40 max-w-40` 或等价 160px 约束。
   - 图片始终 `object-contain`，不使用裁切式 `object-cover`。
   - 多图按传入顺序输出，容器可换行。
   - 用导出的纯函数或可捕获 props 锁定 Lightbox 调用参数为 `setLightboxImageId(currentId, fullList)`；真实点击、`Enter` 和 `Space` 在 Task 9 的 Playwright 中验证。
   - 优先使用现有缩略图缓存，fallback 只用于流式中间预览。
   - 组件不渲染“查看原图”按钮。
2. 增强 `AgentImagePreview` 的交互语义、加载占位和错误占位；最终输出使用按钮语义，纯流式预览可保持非交互展示。
3. 新增 `AgentResultReply`，统一承载状态文字、Agent 文本、最终缩略图组、错误摘要、恢复动作和 `TaskActionRow`。
4. 保证完成图替换 partial preview 时盒子尺寸不扩大，避免布局跳变。

验证：

```powershell
npx vitest run src/components/AgentResultReply.test.tsx src/components/LegacyAgentMainWorkspace.test.tsx
```

提交节点：

```text
feat: 统一 Agent 结果缩略图与操作
```

### Task 4：抽取默认折叠的执行详情

目标：Prompt、参考图、参数、计划、Run 和原始响应进入同一默认折叠区；最终输出和操作行不在详情中重复。

文件：

- 新增 `src/components/AgentExecutionDetails.tsx`
- 新增 `src/components/AgentExecutionDetails.test.tsx`
- 修改 `src/components/TaskDetailContent.tsx`
- 修改 `src/components/LegacyAgentMainWorkspace.tsx`
- 修改 `src/components/AgentMainWorkspace.tsx`

步骤：

1. 先写失败测试，覆盖：
   - “执行详情”默认关闭并保留键盘可操作的 disclosure 语义。
   - 展开内容包含用户 Prompt、修订 Prompt、参考图、参数和来源信息。
   - Chat 可显示 Tool 消息和流式中间预览。
   - Tool 可显示 Plan 摘要、策略版本、计划 ID、执行 ID或本地 Run ID。
   - 原始链接和原始响应仍可复制。
   - 详情中不重复最终输出缩略图和任务操作行。
2. 从 `TaskDetailContent` 提取可复用的详情片段，完整详情弹窗继续保留原有大图舞台和完整信息。
3. `AgentExecutionDetails` 只组合详情片段与 Agent 特有元数据，不承担执行动作或最终结果展示。
4. 移除 Chat 详情中当前“其余生成图片”的重复展示；所有最终图片统一上移到 `AgentResultReply` 缩略图组。

验证：

```powershell
npx vitest run src/components/AgentExecutionDetails.test.tsx src/components/LegacyAgentMainWorkspace.test.tsx src/components/AgentMainWorkspace.test.tsx src/components/DetailModal.test.tsx
```

提交节点：

```text
refactor: 抽取 Agent 执行详情
```

### Task 5：建立共享消息流并迁移 Chat

目标：Chat 不再只展示“最后回复卡 + 完整对话折叠”，而是把所有轮次按时间顺序直接渲染为用户消息和 Agent 回复。

文件：

- 新增 `src/components/AgentConversationStream.tsx`
- 新增 `src/components/AgentConversationStream.test.tsx`
- 修改 `src/components/LegacyAgentMainWorkspace.tsx`
- 修改 `src/components/LegacyAgentMainWorkspace.test.tsx`
- 修改 `src/lib/agentConversation.test.ts`

步骤：

1. 先写失败测试，覆盖：
   - 会话任务按 `agentTurn`、`createdAt` 和稳定 ID 顺序生成全部轮次。
   - 每一轮依次渲染用户请求和 Agent 回复。
   - 当前运行轮合并内存流式 Session；历史轮只从已持久化任务派生。
   - 失败任务同时展示已保存 partial、Agent 文本、终止错误和恢复/取消动作。
   - 旧记录缺少 `agentConversationId` 或 `agentTurn` 时仍可恢复。
   - 用纯函数测试“是否接近底部”和会话切换后的初始定位判定；真实滚动位置在 Task 9 的 Playwright 中验证。
2. 实现 `AgentConversationStream`：
   - 中央内容最大宽度 `760px`。
   - 新增消息仅在用户距离底部阈值内时自动跟随。
   - 用户向上阅读时停止强制滚动，并显示“回到底部”按钮。
   - 选择历史会话后定位到最新消息。
3. 将 `LegacyAgentMainWorkspace` 缩小为 Chat 数据适配层，继续持有现有流式订阅和 Session 合并逻辑，把渲染交给共享消息组件。
4. 保持 Chat Workspace 在模式切换时挂载，避免流式状态和订阅丢失。

验证：

```powershell
npx vitest run src/lib/agentConversation.test.ts src/components/AgentConversationStream.test.tsx src/components/LegacyAgentMainWorkspace.test.tsx
```

提交节点：

```text
feat: 将 Chat Agent 迁移到共享消息流
```

### Task 6：将 Tool 生命周期映射到共享消息流

目标：Tool 的规划、确认、执行、保存、完成和失败在同一条 Agent 回复位置更新，不再在完成后切换为完整 `TaskDetailContent`。

文件：

- 修改 `src/components/AgentMainWorkspace.tsx`
- 修改 `src/components/AgentMainWorkspace.test.tsx`
- 修改 `src/components/AgentPlanCard.tsx`
- 修改 `src/components/AgentPlanCard.test.tsx`

步骤：

1. 先补失败测试，覆盖：
   - `planning` 显示 Planner 状态但不伪装成已执行。
   - `awaiting_confirmation`、`confirming`、`expired`、`stale` 继续展示审查信息和正确按钮状态。
   - Gateway `queued/executing/completed/failed/cancelled/failed_unknown` 映射到同一回复。
   - OpenShop `running/exported/saving/completed/cancelled/failed/interrupted/expired` 映射到同一回复。
   - 错误摘要、取消、仅重试保存、返回修改等动作直接可见。
   - 完成后渲染 `AgentResultReply`，不再渲染 Agent 场景的完整大图 `TaskDetailContent`。
2. 保留 `AgentPlanCard` 的冻结计划、输入绑定和显式确认逻辑，只收敛外围视觉，使其成为消息流中的审查块。
3. 将 Restricted Agent 当前状态映射为共享回复 props；状态变化只更新原位置，不追加重复结果卡。
4. 保持 Chat 和 Tool 两个主工作区同时挂载，只切换可见性。

验证：

```powershell
npx vitest run src/components/AgentPlanCard.test.tsx src/components/AgentMainWorkspace.test.tsx src/restrictedAgentStore.test.ts
```

提交节点：

```text
feat: 将 Tool Agent 迁移到共享消息流
```

### Task 7：重构响应式双侧栏与抽屉

目标：桌面历史默认展开、模板默认收起；低于 1280px 后两者都改为覆盖式抽屉，且模板展开不压缩中央消息流。

文件：

- 修改 `src/components/AgentWorkspace.tsx`
- 修改 `src/components/AgentWorkspace.test.tsx`
- 修改 `src/components/AgentHistoryPanel.tsx`
- 修改 `src/components/AgentTemplateRail.tsx`
- 修改 `src/components/AgentTemplateRail.test.tsx`
- 修改 `src/components/icons.tsx`

步骤：

1. 先写布局失败测试，锁定：
   - 桌面断点为 `1280px`。
   - 历史首次为 `240px`，收起后为 `48px`。
   - 模板首次为 `48px` 入口，展开为覆盖式 `320px`，中央列宽不变。
   - 低于 1280px 时不渲染当前三段式 Tab，改为历史/模板抽屉触发按钮。
   - 通过状态转换纯函数或捕获子组件回调，锁定移动端模式切换、选择历史和模板应用后的抽屉关闭规则。
   - 触发器含 `aria-expanded`、`aria-controls` 和明确名称。
2. 将 `AgentWorkspace` 重构为全高 Shell：左侧历史、中央消息/输入区、右侧模板入口。
3. 桌面历史宽度从布局偏好恢复；模板用绝对或 fixed 覆盖层展开，不参与中央 grid 轨道计算。
4. 中小屏抽屉复用 `useCloseOnEscape`、`usePreventBackgroundScroll`，补充焦点进入、Tab 约束和关闭后焦点归还；抽屉打开状态不持久化。组件测试检查静态 ARIA/状态映射，真实 Escape、Tab 和焦点归还在 Task 9 的 Playwright 中验证。
5. 历史、消息流和模板各自滚动；所有动画遵循 `prefers-reduced-motion`。

验证：

```powershell
npx vitest run src/components/AgentWorkspace.test.tsx src/components/AgentHistoryPanel.test.tsx src/components/AgentTemplateRail.test.tsx src/lib/agentLayoutPreferences.test.ts
```

提交节点：

```text
feat: 重构 Agent 响应式双侧栏
```

### Task 8：将 Agent 输入区嵌入中央列

目标：Agent 输入区成为消息列底部的正常布局节点，不再通过整页 fixed 定位和侧栏宽度猜测偏移；画廊输入区保持现状。

文件：

- 修改 `src/components/InputBar.tsx`
- 修改 `src/components/InputBar.test.ts`
- 修改 `src/components/AgentWorkspace.tsx`
- 修改 `src/components/AgentWorkspace.test.tsx`
- 修改 `src/App.tsx`
- 修改 `src/App.test.tsx`

步骤：

1. 先补失败测试，覆盖：
   - `layout="default"` 仍走 Gallery 提交路由并使用 fixed presentation。
   - `layout="agent"` 仍按当前 Chat/Tool 模式提交，但使用 embedded presentation。
   - 将最外层 presentation class 提取为纯函数，锁定 Agent composer 不包含当前 `fixed bottom-*` 和 `xl:left-[calc(...)]` 偏移类。
   - Gallery composer 继续保留原固定定位。
   - Chat/Tool 草稿隔离、当前会话 ID 和提交后选中任务逻辑不变。
2. 为 `InputBar` 增加与提交路由解耦的 presentation 参数；只改变最外层定位、宽度和阴影容器，不改 2000 行组件中的提交、附件、Mask、参数和快捷键逻辑。
3. `AgentWorkspace` 在中央列中渲染 embedded composer，并为消息滚动区保留独立 flex 空间；最后一条消息自然位于输入区上方，不再依赖 `pb-36/pb-48` 补偿。
4. `App` 只在画廊渲染全局 fixed composer；Agent composer 的 props 继续使用当前 mode、capabilities、conversation ID 和 task submitted 回调。
5. 切换 Gallery/Agent 后复查草稿 Store 能恢复对应 scope；不修改 `ComposerDraftSnapshot` 或持久化格式。

验证：

```powershell
npx vitest run src/components/InputBar.test.ts src/components/AgentWorkspace.test.tsx src/App.test.tsx src/store.test.ts
```

提交节点：

```text
feat: 将 Agent 输入区嵌入消息列
```

### Task 9：完整回归和真实浏览器验收

目标：验证视觉、交互、流式状态和既有图片工作流，没有被组件测试遗漏。

文件：

- 修改 `e2e/agent-openshop-smoke.spec.ts`
- 如只需调整断言，修改对应组件测试；不创建临时调试脚本或提交截图。

步骤：

1. 在现有 Agent E2E fixture 上增加聚焦场景：
   - Chat 多轮按顺序显示，流式回复在原位置增长。
   - Tool 从规划到完成始终使用同一消息流结构。
   - 结果图尺寸不超过 160px，点击打开 Lightbox，编辑输出同样复用现有入口。
   - 历史桌面默认展开并可收起；模板默认收起并覆盖展开。
   - 1024px 和 390px 使用覆盖抽屉，`Escape` 可关闭且焦点归还。
   - 输入区不遮挡最后一条消息和操作行。
   - 用户上滚后流式更新不强制拉回，点击“回到底部”恢复跟随。
2. 用 Chromium 逐个验证下列视口：
   - `1920×1080`
   - `1366×768`
   - `1024×768`
   - `390×844`
3. 每个视口抽查：长 Prompt、长 Agent 文本、多图、横图、竖图、失败、保存重试、历史恢复、深色模式和 `prefers-reduced-motion`。
4. 运行最小相关测试、全量前端测试、Gateway 回归和 runtime 构建。
5. 检查实际页面、构建产物和 Git 状态；删除 Playwright 产生的 trace、截图、test-results 等中间产物，只保留源码和测试改动。

验证命令：

```powershell
npx playwright test e2e/agent-openshop-smoke.spec.ts --project=chromium
npm run test
npm run test:gateway
$env:DEPLOY_TARGET='runtime'; npm run build:all
git status --short
```

提交节点：

```text
test: 覆盖 Agent 响应式消息流回归
```

## 5. 验收检查表

- [ ] Chat 与 Tool 共用同一消息列、用户消息、Agent 回复、结果和详情视觉。
- [ ] 中央消息内容最大宽度为 `760px`，水平内边距为 `clamp(16px, 5vw, 72px)` 或等价实现。
- [ ] 桌面历史默认 `240px`，可收起为 `48px`，偏好安全持久化。
- [ ] 桌面模板默认 `48px`，展开覆盖为 `320px`，不压缩中央列。
- [ ] 低于 `1280px` 后历史和模板均为默认关闭的覆盖式抽屉。
- [ ] 最终输出不超过 `160×160px`，不裁切，多图可换行。
- [ ] 点击或键盘激活缩略图打开现有 Lightbox，并传入完整图片列表。
- [ ] 不存在新增“查看原图”按钮。
- [ ] 常用操作始终直接展示，行为、禁用条件和确认逻辑与当前一致。
- [ ] 最终输出只在缩略图组展示一次，不在执行详情重复。
- [ ] Prompt、参数、Plan、Run 和原始响应默认折叠。
- [ ] 错误摘要和取消、重试保存、返回修改等恢复动作直接可见。
- [ ] Agent 输入区不遮挡消息；画廊固定输入区不回归。
- [ ] 切换 Chat/Tool 不卸载进行中的 Chat 流或 Tool 状态。
- [ ] 旧 Agent 历史无需迁移即可恢复。
- [ ] Lightbox、详情弹窗、编辑输出、OpenShop、Mask Editor、收藏、重试和删除通过回归验证。
- [ ] 所有新 UI 图标使用 Lucide，不使用表情符号。
- [ ] 相关组件测试、E2E、Gateway 测试和 runtime 构建通过。

## 6. 风险、控制与回滚

### 6.1 任务动作回归

风险：抽取共享动作后，Modal、历史和 Agent 场景的关闭、焦点、禁用条件可能串场。

控制：先锁定现有 `TaskCard`、`DetailModal` 和动作回调行为；共享层保留显式 presentation/context 参数，不通过 DOM 位置猜测场景。

回滚：单独回退 `refactor: 统一任务操作行行为`，后续消息流仍可临时使用兼容包装。

### 6.2 Chat 流式状态丢失

风险：消息组件重构导致流订阅卸载或历史任务覆盖内存 partial。

控制：`LegacyAgentMainWorkspace` 继续持有订阅和 Session；共享消息流只接收派生 props。Chat/Tool 仍同时挂载。

回滚：回退 Chat 迁移提交即可恢复旧 Chat 展示，不影响已保存任务。

### 6.3 Tool 状态映射遗漏

风险：Gateway Execution 与 OpenShop Local Run 的状态集合不同，可能遗漏恢复动作。

控制：测试逐项枚举现有 union 状态；不在 UI 中发明新状态，不改变 Store transition。

回滚：回退 Tool 迁移提交，恢复当前 `TaskDetailContent` 展示。

### 6.4 InputBar 挂载位置变化

风险：组件从全局固定区移入 Agent Shell 后，内部上传菜单、拖拽遮罩、快捷键或草稿切换出现回归。

控制：仅改变最外层 presentation 和挂载位置；提交逻辑、Store scope、Portal、弹层 z-index 与事件处理保持原实现，并通过双能力 E2E 验证草稿隔离。

回滚：回退输入区提交即可恢复全局 fixed 定位，无数据迁移。

### 6.5 响应式抽屉与 Modal 叠层

风险：抽屉、Lightbox、ConfirmDialog 和 Mask Editor 同时出现时，Escape 顺序、滚动锁和 z-index 冲突。

控制：复用已有 Escape 栈和滚动锁；抽屉层级低于业务 Modal，并在 E2E 验证焦点归还与关闭顺序。

回滚：回退侧栏提交，消息流仍可在原容器中工作。

## 7. 最终提交与部署边界

建议最终提交序列：

```text
feat: 建立 Agent 布局偏好基础
refactor: 统一任务操作行行为
feat: 统一 Agent 结果缩略图与操作
refactor: 抽取 Agent 执行详情
feat: 将 Chat Agent 迁移到共享消息流
feat: 将 Tool Agent 迁移到共享消息流
feat: 重构 Agent 响应式双侧栏
feat: 将 Agent 输入区嵌入消息列
test: 覆盖 Agent 响应式消息流回归
```

本地实施完成后先向用户报告：实际修改、测试结果、目标视口预览和剩余风险。仓库存在 Docker/Dokploy 部署痕迹，因此随后单独询问是否部署测试；未取得明确授权前不执行 Docker 构建、Dokploy 发布、Git push 或任何外部系统修改。
