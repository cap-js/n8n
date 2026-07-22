'use strict'

const {
  buildWebhookUrl,
  normalizeWebhookPath,
  createN8nClient,
  redactSecrets,
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
  it('rejects absolute URLs (SSRF hardening)', () => {
    expect(() => normalizeWebhookPath('https://x.y/webhook/my-hook')).toThrow(/relative path/i)
    expect(() => normalizeWebhookPath('http://internal/x')).toThrow(/relative path/i)
  })
  it('rejects protocol-relative URLs', () => {
    expect(() => normalizeWebhookPath('//evil.example/x')).toThrow(/relative path/i)
  })
  it('rejects newline characters', () => {
    expect(() => normalizeWebhookPath('my-hook\r\nInjected: header')).toThrow(/newline/i)
  })
  it('rejects ".." path segments', () => {
    expect(() => normalizeWebhookPath('../api/v1/workflows')).toThrow(/\.\./)
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
  it('rejects absolute workflow values (SSRF)', () => {
    expect(() =>
      buildWebhookUrl('http://ignored', 'https://cloud.n8n.io/webhook/x'),
    ).toThrow(/relative path/i)
  })
  it('uses /webhook-test prefix when useTestWebhook is true', () => {
    expect(
      buildWebhookUrl('http://localhost:5678', 'book-created', { useTestWebhook: true }),
    ).toBe('http://localhost:5678/webhook-test/book-created')
  })
  it('uses /webhook prefix when useTestWebhook is false or omitted', () => {
    expect(
      buildWebhookUrl('http://localhost:5678', 'book-created', { useTestWebhook: false }),
    ).toBe('http://localhost:5678/webhook/book-created')
    expect(buildWebhookUrl('http://localhost:5678', 'book-created', {})).toBe(
      'http://localhost:5678/webhook/book-created',
    )
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
      apiKey: undefined,
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
      apiKey: undefined,
      timeout: { connect: 100, read: 100 },
    }))

    const res = await client.trigger('wf', { x: 1 })
    expect(res.ok).toBe(true)
    expect(res.executionId).toBe('e-1')
  })
})

describe('createN8nClient — retryable error marking', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function buildClient() {
    return createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: undefined,
      timeout: { connect: 100, read: 100 },
    }))
  }

  it('marks HTTP 4xx as non-retryable', async () => {
    globalThis.fetch = async () =>
      new Response('bad workflow', { status: 404, statusText: 'Not Found' })

    let caught
    try {
      await buildClient().trigger('missing', {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.retryable).toBe(false)
  })

  it('marks HTTP 5xx as non-retryable', async () => {
    globalThis.fetch = async () =>
      new Response('boom', { status: 500, statusText: 'Server Error' })

    let caught
    try {
      await buildClient().trigger('wf', {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.retryable).toBe(false)
  })

  it('marks network failures as retryable', async () => {
    globalThis.fetch = async () => {
      const err = new TypeError('fetch failed')
      err.cause = new Error('ECONNREFUSED')
      throw err
    }

    let caught
    try {
      await buildClient().trigger('wf', {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.retryable).toBe(true)
  })

  it('marks abort/timeout errors as retryable', async () => {
    globalThis.fetch = (url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })

    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: undefined,
      timeout: { connect: 5, read: 5 },
    }))

    let caught
    try {
      await client.trigger('wf', {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.retryable).toBe(true)
  })

  it('marks HTTP errors on getExecution as non-retryable', async () => {
    globalThis.fetch = async () =>
      new Response('nope', { status: 401, statusText: 'Unauthorized' })

    let caught
    try {
      await buildClient().getExecution('e-1')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.retryable).toBe(false)
  })
})

describe('createN8nClient — auth headers', () => {
  let captured
  let originalFetch
  beforeEach(() => {
    captured = []
    originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      captured.push({ url, options })
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends both X-N8N-API-KEY and X-Webhook-Secret on webhook POSTs', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: 'top-secret',
      timeout: { connect: 50, read: 50 },
    }))
    await client.trigger('wf', {})
    expect(captured).toHaveLength(1)
    expect(captured[0].options.headers).toMatchObject({
      'X-N8N-API-KEY': 'top-secret',
      'X-Webhook-Secret': 'top-secret',
    })
  })

  it('omits auth headers on webhook POSTs when no api key is configured', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: undefined,
      timeout: { connect: 50, read: 50 },
    }))
    await client.trigger('wf', {})
    expect(captured[0].options.headers).not.toHaveProperty('X-N8N-API-KEY')
    expect(captured[0].options.headers).not.toHaveProperty('X-Webhook-Secret')
  })

  it('sends only X-N8N-API-KEY on executions API calls', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: 'top-secret',
      timeout: { connect: 50, read: 50 },
    }))
    await client.getExecution('e-1')
    expect(captured[0].options.headers).toMatchObject({ 'X-N8N-API-KEY': 'top-secret' })
    expect(captured[0].options.headers).not.toHaveProperty('X-Webhook-Secret')
  })

  it('merges destination authHeaders under the n8n-specific headers on webhook POSTs', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: 'top-secret',
      authHeaders: { Authorization: 'Bearer outer-token' },
      timeout: { connect: 50, read: 50 },
    }))
    await client.trigger('wf', {})
    expect(captured[0].options.headers).toMatchObject({
      'Authorization': 'Bearer outer-token',
      'X-N8N-API-KEY': 'top-secret',
      'X-Webhook-Secret': 'top-secret',
    })
  })

  it('merges destination authHeaders on executions API calls', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: 'top-secret',
      authHeaders: { Authorization: 'Bearer outer-token' },
      timeout: { connect: 50, read: 50 },
    }))
    await client.getExecution('e-1')
    expect(captured[0].options.headers).toMatchObject({
      'Authorization': 'Bearer outer-token',
      'X-N8N-API-KEY': 'top-secret',
    })
  })

  it('X-N8N-API-KEY wins over an incoming X-N8N-API-KEY from authHeaders', async () => {
    // Ensures a destination custom header cannot silently replace the api key
    // the plugin already resolved. Applies to webhook trigger POSTs.
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: 'plugin-resolved-key',
      authHeaders: { 'X-N8N-API-KEY': 'stale-header-key' },
      timeout: { connect: 50, read: 50 },
    }))
    await client.trigger('wf', {})
    expect(captured[0].options.headers['X-N8N-API-KEY']).toBe('plugin-resolved-key')
  })
})

describe('createN8nClient — test webhook flag', () => {
  let captured
  let originalFetch
  beforeEach(() => {
    captured = []
    originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      captured.push({ url, options })
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('routes to /webhook when useTestWebhook is absent', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: undefined,
      timeout: { connect: 50, read: 50 },
    }))
    await client.trigger('book-created', {})
    expect(captured[0].url).toBe('http://localhost:5678/webhook/book-created')
  })

  it('routes to /webhook-test when useTestWebhook is true', async () => {
    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: undefined,
      timeout: { connect: 50, read: 50 },
      useTestWebhook: true,
    }))
    await client.trigger('book-created', {})
    expect(captured[0].url).toBe('http://localhost:5678/webhook-test/book-created')
  })
})

describe('redactSecrets', () => {
  it('redacts X-N8N-API-KEY values', () => {
    const body = '{"received":{"X-N8N-API-KEY":"eyJabc"}}'
    expect(redactSecrets(body)).not.toContain('eyJabc')
    expect(redactSecrets(body)).toMatch(/\[REDACTED\]/)
  })
  it('redacts Authorization values case-insensitively', () => {
    const body = 'authorization: Bearer secret-token-123'
    expect(redactSecrets(body)).not.toContain('secret-token-123')
  })
  it('redacts X-Webhook-Secret values', () => {
    const body = '"x-webhook-secret":"whs_xyz"'
    expect(redactSecrets(body)).not.toContain('whs_xyz')
  })
  it('returns empty string for null/undefined/empty input', () => {
    expect(redactSecrets('')).toBe('')
    expect(redactSecrets(null)).toBe('')
    expect(redactSecrets(undefined)).toBe('')
  })
})

describe('createN8nClient — error body sanitisation', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('redacts credentials echoed back in a 4xx response body', async () => {
    globalThis.fetch = async () =>
      new Response('{"received":{"X-N8N-API-KEY":"top-secret-echoed"}}', {
        status: 400,
        statusText: 'Bad Request',
      })

    const client = createN8nClient(async () => ({
      baseUrl: 'http://localhost:5678',
      apiKey: 'top-secret-echoed',
      timeout: { connect: 50, read: 50 },
    }))

    let caught
    try {
      await client.trigger('wf', {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.message).not.toContain('top-secret-echoed')
    expect(caught.message).toMatch(/\[REDACTED\]/)
  })
})
