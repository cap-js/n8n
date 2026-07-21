'use strict'

const {
  buildWebhookUrl,
  normalizeWebhookPath,
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
