# OpenShop 原图下载与嵌入恢复隔离 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让图片工具结果可下载原始文件，并使受控 OpenShop iframe 不受 OPFS recovery 弹窗阻塞。

**Architecture:** 将原图下载收敛到独立模块，唯一正确的数据路径是 imageId 到 IndexedDB 原始 data URL 到 Blob 到浏览器下载。通过 iframe query 标识区分独立、manual 和 tool 会话，OpenShop 仅在独立会话启用 auto-save/recovery。

**Tech Stack:** React、TypeScript、Zustand、Vitest、Playwright、原生浏览器 Blob/OPFS API。

---

### Task 1: 共享原图下载模块

**Files:**
- Create: src/lib/imageDownload.ts
- Test: src/lib/imageDownload.test.ts

- [ ] **Step 1: 写失败测试**

~~~ts
const source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ...'
await downloadImageSource(source, { document, now: () => 1 })
expect(fetch).toHaveBeenCalledWith(source)
expect(anchor.download).toBe('image-1.png')
~~~

同时覆盖 JPEG 和 SVG 的扩展名，以及 imageId 无缓存时抛出“原图不可用”。

- [ ] **Step 2: 运行失败测试**

Run: npm test -- src/lib/imageDownload.test.ts
Expected: FAIL，模块或导出函数尚不存在。

- [ ] **Step 3: 实现最小下载 API**

~~~ts
export async function downloadOriginalImage(imageId: string) {
  const source = await ensureImageCached(imageId)
  if (!source) throw new Error('原图不可用')
  return downloadImageSource(source)
}
~~~

downloadImageSource 必须 fetch source、读取 Blob、根据 Blob MIME 选择 png、jpg、webp、gif、avif 或 svg 扩展名，创建 object URL、点击临时 a 元素并释放 object URL。不得从 Canvas 或预览 URL 重编码图片。

- [ ] **Step 4: 运行模块测试**

Run: npm test -- src/lib/imageDownload.test.ts
Expected: PASS。

### Task 2: 在任务结果与右键菜单接入原图下载

**Files:**
- Modify: src/components/TaskActionRow.tsx
- Modify: src/components/TaskActionRow.test.tsx
- Modify: src/components/ImageContextMenu.tsx
- Test: src/components/TaskActionRow.test.tsx

- [ ] **Step 1: 写 TaskActionRow 失败断言**

~~~ts
expect(renderToStaticMarkup(<TaskActionRow task={task} presentation="agent" />)).toContain('下载原图')
expect(markup).toMatch(/title="下载原图"[^>]*disabled=""/)
~~~

第二个断言使用 outputImages 为空的任务，确保无输出时按钮不可触发。

- [ ] **Step 2: 运行组件测试**

Run: npm test -- src/components/TaskActionRow.test.tsx
Expected: FAIL，页面尚未渲染下载按钮。

- [ ] **Step 3: 增加下载动作并复用 helper**

在 TaskActionRow 导入 DownloadIcon 和 downloadOriginalImage，在编辑输出前渲染“下载原图”按钮。点击时对 outputImageId 调用 helper；成功显示“开始下载”，失败显示“原图下载失败”。按钮的 disabled 条件与其他输出操作一致。

在 ImageContextMenu 的下载分支中调用共享 source 下载函数；有 imageId 时先通过现有 getOriginalImageSrc 读取 IndexedDB 原图，无 imageId 时保留预览 src 兜底。移除重复的 Blob/object URL/a 元素实现。

- [ ] **Step 4: 运行下载相关单测**

Run: npm test -- src/lib/imageDownload.test.ts src/components/TaskActionRow.test.tsx
Expected: PASS。

### Task 3: 为受控 iframe 写入明确会话标识

**Files:**
- Modify: src/lib/openshopBridge.ts
- Modify: src/lib/openshopBridge.test.ts
- Modify: src/components/OpenShopWorkspace.tsx
- Modify: src/components/OpenShopWorkspace.test.tsx
- Modify: src/lib/openShopToolRunner.ts
- Modify: src/lib/openShopToolRunner.test.ts

- [ ] **Step 1: 写 URL 构造失败测试**

~~~ts
expect(getOpenShopFrameUrl('https://example.test/app/#gallery', 'tool'))
  .toBe('https://example.test/app/openshop/index.html?embed=tool')
~~~

同时为手工工作区断言 iframe src 含 embed=manual，并为 Tool Runner DOM 断言隐藏 iframe URL 含 embed=tool。

- [ ] **Step 2: 运行相关单测**

Run: npm test -- src/lib/openshopBridge.test.ts src/components/OpenShopWorkspace.test.tsx src/lib/openShopToolRunner.test.ts
Expected: FAIL，当前 URL 没有 embed query。

- [ ] **Step 3: 最小化实现会话标识**

在 bridge 的 frame URL helper 中接受受限的 manual 或 tool 会话参数并通过 URLSearchParams 写入 embed。OpenShopWorkspace 使用 manual URL，Tool Runner 在生产默认 URL 和显式 frameUrl 上都保留既有 query 并写入 embed=tool。保持 targetOrigin 校验不变。

- [ ] **Step 4: 重跑 iframe URL 单测**

Run: npm test -- src/lib/openshopBridge.test.ts src/components/OpenShopWorkspace.test.tsx src/lib/openShopToolRunner.test.ts
Expected: PASS。

### Task 4: OpenShop 仅为独立页面启用 OPFS recovery

**Files:**
- Modify: public/openshop/index.html
- Test: e2e/agent-openshop-smoke.spec.ts

- [ ] **Step 1: 写 recovery 端到端失败用例**

在真实 OpenShop 测试前向同源 OPFS 写入有效 recovery，然后打开带 embed=manual 的高级编辑器。断言 recovery 对话框不显示，宿主收到 configured，且“保存到历史”可用。对 Tool Runner 使用同一 recovery 条件并断言 local Run 完成。

- [ ] **Step 2: 执行该用例**

Run: npx playwright test e2e/agent-openshop-smoke.spec.ts --grep recovery
Expected: FAIL，当前 iframe 会显示 recovery 提示或在配置阶段超时。

- [ ] **Step 3: 条件化 auto-save 初始化**

在 OpenShop 启动代码读取 new URLSearchParams(window.location.search).get('embed')。值为 manual 或 tool 时跳过 _initAutoSave；其他值或缺失时继续调用。始终保留 _initEmbedBridge，不删除或清理任何 OPFS recovery 数据。

- [ ] **Step 4: 重跑 recovery 回归**

Run: npx playwright test e2e/agent-openshop-smoke.spec.ts --grep recovery
Expected: PASS，manual 和 tool iframe 不再被弹窗阻塞。

### Task 5: 透明 PNG 的端到端保真验证

**Files:**
- Modify: e2e/agent-openshop-smoke.spec.ts

- [ ] **Step 1: 写 alpha 保真用例**

使用 2×2 PNG，其中 alpha 分别为 0、128、255、255。通过真实高级编辑保存后，从 IndexedDB 读取输出 data URL，解码为 RGBA，并断言 MIME 为 image/png、尺寸 2×2、alpha 序列为 [0, 128, 255, 255]。

- [ ] **Step 2: 运行 alpha 用例**

Run: npx playwright test e2e/agent-openshop-smoke.spec.ts --grep 透明 PNG
Expected: PASS；若失败，测试先暴露实际丢失发生的阶段。

- [ ] **Step 3: 按测试结果做最小修正**

若失败发生在下载或嵌入桥接，修正对应的 Blob/MIME 传递；不得把全透明像素的 RGB 当作严格断言，因为 Canvas 预乘 alpha 可改变该值。

- [ ] **Step 4: 重跑完整 OpenShop smoke**

Run: npx playwright test e2e/agent-openshop-smoke.spec.ts
Expected: PASS。

### Task 6: 最终验证与交付检查

**Files:**
- Verify: src/lib/imageDownload.ts
- Verify: src/components/TaskActionRow.tsx
- Verify: src/components/ImageContextMenu.tsx
- Verify: src/components/OpenShopWorkspace.tsx
- Verify: src/lib/openshopBridge.ts
- Verify: src/lib/openShopToolRunner.ts
- Verify: public/openshop/index.html
- Verify: e2e/agent-openshop-smoke.spec.ts

- [ ] **Step 1: 运行全部相关 Vitest**

Run: npm test -- src/lib/imageDownload.test.ts src/components/TaskActionRow.test.tsx src/components/OpenShopWorkspace.test.tsx src/lib/openshopBridge.test.ts src/lib/openShopToolRunner.test.ts
Expected: PASS。

- [ ] **Step 2: 运行生产构建**

Run: npm run build
Expected: PASS，TypeScript 与 Vite 构建均无错误。

- [ ] **Step 3: 检查实际产物与工作树**

Run: git diff --check and git status --short --branch
Expected: 无空白错误；仅本计划所列文件及两份设计/计划文档变更，已有 docs/openshop-agent-tool-evaluation.md 与 image-sample-library 仍保持未跟踪且未修改。

- [ ] **Step 4: 提交前请求用户确认**

本仓库规则禁止自动提交。完成验证后向用户展示 diff 摘要并询问是否运行：

~~~bash
git add docs/superpowers/specs/2026-08-14-openshop-download-recovery-design.md docs/superpowers/plans/2026-08-14-openshop-download-recovery.md src/lib/imageDownload.ts src/lib/imageDownload.test.ts src/components/TaskActionRow.tsx src/components/TaskActionRow.test.tsx src/components/ImageContextMenu.tsx src/components/OpenShopWorkspace.tsx src/components/OpenShopWorkspace.test.tsx src/lib/openshopBridge.ts src/lib/openshopBridge.test.ts src/lib/openShopToolRunner.ts src/lib/openShopToolRunner.test.ts public/openshop/index.html e2e/agent-openshop-smoke.spec.ts
git commit -m "fix: 修复 OpenShop 原图下载与恢复阻塞"
~~~
