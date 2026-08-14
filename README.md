<div align="center">

# 🎨 GPT Image Playground

[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](LICENSE)
[![React](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**基于 OpenAI gpt-image-2 API 的图片生成与编辑工具**

提供简洁精美的 Web UI，支持 OpenAI / OpenAI 兼容接口、fal.ai 与可导入的自定义 HTTP 服务商。<br>
支持文本生图、参考图与遮罩编辑，数据纯本地化存储，带来流畅的历史记录与参数管理体验。

</div>

<br>

> 💡 **提示**：若需调用非 HTTPS 的内网或本地 HTTP API，请自行部署到允许该访问策略的环境。

---

## 📸 界面预览

<details>
<summary><b>点击展开截图展示</b></summary>
<br>

<div align="center">
  <b>桌面端主界面</b><br>
  <img src="docs/images/example_pc_1.png" alt="桌面端主界面" />
</div>

<br>

<div align="center">
  <b>任务详情与实际参数</b><br>
  <img src="docs/images/example_pc_2.png" alt="任务详情与实际参数" />
</div>

<br>

<div align="center">
  <b>桌面端批量选择</b><br>
  <img src="docs/images/example_pc_3.png" alt="桌面端批量选择" />
</div>

<br>

<div align="center">
  <b>移动端主界面</b><br>
  <img src="docs/images/example_mb_1.jpg" alt="移动端主界面" width="420" />
</div>

<br>

<div align="center">
  <b>移动端侧滑多选</b><br>
  <img src="docs/images/example_mb_2.jpg" alt="移动端侧滑多选" width="420" />
</div>

</details>

---

## ✨ 核心特性

### 🎨 强大的图像生成与编辑
- **Images / Responses 兼容**：兼容配置可使用常规 `Images API` (`/v1/images`) 或 `Responses API` (`/v1/responses`)；Agent 会在每次提交时自动选择内部执行路径，不要求用户选择协议或模式。
- **参考图与遮罩**：支持上传最多 16 张参考图（支持剪贴板和拖拽）。内置可视化遮罩编辑器，自动预处理以符合官方分辨率限制。
- **批量与迭代**：支持单次多图生成；一键将满意结果转为参考图，无缝开启下一轮修改。

### 🤖 统一图片 Agent
- **自动路由与执行**：前台只保留一个 Agent 入口、一份会话历史和一个输入框。无硬约束的生成或语义编辑使用 Responses 流式路径；精确尺寸、裁剪、旋转、格式等硬约束自动进入 Gateway action 链，无需用户确认。
- **严格交付 fail-closed**：Gateway 会冻结计划、自动入队、执行并校验最终产物；Gateway 不可用、action 失败或 metadata 不匹配时，硬约束请求明确失败，绝不降级为模型自选尺寸的 Responses 生图。
- **Responses 是前置条件**：当前 Responses 配置不可用时，整个 Agent 输入会被阻断，Gateway 不能单独解锁严格处理能力。服务端托管 Responses 且 Gateway 可达时，普通 Agent 回合经受控流式 relay 转发；浏览器不能指定 Gateway 上游、凭据、模型、工具或原始请求体。

### ⚙️ 精细化参数追踪
- **智能尺寸控制**：提供 1K/2K/4K 快速预设，自定义宽高时会自动规整至模型安全范围（16 的倍数、总像素校验等）。
- **实际参数对比**：自动提取 API 响应中真实生效的尺寸、质量、耗时以及**模型改写后的提示词**，与你的请求参数高亮对比。支持定制化的参数列表横向平滑滚动体验。

### 📁 高效历史管理 (纯本地)
- **瀑布流与画廊**：历史任务自动保存，支持按状态过滤、全屏大图预览与快捷下载。
- **快捷批量操作**：桌面端支持鼠标拖拽框选、Ctrl/⌘ 连选，移动端支持顺滑侧滑多选；轻松实现批量收藏与清理。
- **极致性能与隐私**：所有记录与图片均存放在浏览器 IndexedDB 中（采用 SHA-256 去重压缩），不经过任何第三方服务器。支持一键打包导出 ZIP 备份。

### 🔌 多配置与服务商增强
- **多配置管理**：支持创建并保存多个 API 配置（包含服务商、API Key、模型等），按需快速切换；支持一键复制当前配置到列表底部，并通过拖拽对配置列表与服务商列表进行自定义排序。
- **多服务商接入**：内置 OpenAI 兼容接口（含 `Images API` 和 `Responses API`）、fal.ai（支持队列），并支持通过 JSON 导入自定义 HTTP 服务商配置（兼容同步/异步任务）。
- **API 代理**：OpenAI 兼容接口与 fal.ai 均可配置自定义代理。其中 OpenAI 兼容接口可开启同源 `/api-proxy/` 代理，交由 Docker 或本地开发环境转发至真实 API，绕开浏览器 CORS 限制。
- **Codex CLI 兼容模式**：对上游为 Codex CLI 的 API，开启后应用 Codex CLI 实际支持的参数，并将多图生成拆分为并发单图。
- **提示词防改写**：Responses API 会始终在请求文本前加入强制指令防止提示词被改写；开启 Codex CLI 模式后，Images API 也会获得同等保护。
- **智能诊断提示**：当检测到接口异常改写行为或缺少常规参数时，自动提示开启相应的兼容模式。
- **习惯配置**：支持设置提交后清空输入、重启后保留历史输入、临时复用历史任务 API 配置等。

---

## 🚀 部署与使用

支持多种部署与开发方式。无论使用哪种方式，你都可以预设默认的 API 节点。

<details>
<summary><strong>▲ 方式一：Vercel 一键部署 (推荐)</strong></summary>

将本仓库导入 Vercel 后，Vercel 会自动执行构建并部署静态文件。

**配置默认 API URL**：在 Vercel 项目的 **Settings → Environment Variables** 中添加 `VITE_DEFAULT_API_URL`（如 `https://api.openai.com/v1`），然后重新部署即可生效。

**绑定自定义域名 (国内直连)**：Vercel 默认分配的 `.vercel.app` 域名在国内通常无法直接访问。如果你希望在国内直连访问，请在 Vercel 项目的 **Settings → Domains** 中绑定你自己的域名。

**配置自动更新**：

本项目已在 `vercel.json` 中关闭了默认的自动部署。若需在推送代码或发布版本后自动更新 Vercel 部署：

1. 在 Vercel 项目设置 **Settings -> Git** 的 **Deploy Hooks** 中创建一个名为 `Release` 的 Hook（Branch 填 `main`）并复制生成的 URL。
2. 在你 Fork 的 GitHub 仓库设置 **Settings -> Secrets and variables -> Actions** 中，新建 Secret `VERCEL_DEPLOY_HOOK`，填入刚才的 URL。

此后，每次触发对应 GitHub Actions 工作流，都会自动触发 Vercel 构建部署最新版。

</details>

<details>
<summary><strong>☁️ 方式二：Cloudflare Workers 部署</strong></summary>

项目已内置 Wrangler 配置，可将 Vite 构建产物作为 Cloudflare Workers 静态资源部署。

**1. 登录 Cloudflare**

```bash
npx wrangler login
```

**2. 部署到 Workers**

```bash
npm run deploy:cf
```

部署脚本会先执行 `npm run build`，再通过 `wrangler deploy` 上传 `dist/` 目录。

**配置默认 API URL**：Cloudflare Workers 的环境变量不会自动改写已经构建好的静态文件。若需预设默认 API 地址，请在构建前设置 `VITE_DEFAULT_API_URL` 后再部署。

```bash
VITE_DEFAULT_API_URL=https://api.openai.com/v1 npm run deploy:cf
```

PowerShell 示例：

```powershell
$env:VITE_DEFAULT_API_URL="https://api.openai.com/v1"; npm run deploy:cf
```

</details>

<details>
<summary><strong>🐳 方式三：Docker 部署</strong></summary>

Docker 部署兼容原有浏览器 Profile、同源 API 代理和服务端统一 API 配置；启用 Agent 时，前台仍只有一个自动路由的 Agent，不显示旧的双入口控制或确认步骤。你可以使用本仓库工作流发布的镜像，或在本地构建镜像。

**统一 Agent 与 Gateway（可信部署推荐）：**

Agent 首先需要一套可用的 Responses 配置：服务端托管时保持 `SERVER_API_MODE=responses`，并在 `SERVER_API_MODE_OPTIONS` 中包含 `responses`；BYOK 时选择带 API Key 的 OpenAI 兼容 Responses Profile。Responses 不可用时整个 Agent 被阻断，单独设置 `RESTRICTED_AGENT_ENABLED=true` 不会开启 Agent。

Gateway 的 action 链只处理命中精确尺寸、比例、裁剪、旋转、翻转、缩放、格式、透明或压缩等硬约束的回合。它会原子地创建不可变计划与 execution 并自动入队，界面仅展示进度、审计、取消和重试；旧的确认 API 仅保留给旧计划读取、恢复与兼容调用。`openshop.edit` 仍是独立兼容 action，不参与新的严格输出链。

服务端托管 Responses 且 Gateway 可达时，无硬约束的 Agent Responses 回合会通过 `POST /agent-api/v1/responses/image` 受控流式转发。该 relay 不是严格 action 链的降级入口：它使用现有 `AGENT_UPSTREAM_BASE_URL`、`AGENT_API_KEY` 与 `AGENT_PLANNER_MODEL`，不新增环境变量；`AGENT_IMAGE_MODEL` 继续仅用于严格 action 链中的 `/images/*` 调用。Gateway 不可用时，普通无硬约束回合保留既有的 Responses 直连或同源 `/api-proxy` 传输；带硬约束的回合明确失败，绝不回退到 Responses。

启用 Gateway 时至少配置：

```env
RESTRICTED_AGENT_ENABLED=true
AGENT_PUBLIC_ORIGIN=https://你的站点域名
AGENT_SESSION_SECRET=至少32字符的随机字符串
AGENT_UPSTREAM_BASE_URL=https://api.openai.com/v1
AGENT_API_KEY=sk-your-server-key
AGENT_PLANNER_MODEL=你的规划模型
AGENT_IMAGE_MODEL=你的图片模型
```

关键限制均可通过 `AGENT_*` 环境变量调整，默认包括：计划 15 分钟过期、最多 16 张参考图、128 MiB 上传、每次 1–4 张输出、全局并发 2、队列 10。完整变量和默认值见 [.env.example](.env.example)。

Gateway 只在 Compose 内网暴露 `3000`，图片和 SQLite 数据保存在 `agent-gateway-data` volume 中。严格 action 链不适用于纯静态托管；纯静态部署仍可在 Responses 可用时使用普通 Agent 回合。Gateway 不健康时，严格规格会失败关闭；普通回合是否继续可用取决于已有的服务端统一 Responses 配置或浏览器 Profile。

Gateway 的严格 action 链使用服务端固定 Images API 执行器，上游必须支持 `b64_json` 图片结果；不接受远程结果 URL，以避免 Gateway 代替用户抓取外部资源。

**兼容模式变量（`SERVER_API_CONFIG_ENABLED=false`，默认）：**

- `DEFAULT_API_URL`：设置页面上默认显示的 API 地址，默认回退到 `API_URL`，再回退到 `https://api.openai.com/v1`。
- `API_PROXY_URL`：内置代理实际转发到的目标 API 地址，默认回退规则同上。
- `ENABLE_API_PROXY`：`true` 时开启容器内 Nginx 同源代理；默认 `false`。浏览器 Authorization 会原样转发给上游。
- `LOCK_API_PROXY`：在 `ENABLE_API_PROXY=true` 时设为 `true`，会锁定前端代理开关；默认 `false`。
- `API_URL`：旧版兼容变量，同时作为 `DEFAULT_API_URL` 和 `API_PROXY_URL` 的兜底值；建议逐步迁移到拆分后的变量。
- `HOST` / `PORT`：容器内 Nginx 监听地址和端口，默认 `0.0.0.0:80`。

**服务端统一配置变量：**

- `SERVER_API_CONFIG_ENABLED`：统一配置总开关，严格使用小写 `true` 或 `false`，默认 `false`。
- `SERVER_API_UPSTREAM_URL`：真实上游地址，默认空；开启时必填，只接受安全的 `http://` 或 `https://` URL，不接受 userinfo、query 或 fragment。
- `SERVER_API_KEY`：上游 API Key，默认空；开启时必填。填写原始 Key，不要添加 `Bearer ` 前缀。允许字母、数字及 `._~+/=-`，最大 4096 字符。
- `SERVER_API_MODEL`：统一使用的模型，默认 `gpt-image-2`；必须以字母或数字开头，其余字符仅允许字母、数字及 `._~:/+@=-`，最大 256 字符。
- `SERVER_API_MODE`：`images` 或 `responses`，默认 `images`。Nginx 会据此只放行对应的 Images API 或 Responses API 路径；服务端托管的统一 Agent 需要当前选择为 `responses`。
- `SERVER_API_MODEL_OPTIONS`：允许用户在设置里选择的模型列表，逗号分隔，默认开放 `gpt-image-2,gpt-5.5`，覆盖 Images API 和 Responses API 常用模型。列表项仍需符合模型 ID 字符限制。
- `SERVER_API_MODE_OPTIONS`：允许用户在设置里选择的接口模式，逗号分隔，可包含 `images`、`responses`，默认开放 `images,responses`。Nginx 会按该列表放行对应路径；如需使用统一 Agent，列表必须包含 `responses`。如需限制用户只能使用单一协议，可显式设置为 `images` 或 `responses`。
- `SERVER_API_ALLOW_CUSTOM_MODEL`：是否允许用户在设置里输入自定义模型 ID，严格使用小写布尔值，默认 `true`；设为 `false` 时只能选择 `SERVER_API_MODEL_OPTIONS` 中的模型。
- `SERVER_API_CODEX_CLI`：是否启用 Codex CLI 兼容参数，严格使用小写布尔值，默认 `false`。
- `SERVER_API_RESPONSE_FORMAT_B64_JSON`：是否请求 Base64 JSON 图片结果，严格使用小写布尔值，默认 `false`。
- `SERVER_API_TIMEOUT_SECONDS`：请求超时秒数，必须是 `10..600` 的十进制整数，默认 `600`。

统一模式仅支持 OpenAI 兼容接口，不支持 fal.ai 或自定义 Provider。开启后，服务端会强制启用并锁定 `/api-proxy`，将代理目标固定为 `SERVER_API_UPSTREAM_URL`，并用 `SERVER_API_KEY` 生成的 Authorization 覆盖任何客户端请求头；`API_PROXY_URL`、`ENABLE_API_PROXY` 和 `LOCK_API_PROXY` 不再决定实际代理行为。该路径继续服务于既有 Images/Responses 调用，并在 Gateway 不可达时承接无硬约束的 Agent Responses 回合；当 Gateway 可达时，服务端托管的 Agent Responses 会改经 `/agent-api/v1/responses/image` relay，使用 Gateway 的 `AGENT_*` 上游与凭据。用户只能在部署端通过 `SERVER_API_MODE_OPTIONS` 预设的范围内选择接口模式；模型默认允许选择预设项或输入自定义模型 ID，也可通过 `SERVER_API_ALLOW_CUSTOM_MODEL=false` 限制为只能选择 `SERVER_API_MODEL_OPTIONS`。用户不能修改 API URL 或 API Key。

统一模式访问 HTTPS upstream 时会启用 SNI，并使用镜像内系统 CA 校验证书链与主机名；证书无效、过期、自签名或主机名不匹配时请求会失败。若使用 HTTP，Bearer Key 和请求内容不会被加密，只能用于受信任内网、VPN 或其他隔离网络，禁止经过不可信公网链路。

为避免连接失败时在容器日志中回显 upstream 主机、IP、路径或其他部署细节，统一模式会抑制代理 location 的底层运行时错误日志；客户端仍会收到对应 HTTP 错误状态。兼容模式继续将代理错误写入 stderr，便于沿用原有排查方式。

客户端保存的 Profiles、API URL/Key、URL 参数、配置导入和历史任务中的服务商、地址、密钥等固定 API 配置均不能覆盖统一配置；模型字段仅在 `SERVER_API_ALLOW_CUSTOM_MODEL=true` 时允许作为用户选择生效。浏览器只能读取不含 Key 和上游 URL 的 `/runtime-config.json`；配置非法时容器启动会非零退出，运行时配置加载或校验失败时前端禁止提交，不会回退到客户端配置。

> ⚠️ **付费代理风险**：统一模式会暴露一个可消耗服务端额度的同源代理入口，项目本身不提供登录、租户隔离或完整限流。公网部署必须在外层增加认证、VPN、IP 白名单、网关限流等访问控制；仅隐藏 API Key 不能防止额度被滥用。

> 静态托管无法安全保存服务端 Key，也无法实现覆盖 Authorization 的反向代理，因此纯静态 Vercel、GitHub Pages、Netlify 等部署不能直接启用此模式。普通 `npm run build` 会以 `DEPLOY_TARGET=static` 构建并直接使用浏览器端 Legacy 配置，不依赖运行时配置文件。需要服务端统一配置或受限 Agent 时，应使用本 Docker/Nginx 实现；非 Docker 的等价实现必须在构建环境中显式设置 `DEPLOY_TARGET=runtime`，并提供 `/runtime-config.json` 及相应同源服务端协议。runtime 构建在配置缺失、加载失败或校验失败时始终拒绝提交，不会回退到浏览器凭据。

**服务端托管的统一 Agent 配置：**

服务端托管 Agent 同时需要 Responses 与 Gateway。前者决定 Agent 是否可提交；后者处理硬约束 action 链，并在可达时承接普通 Agent 回合的受控 Responses relay。除各自已有的模型和凭据外，至少需要同时设置以下变量：

```env
SERVER_API_CONFIG_ENABLED=true
SERVER_API_UPSTREAM_URL=https://api.openai.com/v1
SERVER_API_KEY=sk-your-server-key
SERVER_API_MODEL=gpt-5.5
SERVER_API_MODE=responses
SERVER_API_MODEL_OPTIONS=gpt-image-2,gpt-5.5
SERVER_API_MODE_OPTIONS=images,responses

RESTRICTED_AGENT_ENABLED=true
RESTRICTED_AGENT_ONLY=false
AGENT_PUBLIC_ORIGIN=https://你的站点域名
AGENT_SESSION_SECRET=至少32字符的随机字符串
AGENT_UPSTREAM_BASE_URL=https://api.openai.com/v1
AGENT_API_KEY=sk-your-agent-server-key
AGENT_PLANNER_MODEL=你的规划模型
AGENT_IMAGE_MODEL=你的图片模型
```

`RESTRICTED_AGENT_ONLY=false` 会保留 Gallery/Agent 工作区入口；设为 `true` 时隐藏 Gallery 并默认进入 Agent 工作区。该开关不改变自动路由，也不会绕过 Responses 前置条件。`SERVER_API_KEY` 与 `AGENT_API_KEY` 可以相同，但生产环境可按调用边界拆分，便于独立限额、轮换和熔断；两组上游及模型必须都支持各自承担的 Responses 或 Images 请求。

**部署后 health/readiness smoke：**

以下 smoke 命令统一使用独立 Compose project `openshop-smoke`。仓库的 Compose 文件显式指定了 `gpt-image-playground:latest` 与 `gpt-image-playground-agent-gateway:latest`；直接执行 `build/up` 可能更新本机同名 `latest` 标签，并不提供镜像标签隔离。

```bash
docker compose -p openshop-smoke up -d --build --wait --wait-timeout 180
docker compose -p openshop-smoke ps
docker compose -p openshop-smoke exec -T gpt-image-playground wget -qO- http://127.0.0.1/runtime-config.json
docker compose -p openshop-smoke exec -T gpt-image-playground wget -qO- http://127.0.0.1/agent-api/v1/capabilities
docker compose -p openshop-smoke exec -T agent-gateway node -e "fetch('http://127.0.0.1:3000/healthz').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```

统一 Agent 部署的 `runtime-config.json` 应同时包含 `serverApi.enabled: true` 与 `restrictedAgent.enabled: true`；capabilities 应返回 HTTP 200，并在 `operationTypes` 中包含 `image.transform`、`metadata.assert` 与兼容的 `openshop.edit`。修改环境变量或镜像后可执行以下重启检查：

```bash
docker compose -p openshop-smoke restart
docker compose -p openshop-smoke up -d --wait --wait-timeout 180
docker compose -p openshop-smoke ps
```

**本地发布门禁与 Chromium E2E：**

```bash
npm ci
npm --prefix gateway ci
npm run test:all
npm run build:all
npm run test:docker-config
npm run test:e2e:install
npm run test:e2e
```

首次运行或干净环境需要先通过 `npm run test:e2e:install` 安装 Chromium。当前 Playwright 配置会在 `127.0.0.1:4173` 启动 Vite，并通过确定性 fixture 验证单一 Agent 的普通 Responses 回合、严格 action 链、自动执行、刷新不重放、跨页面 CAS 和 OpenShop 兼容行为；它不是对 Compose 容器的浏览器访问。容器镜像、运行时配置、Nginx 到 Gateway 的链路和重启恢复应使用上面的 Docker smoke 单独验证。

**验证环境清理：**

只对专门用于 smoke 的 Compose project 执行清理。以下命令会删除该 project 的容器、网络和 `agent-gateway-data` 临时卷，其中的图片、执行记录与 SQLite 审计不可恢复；请勿对生产 project 使用：

```bash
docker compose -p openshop-smoke down --volumes --remove-orphans
```

该命令只清理 `openshop-smoke` project 的容器、网络和卷，不删除镜像。不要在未配置真实镜像标签隔离方案时删除仓库 Compose 使用的 `latest`。如果验证产生了 `.playwright/test-results/` 或本地 `dist/`、`gateway/dist/`，确认不再需要后也应一并移除。

**静态部署与回滚：**

纯静态构建不提供 Gateway。浏览器 Profile 的 Responses 配置可用时，Agent 仍可完成无硬约束回合；精确尺寸、裁剪、旋转、格式等严格请求会明确失败，不会伪装成近似生成。Docker 部署可通过 `RESTRICTED_AGENT_ENABLED=false` 关闭严格 action 链与受控 relay，或通过 `SERVER_API_CONFIG_ENABLED=false` 关闭服务端统一配置并恢复浏览器端配置。回滚后重新创建容器并重复 health/readiness smoke，确认公开配置与预期一致。

**1. 服务端统一配置：Docker CLI 示例**

```bash
docker run -d -p 8080:80 \
  -e SERVER_API_CONFIG_ENABLED=true \
  -e SERVER_API_UPSTREAM_URL=https://api.openai.com/v1 \
  -e SERVER_API_KEY=sk-your-server-key \
  -e SERVER_API_MODEL=gpt-image-2 \
  -e SERVER_API_MODE=images \
  -e SERVER_API_MODEL_OPTIONS=gpt-image-2,gpt-5.5 \
  -e SERVER_API_MODE_OPTIONS=images,responses \
  -e SERVER_API_ALLOW_CUSTOM_MODEL=true \
  -e SERVER_API_CODEX_CLI=false \
  -e SERVER_API_RESPONSE_FORMAT_B64_JSON=false \
  -e SERVER_API_TIMEOUT_SECONDS=600 \
  ghcr.io/<owner>/<repo>:latest
```

**2. 服务端统一配置：Docker Compose 示例**

```yaml
services:
  gpt-image-playground:
    image: ghcr.io/<owner>/<repo>:latest
    environment:
      SERVER_API_CONFIG_ENABLED: "true"
      SERVER_API_UPSTREAM_URL: "https://api.openai.com/v1"
      SERVER_API_KEY: "${OPENAI_API_KEY}"
      SERVER_API_MODEL: "gpt-image-2"
      SERVER_API_MODE: "images"
      SERVER_API_MODEL_OPTIONS: "gpt-image-2,gpt-5.5"
      SERVER_API_MODE_OPTIONS: "images,responses"
      SERVER_API_ALLOW_CUSTOM_MODEL: "true"
      SERVER_API_CODEX_CLI: "false"
      SERVER_API_RESPONSE_FORMAT_B64_JSON: "false"
      SERVER_API_TIMEOUT_SECONDS: "600"
    ports:
      - "8080:80"
    restart: unless-stopped
```

**3. Dokploy 部署**

在 Dokploy 中创建 Compose 应用并连接本仓库：

1. Compose Path 填 `./docker-compose.yml`。
2. 在 Domains 中添加域名，Service 选择 `gpt-image-playground`，Container Port 填 `80`。
3. 如需服务端统一配置，在 Environment 中填入 `.env.example` 对应变量，并将 `SERVER_API_CONFIG_ENABLED` 设为 `true`。
4. `SERVER_API_KEY` 只能放在 Dokploy Environment 中，不要写入仓库文件。

如需统一 Agent，在 Dokploy 中先配置可用的服务端 Responses，再设置 `RESTRICTED_AGENT_ENABLED=true` 和全部必填 `AGENT_*` 变量。域名仍绑定前端 `gpt-image-playground:80`，不要单独暴露 Gateway 端口；Gateway 使用既有 `/agent-api/` 路由承接严格 action 链与受控 Responses relay。

回滚时将 `SERVER_API_CONFIG_ENABLED=false` 并重启容器，即可恢复原有 `DEFAULT_API_URL` / `API_PROXY_URL` / `ENABLE_API_PROXY` / `LOCK_API_PROXY` 行为。使用 `latest` 标签时，重新拉取镜像并重启即可更新（如 `docker compose pull && docker compose up -d`）；生产环境建议固定版本标签。

</details>

<details>
<summary><strong>💻 方式四：本地开发与静态构建</strong></summary>

**1. 环境准备与启动**

你可以在项目根目录新建 `.env.local` 文件配置默认 API URL（如 `VITE_DEFAULT_API_URL=https://api.openai.com/v1`）。然后安装依赖并启动：

```bash
npm install
npm run dev
```

**2. 本地开发跨域代理 (可选)**

如果在本地开发时遇到浏览器的 CORS 限制，可开启本地代理转发：

```bash
cp dev-proxy.config.example.json dev-proxy.config.json
```

修改 `dev-proxy.config.json`，将 `target` 设置为真实的图片接口地址。重启开发服务器后，在页面设置中开启 **API 代理** 即可（请求将被转发如 `http://localhost:5173/api-proxy/... -> target/...`）。此功能仅在 `npm run dev` 阶段生效，不会影响打包产物。

**3. 本地故障模拟 API (可选)**

如果需要复现图片 URL 跨域、接口返回结构异常、原始响应查看等问题，可启动内置模拟服务：

```powershell
npm run mock:api
```

使用方式见 [本地故障模拟 API](docs/mock-image-api.md)。

**4. 构建静态产物**

```bash
npm run build
```

Gateway 使用独立依赖和构建目录：

```bash
npm --prefix gateway ci
npm run test:gateway
npm run build:gateway
```

本地联调 Gateway 建议使用 Docker Compose，避免在开发服务器中复制生产安全边界：

```bash
docker compose up --build
```

构建输出的文件位于 `dist/` 目录下，可将其部署至任何静态文件服务器（如普通 Nginx、GitHub Pages、Netlify 等）。

</details>

---

## 🛠️ URL 传参快速填充

应用支持通过 URL 查询参数快速填入配置，非常适合创建书签或集成分享。根据你的服务商类型，选择对应的方式：

**方式一：标准 OpenAI 兼容服务商**
直接使用简短的查询参数配置：
- `?apiUrl=https://你的代理地址.com`
- `?apiKey=sk-xxxx`
- `?apiMode=images` 或 `?apiMode=responses`（未传时默认为 `images`）
- `?model=gpt-image-2`（未传时按 `apiMode` 使用默认模型）
- `?codexCli=true`（开启 Codex CLI 兼容模式）

例如，集成到 New API 的聊天系统：

```text
https://your-domain.example?apiUrl={address}&apiKey={key}&model={model}
```

```text
https://your-pages-domain.example?apiUrl={address}&apiKey={key}&model={model}
```

**方式二：自定义格式服务商**
如果需要导入自定义格式的 API 配置，请使用 `settings` 参数并传入 URL 编码后的完整 JSON：
- `?settings={URL编码后的JSON}`（只读取 `customProviders` 和 `profiles` 列表）

> 推荐先在项目内完成配置生成与导入：
>
> **设置 - API 配置 - 服务商类型 - 创建自定义服务商 - AI 一键生成与导入**
>
> 完成后可在 **API 配置 - 当前配置** 使用右侧快捷按钮：
>
> - **链接按钮**：复制可导入配置的 URL。复制时可选择不包含 API Key，并使用 `{address}`、`{key}`、`{model}` 等变量，便于在 New API 等平台中集成分享。
> - **复制按钮**：将当前配置复制一份到配置列表底部，新配置名称会追加“（复制）”。

JSON 结构示例：

```json
{
  "customProviders": [
    {
      "id": "custom-example-task",
      "name": "示例异步任务服务商",
      "submit": {
        "path": "images/generations",
        "method": "POST",
        "contentType": "json",
        "body": {
          "model": "$profile.model",
          "prompt": "$prompt",
          "size": "$params.size",
          "quality": "$params.quality",
          "output_format": "$params.output_format",
          "output_compression": "$params.output_compression",
          "n": "$params.n",
          "image_urls": "$inputImages.dataUrls"
        },
        "taskIdPath": "data.0.task_id"
      },
      "poll": {
        "path": "tasks/{task_id}",
        "method": "GET",
        "intervalSeconds": 5,
        "statusPath": "data.status",
        "successValues": ["completed"],
        "failureValues": ["failed", "cancelled"],
        "errorPath": "data.error.message",
        "result": {
          "imageUrlPaths": ["data.result.images.*.url.*"],
          "b64JsonPaths": []
        }
      }
    }
  ],
  "profiles": [
    {
      "name": "示例异步任务服务商",
      "provider": "custom-example-task",
      "baseUrl": "https://api.example.com/v1",
      "model": "example-image-model",
      "apiMode": "images"
    }
  ]
}
```

第三方服务商可以参考 [自定义服务商 LLM 提示词](docs/custom-provider-llm-prompt.md)，让 LLM 根据自己的 API 文档生成可导入的完整配置。导入后只需要在设置里补充 API Key。

---

## 💻 技术栈

<div align="center">
  <br>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS_3-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS 3" /></a>
  <a href="https://zustand.docs.pmnd.rs/"><img src="https://img.shields.io/badge/Zustand-764ABC?style=for-the-badge&logo=react&logoColor=white" alt="Zustand" /></a>
  <a href="https://fastify.dev/"><img src="https://img.shields.io/badge/Fastify-000000?style=for-the-badge&logo=fastify&logoColor=white" alt="Fastify" /></a>
  <a href="https://sqlite.org/"><img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" /></a>
  <br>
  <br>
</div>

## 📄 许可证 & 致谢

本项目基于 [MIT License](LICENSE) 开源。

特别致谢：[LINUX DO](https://linux.do)
