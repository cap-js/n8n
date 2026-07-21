'use strict'

const cds = require('@sap/cds')
const { resolveN8nConnection, resolveTimeouts } = require('../../lib/api/connection')
const {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
} = require('../../lib/constants')

const SVC = 'N8nService'

// cds.env.profiles is a getter — override via defineProperty so we can control
// which profile is active during a test.
function setProfiles(profiles) {
  Object.defineProperty(cds.env, 'profiles', {
    configurable: true,
    get: () => profiles,
  })
}
function restoreProfiles(descriptor) {
  Object.defineProperty(cds.env, 'profiles', descriptor)
}

describe('resolveN8nConnection', () => {
  let originalEnv
  let originalRequires
  let originalProfilesDescriptor

  beforeEach(() => {
    originalEnv = { ...process.env }
    originalRequires = cds.env.requires
    originalProfilesDescriptor = Object.getOwnPropertyDescriptor(cds.env, 'profiles')
    cds.env.requires = { ...(cds.env.requires ?? {}) }
    delete process.env.N8N_BASE_URL
    delete process.env.N8N_API_KEY
    delete process.env.N8N_CONNECT_TIMEOUT_MS
    delete process.env.N8N_READ_TIMEOUT_MS
  })

  afterEach(() => {
    process.env = originalEnv
    cds.env.requires = originalRequires
    if (originalProfilesDescriptor) {
      restoreProfiles(originalProfilesDescriptor)
    }
  })

  it('resolves inline credentials (highest precedence)', async () => {
    cds.env.requires[SVC] = {
      credentials: { baseUrl: 'https://n8n.example.com', apiKey: 'top-secret' },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe('https://n8n.example.com')
    expect(c.apiKey).toBe('top-secret')
    // Legacy `headers` field is preserved for backward compatibility.
    expect(c.headers).toEqual({ 'X-N8N-API-KEY': 'top-secret' })
  })

  it('resolves env:VAR indirection in credentials', async () => {
    process.env.MY_N8N_URL = 'https://from-env.example.com'
    process.env.MY_N8N_KEY = 'env-key'
    cds.env.requires[SVC] = {
      credentials: { baseUrl: 'env:MY_N8N_URL', apiKey: 'env:MY_N8N_KEY' },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe('https://from-env.example.com')
    expect(c.apiKey).toBe('env-key')
  })

  it('resolves env vars when no credentials configured', async () => {
    cds.env.requires[SVC] = {}
    process.env.N8N_BASE_URL = 'https://from-plain-env.example.com'
    process.env.N8N_API_KEY = 'plain-env-key'
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe('https://from-plain-env.example.com')
    expect(c.apiKey).toBe('plain-env-key')
  })

  it('falls back to localhost:5678 in development profile', async () => {
    cds.env.requires[SVC] = {}
    setProfiles(['development'])
    process.env.NODE_ENV = 'development'
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe('http://localhost:5678')
    expect(c.apiKey).toBeUndefined()
  })

  it('throws when no config resolves and not in development', async () => {
    cds.env.requires[SVC] = {}
    setProfiles(['production'])
    process.env.NODE_ENV = 'production'
    await expect(resolveN8nConnection(SVC)).rejects.toThrow(/no credentials/i)
  })

  it('includes default timeouts in the resolved connection', async () => {
    cds.env.requires[SVC] = {
      credentials: { baseUrl: 'https://n8n.example.com' },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.timeout).toEqual({
      connect: DEFAULT_CONNECT_TIMEOUT_MS,
      read: DEFAULT_READ_TIMEOUT_MS,
    })
  })
})

describe('resolveTimeouts', () => {
  let originalEnv
  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.N8N_CONNECT_TIMEOUT_MS
    delete process.env.N8N_READ_TIMEOUT_MS
  })
  afterEach(() => {
    process.env = originalEnv
  })

  it('returns defaults when nothing is configured', () => {
    expect(resolveTimeouts({})).toEqual({
      connect: DEFAULT_CONNECT_TIMEOUT_MS,
      read: DEFAULT_READ_TIMEOUT_MS,
    })
  })

  it('honours credentials.timeout over defaults', () => {
    const r = resolveTimeouts({
      credentials: { timeout: { connect: 500, read: 2500 } },
    })
    expect(r).toEqual({ connect: 500, read: 2500 })
  })

  it('honours env vars when credentials do not specify timeouts', () => {
    process.env.N8N_CONNECT_TIMEOUT_MS = '1500'
    process.env.N8N_READ_TIMEOUT_MS = '4500'
    expect(resolveTimeouts({})).toEqual({ connect: 1500, read: 4500 })
  })

  it('gives credentials precedence over env vars', () => {
    process.env.N8N_CONNECT_TIMEOUT_MS = '1500'
    process.env.N8N_READ_TIMEOUT_MS = '4500'
    const r = resolveTimeouts({
      credentials: { timeout: { connect: 100, read: 200 } },
    })
    expect(r).toEqual({ connect: 100, read: 200 })
  })

  it('resolves env:VAR indirection inside credentials.timeout', () => {
    process.env.MY_CONNECT = '250'
    process.env.MY_READ = '750'
    const r = resolveTimeouts({
      credentials: { timeout: { connect: 'env:MY_CONNECT', read: 'env:MY_READ' } },
    })
    expect(r).toEqual({ connect: 250, read: 750 })
  })

  it('ignores negative or non-numeric values and falls through to defaults', () => {
    const r = resolveTimeouts({
      credentials: { timeout: { connect: 'nope', read: -1 } },
    })
    expect(r).toEqual({
      connect: DEFAULT_CONNECT_TIMEOUT_MS,
      read: DEFAULT_READ_TIMEOUT_MS,
    })
  })
})
