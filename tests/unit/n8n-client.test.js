'use strict'

const {
  buildWebhookUrl,
  normalizeWebhookPath,
  createN8nClient,
} = require('../../lib/api/n8n-client')

describe('normalizeWebhookPath', () => {
  it('strips leading slashes', () => {
    expect(normalizeWebhookPath('/my-hook')).toBe('my-hook')
  })
  it('strips webhook/ prefix', () => {
    expect(normalizeWebhookPath('webhook/my-hook')).toBe('my-hook')
  })
  it('preserves webhook-test/… prefix (n8n test URLs)', () => {
    expect(normalizeWebhookPath('webhook-test/my-hook')).toBe('webhook-test/my-hook')
  })
  it('returns absolute URLs unchanged', () => {
    expect(normalizeWebhookPath('https://x.y/webhook/my-hook')).toBe(
      'https://x.y/webhook/my-hook',
    )
  })
})

describe('buildWebhookUrl', () => {
  it('joins base + webhook + path', () => {
    expect(buildWebhookUrl('http://localhost:5678', 'book-created')).toBe(
      'http://localhost:5678/webhook/book-created',
    )
  })
  it('handles trailing slash on base', () => {
    expect(buildWebhookUrl('http://localhost:5678/', 'book-created')).toBe(
      'http://localhost:5678/webhook/book-created',
    )
  })
  it('returns absolute workflow URL unchanged', () => {
    expect(
      buildWebhookUrl('http://ignored', 'https://cloud.n8n.io/webhook/x'),
    ).toBe('https://cloud.n8n.io/webhook/x')
  })
})

describe('createN8nClient — timeouts', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('aborts when the request exceeds the resolved timeout', async () => {
    globalThis.fetch = (url, options) =>
      new Promise((_resolve, reject) => {
        // Never resolves on its own; rely on the caller's abort signal.
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })

    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      headers: {},
      timeout: { connect: 10, read: 10 },
    }))

    await expect(client.trigger('wf', { x: 1 })).rejects.toThrow()
  })

  it('passes through when the response arrives before the deadline', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ executionId: 'e-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      headers: {},
      timeout: { connect: 100, read: 100 },
    }))

    const res = await client.trigger('wf', { x: 1 })
    expect(res.ok).toBe(true)
    expect(res.executionId).toBe('e-1')
  })
})
