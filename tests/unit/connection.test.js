'use strict'

const cds = require('@sap/cds')
const { resolveN8nConnection } = require('../../lib/api/connection')

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
    expect(c.headers).toEqual({ 'X-N8N-API-KEY': 'env-key' })
  })

  it('resolves env vars when no credentials configured', async () => {
    cds.env.requires[SVC] = {}
    process.env.N8N_BASE_URL = 'https://from-plain-env.example.com'
    process.env.N8N_API_KEY = 'plain-env-key'
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe('https://from-plain-env.example.com')
    expect(c.headers).toEqual({ 'X-N8N-API-KEY': 'plain-env-key' })
  })

  it('falls back to localhost:5678 in development profile', async () => {
    cds.env.requires[SVC] = {}
    setProfiles(['development'])
    process.env.NODE_ENV = 'development'
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe('http://localhost:5678')
    expect(c.headers).toEqual({})
  })

  it('throws when no config resolves and not in development', async () => {
    cds.env.requires[SVC] = {}
    setProfiles(['production'])
    process.env.NODE_ENV = 'production'
    await expect(resolveN8nConnection(SVC)).rejects.toThrow(/no credentials/i)
  })
})
