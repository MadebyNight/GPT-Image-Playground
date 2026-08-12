import { expect, test, type Page } from '@playwright/test'

const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
const CONVERSATION_ID = 'responsive-message-flow'
const LAYOUT_PREFERENCE_KEY = 'gpt-image-playground:agent-layout-preferences'

const DESKTOP_VIEWPORTS = [
  { name: '1920×1080', width: 1920, height: 1080 },
  { name: '1366×768', width: 1366, height: 768 },
] as const

const MOBILE_VIEWPORTS = [
  { name: '1024×768', width: 1024, height: 768 },
  { name: '390×844', width: 390, height: 844 },
] as const

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const isInline = url.protocol === 'data:' || url.protocol === 'blob:'
    const isLocal = (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')

    if (isInline || isLocal) {
      await route.continue()
      return
    }

    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/runtime-config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        serverApi: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-5.5',
          apiMode: 'responses',
          modelOptions: ['gpt-5.5'],
          apiModeOptions: ['responses'],
          allowCustomModel: true,
          codexCli: false,
          responseFormatB64Json: false,
          timeoutSeconds: 60,
          proxyPath: '/api-proxy',
        },
      }),
    })
  })

  await page.route('**/api-proxy/**', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"E2E 禁止真实 API"}' })
  })

  await page.addInitScript(({ preferenceKey }) => {
    window.localStorage.removeItem(preferenceKey)
  }, { preferenceKey: LAYOUT_PREFERENCE_KEY })
})

async function seedAgentConversation(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('tablist', { name: '工作区模式' })).toBeVisible()

  await page.evaluate(async ({ conversationId, imageDataUrl }) => {
    const [{ useStore }, { putImage, putImageThumbnail, putTask }, { DEFAULT_PARAMS }] = await Promise.all([
      import('/src/store.ts'),
      import('/src/lib/db.ts'),
      import('/src/types.ts'),
    ])
    const now = Date.now()
    const imageIds = ['responsive-image-a', 'responsive-image-b']
    const tasks = Array.from({ length: 8 }, (_, index) => {
      const turn = index + 1
      const isLatest = turn === 8
      return {
        id: `responsive-turn-${turn}`,
        prompt: `第 ${turn} 轮用户请求：${'请保持构图一致并继续完善细节。'.repeat(4)}`,
        params: { ...DEFAULT_PARAMS },
        apiProvider: 'openai',
        apiModel: 'gpt-5.5',
        inputImageIds: [],
        outputImages: isLatest ? imageIds : [],
        status: 'done' as const,
        error: null,
        createdAt: now - (8 - turn) * 1_000,
        finishedAt: now - (8 - turn) * 1_000 + 600,
        elapsed: 600,
        origin: 'agent' as const,
        agentConversationId: conversationId,
        agentTurn: turn,
        agentAssistantText: `第 ${turn} 轮 Agent 回复：${'已完成当前调整，并保留前一轮的视觉语言与层级关系。'.repeat(8)}`,
      }
    })

    for (const imageId of imageIds) {
      await putImage({
        id: imageId,
        dataUrl: imageDataUrl,
        createdAt: now,
        source: 'generated',
        width: 1,
        height: 1,
      })
      await putImageThumbnail({
        id: imageId,
        thumbnailDataUrl: imageDataUrl,
        width: 1,
        height: 1,
        thumbnailVersion: 2,
      })
    }
    await Promise.all(tasks.map((task) => putTask(task)))
    useStore.getState().setTasks(tasks)
  }, { conversationId: CONVERSATION_ID, imageDataUrl: IMAGE_DATA_URL })

  await page.getByRole('tab', { name: 'Agent', exact: true }).click()
  await expect(page.locator('[data-agent-workspace-mounted]')).toBeVisible()
  const visibleStream = page.locator('[data-agent-conversation-stream]:visible')
  await expect(visibleStream.locator('[data-agent-conversation-turn]')).toHaveCount(8)
  await expect(visibleStream.locator('[data-agent-image-preview] img')).toHaveCount(2)
}

async function expectEmbeddedComposerAndLatestMessage(page: Page) {
  const composer = page.locator('[data-input-bar-presentation="embedded"]:visible')
  const scrollRegion = page.locator('[data-agent-conversation-scroll-region]:visible')
  const latestTurn = page.locator('[data-agent-conversation-stream]:visible [data-agent-conversation-turn]').last()

  await expect(composer).toBeVisible()
  await expect(latestTurn).toBeVisible()
  await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).position)).not.toBe('fixed')

  const [composerRect, scrollRect, latestRect] = await Promise.all([
    composer.boundingBox(),
    scrollRegion.boundingBox(),
    latestTurn.boundingBox(),
  ])
  expect(composerRect).not.toBeNull()
  expect(scrollRect).not.toBeNull()
  expect(latestRect).not.toBeNull()
  const geometry = {
    composerTop: composerRect!.y,
    scrollTop: scrollRect!.y,
    scrollBottom: scrollRect!.y + scrollRect!.height,
    latestTop: latestRect!.y,
    latestBottom: latestRect!.y + latestRect!.height,
  }

  expect(geometry.latestBottom).toBeLessThanOrEqual(geometry.composerTop + 1)
  expect(geometry.latestBottom).toBeLessThanOrEqual(geometry.scrollBottom + 1)
  expect(geometry.latestBottom).toBeGreaterThan(geometry.scrollTop)
  expect(geometry.latestTop).toBeLessThan(geometry.scrollBottom)
}

for (const viewport of DESKTOP_VIEWPORTS) {
  test(`${viewport.name} 桌面侧栏按 240/48/320 规则工作且模板覆盖不挤压消息列`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await seedAgentConversation(page)

    const layout = page.locator('[data-agent-desktop-layout]')
    const historyColumn = layout.locator(':scope > div').nth(0)
    const centralColumn = layout.locator(':scope > div').nth(1)
    const templateRail = layout.locator(':scope > div').nth(2)

    await expect(layout).toBeVisible()
    await expect(layout).toHaveAttribute('data-agent-history-expanded', 'true')
    await expect(layout).toHaveAttribute('data-agent-template-expanded', 'false')
    await expect(historyColumn).toHaveCSS('width', '240px')
    await expect(templateRail).toHaveCSS('width', '48px')

    const expandedCenterBox = await centralColumn.boundingBox()
    expect(expandedCenterBox).not.toBeNull()

    await page.getByTitle('收起历史记录').click()
    await expect(layout).toHaveAttribute('data-agent-history-expanded', 'false')
    await expect(historyColumn).toHaveCSS('width', '48px')
    const collapsedCenterBox = await centralColumn.boundingBox()
    expect(collapsedCenterBox).not.toBeNull()
    expect(collapsedCenterBox!.width).toBeGreaterThan(expandedCenterBox!.width + 190)

    const centerBeforeTemplate = await centralColumn.boundingBox()
    await layout.getByRole('button', { name: '打开灵感模板' }).click()
    await expect(layout).toHaveAttribute('data-agent-template-expanded', 'true')
    const templateOverlay = page.locator('#agent-desktop-templates')
    await expect(templateOverlay).toBeVisible()
    await expect(templateOverlay).toHaveCSS('width', '320px')

    const centerAfterTemplate = await centralColumn.boundingBox()
    const overlayBox = await templateOverlay.boundingBox()
    expect(centerAfterTemplate).not.toBeNull()
    expect(overlayBox).not.toBeNull()
    expect(Math.abs(centerAfterTemplate!.width - centerBeforeTemplate!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(centerAfterTemplate!.x - centerBeforeTemplate!.x)).toBeLessThanOrEqual(1)
    expect(overlayBox!.x).toBeLessThan(centerAfterTemplate!.x + centerAfterTemplate!.width)

    await expectEmbeddedComposerAndLatestMessage(page)
  })
}

for (const viewport of MOBILE_VIEWPORTS) {
  test(`${viewport.name} 使用覆盖抽屉，Escape 关闭后焦点归还触发器`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await seedAgentConversation(page)

    await expect(page.locator('[data-agent-desktop-layout]')).toBeHidden()
    const historyTrigger = page.locator('[data-agent-mobile-drawer-trigger="history"]')
    const templateTrigger = page.locator('[data-agent-mobile-drawer-trigger="templates"]')

    await historyTrigger.click()
    const historyDrawer = page.locator('[data-agent-mobile-drawer="history"]')
    const historyDialog = historyDrawer.getByRole('dialog', { name: '历史记录' })
    await expect(historyDialog).toBeVisible()
    await expect(historyDialog.getByRole('button', { name: '关闭侧栏' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(historyDrawer).toHaveCount(0)
    await expect(historyTrigger).toBeFocused()

    await templateTrigger.click()
    const templateDrawer = page.locator('[data-agent-mobile-drawer="templates"]')
    const templateDialog = templateDrawer.getByRole('dialog', { name: '灵感模板' })
    await expect(templateDialog).toBeVisible()
    const drawerWidth = await templateDialog.evaluate((element) => element.getBoundingClientRect().width)
    expect(drawerWidth).toBeLessThan(viewport.width)
    await expect(templateDialog.getByRole('button', { name: '关闭侧栏' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(templateDrawer).toHaveCount(0)
    await expect(templateTrigger).toBeFocused()

    await expectEmbeddedComposerAndLatestMessage(page)

    const visibleStream = page.locator('[data-agent-conversation-stream]:visible')
    const previews = visibleStream.locator('[data-agent-image-preview]')
    const previewImages = previews.locator('img')
    await expect(previews).toHaveCount(2)
    for (let index = 0; index < 2; index += 1) {
      const box = await previews.nth(index).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeLessThanOrEqual(160)
      expect(box!.height).toBeLessThanOrEqual(160)
      await expect(previewImages.nth(index)).toHaveCSS('object-fit', 'contain')
    }

    const actionRow = visibleStream.locator('[data-task-action-row="agent"]').last()
    await expect(actionRow).toHaveCSS('flex-wrap', 'wrap')
    const actionLayout = await actionRow.evaluate((element) => {
      const buttons = Array.from(element.querySelectorAll('button'))
      return {
        fitsContainer: element.scrollWidth <= element.clientWidth + 1,
        rowCount: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
      }
    })
    expect(actionLayout.fitsContainer).toBe(true)
    if (viewport.width === 390) expect(actionLayout.rowCount).toBeGreaterThan(1)

    await previews.first().click()
    const lightbox = page.locator('[data-lightbox-root]')
    await expect(lightbox).toBeVisible()
    await expect(lightbox.locator('img[data-image-id="responsive-image-a"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(lightbox).toHaveCount(0)
  })
}

test('深色与 reduced-motion 下消息流保持可读，并关闭回到底部动画', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await seedAgentConversation(page)

  await expect.poll(() => page.evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))).toEqual({ dark: true, reduce: true })

  const centralColumn = page.locator('[data-agent-desktop-layout] > div').nth(1)
  const darkChannels = await centralColumn.evaluate((element) => {
    const match = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)
    return match?.slice(0, 3).map(Number) ?? []
  })
  expect(darkChannels).toHaveLength(3)
  expect(Math.max(...darkChannels)).toBeLessThan(64)

  const scrollRegion = page.locator('[data-agent-conversation-scroll-region]:visible')
  await scrollRegion.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const returnButton = page.getByRole('button', { name: '回到底部' })
  await expect(returnButton).toBeVisible()
  await expect(returnButton).toHaveCSS('transition-property', 'none')
  await returnButton.click()
  await expect.poll(() => scrollRegion.evaluate((element) => (
    element.scrollHeight - element.clientHeight - element.scrollTop
  ))).toBeLessThanOrEqual(1)
})
