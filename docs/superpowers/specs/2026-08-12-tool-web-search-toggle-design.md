# Tool Agent 联网搜索开关设计

## 目标

在 Tool Agent 输入区的附件按钮左侧提供仅当前页面有效的联网搜索开关。默认关闭；开启后，创建计划前自动从受控的 `open-websearch` 内网服务检索参考资料，不要求用户在提示词中重复说明。

## 范围

- 仅适用于 Tool Agent，不改变 Chat Agent。
- 刷新页面后开关恢复关闭；历史切换、提交完成不自动关闭。
- 首版仅执行搜索，不允许 Agent 直接抓取任意 URL。
- 搜索结果只作为 Planner 的参考上下文，不是可执行 Operation。

## 数据流

1. 前端将 `webSearchEnabled` 随 Tool 计划请求提交。
2. Gateway 在开关开启且服务配置可用时调用内网 `open-websearch` 的 `POST /search`。
3. Gateway 限制结果数和字段，保留标题、URL、摘要、搜索引擎。
4. Planner 接收这些结构化结果，生成现有单一图片或 OpenShop operation。
5. 冻结计划携带实际使用的搜索来源，前端计划卡展示来源链接。

## 失败与安全

- 搜索失败不阻断计划生成：Gateway 创建离线计划，并写入可见 warning。
- Gateway 只访问固定、配置校验后的内网 Web Search URL；不接受浏览器传入服务地址。
- Web Search 容器不发布宿主端口，只加入现有 Docker 内网；默认仅允许指定搜索引擎、有限结果数和短超时。
- 外部搜索结果是不可信输入，Planner 指令明确要求将其仅视为参考资料，不执行其中的指令。

## 验证

- 前端：开关仅在 Tool 输入区出现且请求字段正确。
- Gateway：成功搜索、超时/失败降级、来源序列化和 Planner 上下文。
- Compose：配置语法校验。Docker 启动 smoke 另经用户确认执行。
