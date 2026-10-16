# Issue #5：Agent CSRF 拒绝的本地复现与修复验证

## 环境与限制

本机没有 `docker` 或 `nginx` 可执行文件。因此以下是对 Issue 中「本机 docker-compose 复现」的**替代做法**：直接运行 Gateway (`npm --prefix gateway run dev`) 和 Vite (`npm run dev -- --host 127.0.0.1`)，让 Vite 将同源 `/agent-api/` 转发到 Gateway。真实 Docker 容器、nginx 和部署环境的流程验证**未执行**。上游规划服务使用不可连接的合成地址，所以流请求通过 CSRF 后以 `plan.failed: Planner 无法连接` 结束；本记录仅验证它进入规划阶段。

本地忽略文件 `.env.local` 设置 `RESTRICTED_AGENT_ENABLED=true`、`AGENT_HOST=127.0.0.1`、`AGENT_PORT=3000`、`AGENT_PUBLIC_ORIGIN=http://127.0.0.1:5173`、长度超过 32 字符的合成 `AGENT_SESSION_SECRET`、`AGENT_UPSTREAM_BASE_URL=http://127.0.0.1:3999/v1`、合成 `AGENT_API_KEY`、合成模型名、`AGENT_WEB_SEARCH_ENABLED=false`、`AGENT_LOG_LEVEL=info` 和本地数据目录。忽略文件 `dev-proxy.config.json` 设置 `prefix=/agent-api`、`target=http://127.0.0.1:3000`、`changeOrigin=false`。两者均未提交，验证后删除。

实际准备命令：`npm ci`、`npm --prefix gateway ci`、`npm --prefix gateway/node_modules/better-sqlite3 run install`（npm 默认阻止该原生依赖安装脚本）、`env -u HTTPS_PROXY -u https_proxy npx playwright install chromium`。Gateway 终端运行 `set -a; source .env.local; set +a; npm --prefix gateway run dev`，Vite 终端运行 `npm run dev -- --host 127.0.0.1`。浏览器为 Playwright Chromium 139.0.7258.5，页面为顶层 `http://127.0.0.1:5173/`，不是跨站 iframe。开发入口默认注销 Service Worker，复现脚本显式执行 `navigator.serviceWorker.register('/sw.js')` 并等待 `controllerchange`，以还原生产入口自动注册主 Service Worker 的行为。

## 修复前的稳定复现

1. 在顶层页面执行 `fetch('/agent-api/v1/capabilities', { credentials: 'same-origin', cache: 'no-store' })`。主 Service Worker 使用 `caches.match(request)` 后 `cache.put(request, response.clone())`，将包含 CSRF token 的响应放入 `gpt-image-playground-shell-v2`。第一次响应 `200`，token 为 `7aacbKKHc-o4Moulfp0RKIQBCz9BwSnk79s5KiavgVQ`；浏览器 Cookie 为 `agent_sid=d4_eiPHzI9FNGol_oPV7yKhrZd1UjDiH.2owc7Z7jcatgrLaR3npw-F3L17Z2snIMUKyuLMObk3I`，属性 `HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`，本地 HTTP 无 `Secure`。
2. 执行 Playwright `context.clearCookies()` 模拟会话 Cookie 到期，不清 Cache API。再次执行同一 `fetch`，响应仍为 `200` 且 token **仍是** `7aacbKKHc-o4Moulfp0RKIQBCz9BwSnk79s5KiavgVQ`；`response.fromServiceWorker() === true`，此时浏览器 Cookie 列表为空。Gateway 日志没有对应的第二次 GET。浏览器请求虽指定 `cache: 'no-store'`，仍被 Service Worker 的 Cache API 命中。
3. 在同一顶层页面执行 `fetch('/agent-api/v1/plans/stream', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': '7aacbKKHc-o4Moulfp0RKIQBCz9BwSnk79s5KiavgVQ', Accept: 'text/event-stream' }, body: form })`，其中 `FormData` 的 `request=测试`。实际请求头（Playwright `request.allHeaders()` 的安全相关原值）：`host: 127.0.0.1:5173`、`origin: http://127.0.0.1:5173`、`referer: http://127.0.0.1:5173/`、`sec-fetch-site: same-origin`、`content-type: multipart/form-data; boundary=----WebKitFormBoundaryUbMABu5RD6KCdC26`、`content-length: 144`、`accept: text/event-stream`、`x-csrf-token: 7aacbKKHc-o4Moulfp0RKIQBCz9BwSnk79s5KiavgVQ`；**没有 `cookie` 请求头**。
4. 实际响应：`HTTP 403`；响应头 `Access-Control-Allow-Origin: http://127.0.0.1:5173`、`Vary: Origin`、`content-type: application/json; charset=utf-8`、`content-length: 64`、`set-cookie: agent_sid=Tp4XWs5qpiObPr8rnEql160Hl0x2Zvmh.oO_lBcEG02Slten-0SNwDMKD-XIvog8_A5xW4imTxWM; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`；响应体 `{"error":{"code":"csrf_rejected","message":"CSRF token 无效"}}`。
5. 客户端模拟 403 后刷新 capabilities：依然从 Service Worker 返回旧 token。带新 Cookie `agent_sid=Tp4XWs5qpiObPr8rnEql160Hl0x2Zvmh.oO_lBcEG02Slten-0SNwDMKD-XIvog8_A5xW4imTxWM` 再次 POST，同样返回 `HTTP 403` 与相同错误体。Gateway 日志原文：

   ```json
   {"level":30,"time":1792126886276,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-d","req":{"method":"POST","url":"/v1/plans/stream","host":"127.0.0.1:5173","remoteAddress":"127.0.0.1","remotePort":57344},"msg":"incoming request"}
   {"level":30,"time":1792126886276,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-d","res":{"statusCode":403},"responseTime":0.33683399998699315,"msg":"request completed"}
   {"level":30,"time":1792126886281,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-e","req":{"method":"POST","url":"/v1/plans/stream","host":"127.0.0.1:5173","remoteAddress":"127.0.0.1","remotePort":57345},"msg":"incoming request"}
   {"level":30,"time":1792126886281,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-e","res":{"statusCode":403},"responseTime":0.25120800000149757,"msg":"request completed"}
   ```

Gateway 的默认日志不输出 Cookie 和 CSRF 头；上述头取自 Chromium 网络事件，Cookie 属性取自浏览器 Cookie 列表与 Gateway `Set-Cookie`。`Origin`/`Host` 均符合 `AGENT_PUBLIC_ORIGIN`，响应错误码也证明请求已通过 `requireSameOrigin()`。

**根因结论：** 主 Service Worker 将会话绑定的 `/agent-api/v1/capabilities` 响应放入 Cache API，忽略前端 `cache: 'no-store'` 和服务端 `Cache-Control: no-store` 的意图。`agent_sid` 失效或更换后，缓存中旧 token 与 Gateway 当前会话不对应，403 刷新仍得到同一个旧 token，因此连续 `csrf_rejected`。代码证据为修复前 `public/sw.js` 的通用 GET `caches.match` / `cache.put` 路径、`gateway/src/security.ts` 的 Cookie 到 token 推导及上述浏览器网络证据。

## 修复后的同场景验证

主 Service Worker 对同源 `/agent-api/v1/capabilities` 路径直接放行。再次运行同一顶层 Chromium 场景，并**主动向旧 Cache API 缓存放入一份旧 capabilities 响应**以覆盖升级后仍有旧缓存的情况。第一次 token 为 `pqRbhYGidlD2-ftJfkzmN-LjA5XOlowMCLEdI806rms`，Cookie 为 `agent_sid=eGeOSycC1Yp3YqTc2bLDYh9_qr3gzZCs.waPBfIPMLqU6Ndxut_H-y5ntYFxbjBrF1Lp4AUEfEd4`。清除 Cookie 后再次 GET，`response.fromServiceWorker() === false`，Gateway 返回新 token `uyxCDh8H9-HlJoNZuHSEvlbJf1lXPWcvcMZCIzO_wnQ` 与新 `agent_sid=IHB-xhOltzyHAioqGnF4pbYZO5R71l4-.ZKXOwf5E0gkFJekGPWrOVuulpE-_Vw49V22Bvw9SwJU; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`。GET 的请求头含 `host: 127.0.0.1:5173`、`referer: http://127.0.0.1:5173/`、`sec-fetch-site: same-origin`；响应头含 `cache-control: no-store`、`content-type: application/json; charset=utf-8`、`set-cookie` 如上。POST 使用新 token、同源 `Origin` 和新 Cookie，得到 `HTTP 200`、`content-type: text/event-stream; charset=utf-8`、`cache-control: no-store`，响应体为 `event: plan.failed\ndata: {"message":"Planner 无法连接"}\n\n`，证明流程已经通过 CSRF 校验并进入规划阶段。Gateway 日志原文：

```json
{"level":30,"time":1792126958323,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-g","req":{"method":"GET","url":"/v1/capabilities","host":"127.0.0.1:5173","remoteAddress":"127.0.0.1","remotePort":57440},"msg":"incoming request"}
{"level":30,"time":1792126958323,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-g","res":{"statusCode":200},"responseTime":0.19808299996657297,"msg":"request completed"}
{"level":30,"time":1792126958326,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-h","req":{"method":"POST","url":"/v1/plans/stream","host":"127.0.0.1:5173","remoteAddress":"127.0.0.1","remotePort":57441},"msg":"incoming request"}
{"level":30,"time":1792126958328,"pid":89615,"hostname":"LoopLayandeMini.lan","reqId":"req-h","res":{"statusCode":200},"responseTime":1.8175419999752194,"msg":"request completed"}
```

回归测试 `src/lib/serviceWorker.test.ts` 执行发布的 `public/sw.js`，断言 capabilities GET 不进入 `respondWith` 和 Cache API；修复前失败、修复后通过，随 CI 的 `npm run test` 执行。`X-CSRF-Token`、`requireSameOrigin()` 与 `requireCsrf()` 均未修改。

验证结果：`npx vitest run src/lib/serviceWorker.test.ts src/lib/openshopPwa.test.ts`（6/6）、`npx tsc -b --pretty false`、`npm run test:gateway`（41/41）、`npm run test`（50 个文件、485/485）、`npm run build` 全部通过。首次 `npm run test` 在本地复现代理配置仍存在时有 3 项失败，均是 `api.test.ts` 读取 `/agent-api` 前缀而测试期望默认 `/api-proxy`；删除本次生成的本地代理配置后重跑全绿。`npm run test:docker-config` 与真实容器/nginx 集成验证未执行，因为本机没有 Docker 和 nginx。
