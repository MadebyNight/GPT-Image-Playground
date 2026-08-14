import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  createLegacyAgentSseFixture,
  LEGACY_AGENT_ASSISTANT_TEXT,
} from '../src/test/fixtures/legacyAgentResponses'

const AGENT_PLACEHOLDER = '描述想生成或编辑的图片；可添加参考图，也可指定尺寸、裁剪或旋转。'
const PLAN_ID = '11111111-1111-4111-8111-111111111111'
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222'
const FIXTURE_TIME = '2026-08-14T00:00:00.000Z'

interface RuntimeFixtureOptions {
  gatewayEnabled?: boolean
  responsesEnabled?: boolean
  agentOnly?: boolean
}

interface RequestCounters {
  responsesRelay: number
  autoExecute: number
  directResponses: number
}

function createRuntimeConfig({
  gatewayEnabled = true,
  responsesEnabled = true,
  agentOnly = true,
}: RuntimeFixtureOptions = {}) {
  return {
    version: 1,
    serverApi: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-5.5',
      apiMode: responsesEnabled ? 'responses' : 'images',
      modelOptions: ['gpt-5.5'],
      apiModeOptions: [responsesEnabled ? 'responses' : 'images'],
      allowCustomModel: true,
      codexCli: false,
      responseFormatB64Json: false,
      timeoutSeconds: 60,
      proxyPath: '/api-proxy',
    },
    restrictedAgent: {
      enabled: gatewayEnabled,
      basePath: '/agent-api/v1',
      agentOnly: gatewayEnabled && agentOnly,
    },
  }
}

function readMultipartField(body: string, field: string): string {
  const match = body.match(new RegExp(`name="${field}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))
  if (!match?.[1]) throw new Error(`E2E fixture 缺少 multipart 字段：${field}`)
  return match[1]
}

function hashComposerSnapshot(body: string) {
  return createHash('sha256')
    .update(readMultipartField(body, 'composerSnapshot'))
    .digest('hex')
}

function createStrictPipeline(prompt: string, composerSnapshotHash: string) {
  const finalOutputSpec = {
    width: 870,
    height: 220,
    fit: 'cover',
    position: 'center',
    outputFormat: 'png',
    outputCompression: null,
  }
  const actions = [
    {
      type: 'image.generate',
      generation: {
        exactPrompt: prompt,
        action: 'generate',
        size: '1536x1024',
        quality: 'auto',
        outputFormat: 'png',
        outputCompression: null,
        imageCount: 1,
      },
    },
    {
      type: 'image.transform',
      input: { kind: 'action_output', actionIndex: 0 },
      transform: finalOutputSpec,
    },
    {
      type: 'metadata.assert',
      input: { kind: 'action_output', actionIndex: 1 },
      expected: finalOutputSpec,
    },
  ]
  const actionIds = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ]

  return {
    plan: {
      schemaVersion: 3,
      composerSnapshotHash,
      id: PLAN_ID,
      version: 1,
      status: 'executing',
      expiresAt: '2099-01-01T00:00:00.000Z',
      originalRequest: prompt,
      summary: '严格尺寸执行计划',
      finalOutputSpec,
      actions,
      inputs: [],
      assumptions: ['默认使用 cover + center 输出策略。'],
      warnings: [],
      policyVersion: 'tool-action-v3',
    },
    execution: {
      id: EXECUTION_ID,
      planId: PLAN_ID,
      status: 'executing',
      cancelRequested: false,
      error: null,
      outputAssets: [],
      actions: actions.map((action, actionIndex) => ({
        id: actionIds[actionIndex],
        executionId: EXECUTION_ID,
        actionIndex,
        type: action.type,
        normalizedParams: action,
        status: actionIndex === 0 ? 'executing' : 'queued',
        idempotencyKey: String.fromCharCode(97 + actionIndex).repeat(64),
        error: null,
        inputAssets: [],
        outputAssets: [],
        createdAt: FIXTURE_TIME,
        startedAt: actionIndex === 0 ? FIXTURE_TIME : null,
        completedAt: null,
        updatedAt: FIXTURE_TIME,
      })),
      createdAt: FIXTURE_TIME,
      startedAt: FIXTURE_TIME,
      completedAt: null,
      updatedAt: FIXTURE_TIME,
    },
    assetBindings: [],
  }
}

async function blockExternalRequests(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const isInlineResource = url.protocol === 'data:' || url.protocol === 'blob:'
    const isLocal = (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    if (isInlineResource || isLocal) {
      await route.continue()
      return
    }
    await route.fulfill({ status: 204, body: '' })
  })
}

async function installRuntimeFixture(page: Page, options: RuntimeFixtureOptions = {}) {
  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(createRuntimeConfig(options)),
    })
  })
}

async function installGatewayCapabilities(page: Page) {
  await page.route('**/agent-api/v1/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          enabled: true,
          csrfToken: 'e2e-csrf-token',
          planSchemaVersions: [3],
          operationTypes: ['image.generate', 'image.edit', 'image.transform', 'metadata.assert'],
        },
      }),
    })
  })
}

async function gotoAgent(page: Page) {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)

  const agentTab = page.getByRole('tab', { name: 'Agent', exact: true })
  if (await agentTab.count()) await agentTab.click()
  await expect(page.locator('[data-agent-workspace-mounted]')).toBeVisible()
}

function composer(page: Page) {
  return page.locator(`[contenteditable][data-placeholder="${AGENT_PLACEHOLDER}"]:visible`)
}

async function submitAgentTurn(page: Page, prompt: string) {
  const editor = composer(page)
  await expect(editor).toBeVisible()
  await editor.fill(prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

function expectNoModeOrConfirmationControls(page: Page) {
  return Promise.all([
    expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveCount(0),
    expect(page.getByRole('tab', { name: 'Tool', exact: true })).toHaveCount(0),
    expect(page.getByRole('tablist', { name: 'Agent 模式', exact: true })).toHaveCount(0),
    expect(page.getByRole('button', { name: /确认|返回修改/ })).toHaveCount(0),
  ])
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page)
})

test('普通请求仅经 Responses relay，且前台没有 Chat/Tool 或确认入口', async ({ page }) => {
  const counters: RequestCounters = { responsesRelay: 0, autoExecute: 0, directResponses: 0 }
  await installRuntimeFixture(page)
  await installGatewayCapabilities(page)
  await page.route('**/agent-api/v1/responses/image', async (route) => {
    counters.responsesRelay += 1
    const payload = route.request().postDataJSON() as { request?: string; imageTool?: { type?: string } }
    expect(payload.request).toBe('生成一张雨夜的赛博朋克街道')
    expect(payload.imageTool?.type).toBe('image_generation')
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: createLegacyAgentSseFixture(),
    })
  })
  await page.route('**/agent-api/v1/plans/auto-execute', async (route) => {
    counters.autoExecute += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"普通回合不应进入 Tool Pipeline"}' })
  })
  await page.route('**/api-proxy/**', async (route) => {
    counters.directResponses += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"普通回合应使用 Gateway Responses relay"}' })
  })

  await gotoAgent(page)
  await expectNoModeOrConfirmationControls(page)
  await submitAgentTurn(page, '生成一张雨夜的赛博朋克街道')

  await expect.poll(() => counters.responsesRelay).toBe(1)
  await expect(page.locator('[data-agent-conversation-turn]').last()).toContainText(LEGACY_AGENT_ASSISTANT_TEXT)
  expect(counters.autoExecute).toBe(0)
  expect(counters.directResponses).toBe(0)
  await expectNoModeOrConfirmationControls(page)
})

test('870×220 严格回合自动调用 Tool Pipeline，零 Responses 且无确认控件', async ({ page }) => {
  const counters: RequestCounters = { responsesRelay: 0, autoExecute: 0, directResponses: 0 }
  let autoExecuteBody = ''
  let legacyExecuteRequests = 0
  await installRuntimeFixture(page)
  await installGatewayCapabilities(page)
  await page.route('**/agent-api/v1/responses/image', async (route) => {
    counters.responsesRelay += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"严格回合不得调用 Responses"}' })
  })
  await page.route('**/api-proxy/**', async (route) => {
    counters.directResponses += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"严格回合不得回退到 Responses"}' })
  })
  await page.route('**/agent-api/v1/plans/auto-execute', async (route) => {
    counters.autoExecute += 1
    autoExecuteBody = route.request().postData() ?? ''
    const finalOutputSpec = JSON.parse(readMultipartField(autoExecuteBody, 'finalOutputSpec')) as Record<string, unknown>
    expect(finalOutputSpec).toMatchObject({ width: 870, height: 220, fit: 'cover', position: 'center' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: createStrictPipeline('生成一张 870×220 的夏日咖啡横幅', hashComposerSnapshot(autoExecuteBody)),
      }),
    })
  })
  await page.route('**/agent-api/v1/plans/**/execute', async (route) => {
    legacyExecuteRequests += 1
    await route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"v3 严格回合不得调用旧确认执行端点"}' })
  })
  await page.route(`**/agent-api/v1/executions/${EXECUTION_ID}/events`, async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })
  await page.route(`**/agent-api/v1/executions/${EXECUTION_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: createStrictPipeline('生成一张 870×220 的夏日咖啡横幅', hashComposerSnapshot(autoExecuteBody)).execution }),
    })
  })

  await gotoAgent(page)
  await submitAgentTurn(page, '生成一张 870×220 的夏日咖啡横幅')

  await expect.poll(() => counters.autoExecute).toBe(1)
  await expect(page.getByRole('heading', { name: '严格尺寸执行计划', exact: true })).toBeVisible()
  await expect(page.locator('[data-agent-plan-card]:visible')).toContainText(/870\s*[×x]\s*220/)
  expect(autoExecuteBody).toContain('name="finalOutputSpec"')
  expect(counters.responsesRelay).toBe(0)
  expect(counters.directResponses).toBe(0)
  expect(legacyExecuteRequests).toBe(0)
  await expectNoModeOrConfirmationControls(page)
})

test('Gateway 缺失时严格回合明确失败，且不回退到 Responses', async ({ page }) => {
  const counters: RequestCounters = { responsesRelay: 0, autoExecute: 0, directResponses: 0 }
  await installRuntimeFixture(page, { gatewayEnabled: false, agentOnly: false })
  await page.route('**/agent-api/v1/responses/image', async (route) => {
    counters.responsesRelay += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"严格回合不得调用 Responses relay"}' })
  })
  await page.route('**/agent-api/v1/plans/auto-execute', async (route) => {
    counters.autoExecute += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Gateway 已缺失"}' })
  })
  await page.route('**/api-proxy/**', async (route) => {
    counters.directResponses += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"严格回合不得回退到代理 Responses"}' })
  })

  await gotoAgent(page)
  await submitAgentTurn(page, '生成一张 870×220 的夏日咖啡横幅')

  const latestTurn = page.locator('[data-agent-conversation-turn]').last()
  await expect(latestTurn).toContainText('严格图片规格需要 Tool Pipeline')
  await expect(latestTurn).toContainText('不会改用近似的 Responses 生成')
  expect(counters.responsesRelay).toBe(0)
  expect(counters.autoExecute).toBe(0)
  expect(counters.directResponses).toBe(0)
})

test('Responses 不可用时整个 Agent 阻断，即使 Tool Pipeline 已配置', async ({ page }) => {
  await installRuntimeFixture(page, { responsesEnabled: false, gatewayEnabled: true, agentOnly: true })

  await gotoAgent(page)
  await expect(page.getByRole('heading', { name: 'Agent 当前不可用', exact: true })).toBeVisible()
  await expect(page.getByText('Responses 服务不可用，Tool Pipeline 不会单独启用。请先恢复 Responses 服务后再试。')).toBeVisible()
  await expect(composer(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0)
})
