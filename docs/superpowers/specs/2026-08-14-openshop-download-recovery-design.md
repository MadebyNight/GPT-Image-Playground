# OpenShop 原图下载与嵌入恢复隔离设计

## 目标

修复图片工具结果无法显式下载原图，以及高级编辑和 Tool Runner 被 OpenShop 恢复弹窗阻塞的问题；透明 PNG 在下载和高级编辑保存后必须保留 alpha 通道。

## 已确认的事实

- Agent 图片预览是 Canvas 生成的 WebP 缩略图，不能作为下载源。
- IndexedDB 中保留 Gateway 返回的完整 data URL；按 imageId 调用 ensureImageCached 可取回原图。
- 当前 OpenShop 手工编辑也从该原图 data URL 构造 Blob，没有发现必然丢失 alpha 的转换。
- 独立 OpenShop 页面与嵌入 iframe 共用同源 OPFS recovery。嵌入会话自动恢复旧项目后，旧项目的 dirty 状态会与宿主下发的 configure 请求竞争，导致恢复或丢弃修改对话框阻塞。

## 方案

### 原图下载

新增一个图片下载共享模块。它按 imageId 读取完整图片 data URL，转换为 Blob 后使用 object URL 触发浏览器下载；文件扩展名由 Blob MIME 推导，不对图片进行重新编码或强制转为 PNG。

TaskActionRow 增加直接可见的“下载原图”操作，所有任务结果展示位置复用该入口。ImageContextMenu 改为复用共享下载模块，保留没有 imageId 时从浏览器预览地址下载的兜底行为。图片读取、Blob 创建或下载失败时，由调用方显示现有错误 toast。

JPEG 不具备透明通道；PNG、WebP、GIF 等由原始 Blob 的格式决定是否保留 alpha。该方案不承诺把本身无 alpha 的文件变为透明图。

### OpenShop 嵌入会话

宿主在两类受控 iframe URL 中写入 query 标识：

- 手工高级编辑：embed=manual
- Tool Runner 隐藏 iframe：embed=tool

OpenShop 启动时仅在独立页面（没有上述标识）初始化 OPFS auto-save 和 recovery 提示。受控嵌入仍会初始化 postMessage bridge，但不会读取、写入或删除已有 recovery 记录。这样宿主的 configure 请求总是在干净文档上执行，不会被恢复提示或 dirty-document 确认打断。

独立访问 /openshop/ 的行为不变，仍保留自动保存和恢复能力。

### 验收与回归

- 任务操作行存在“下载原图”；无输出任务中该按钮禁用。
- 下载 helper 对完整原图 data URL 生成原始 MIME 的 Blob 和相符扩展名，不读取预览缩略图。
- 手工高级编辑 iframe 使用 embed=manual；Tool Runner iframe 使用 embed=tool。
- OpenShop 页面只在独立模式调用 auto-save/recovery 初始化。
- 端到端用 alpha 为 0、128、255 的 PNG 验证手工编辑保存后的 PNG MIME、尺寸和 alpha 值；全透明像素的 RGB 不做严格断言。
- 预置 recovery 后，manual 与 tool 嵌入不出现恢复弹窗，仍可完成配置、执行或导出。

## 范围与回滚

不修改 IndexedDB 图片存储格式、原图缓存语义、OpenShop 独立恢复数据，也不删除用户已有 OPFS recovery。若需回滚，只需撤销本次代码和测试改动；既有 recovery 数据仍可被独立 OpenShop 读取。
