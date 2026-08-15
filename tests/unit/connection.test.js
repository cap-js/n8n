const cds = require("@sap/cds")
const { resolveN8nConnection, resolveUseTestWebhook } = require("../../lib/api/connection")

const SVC = "n8n"

describe("resolveN8nConnection", () => {
  let originalEnv
  let originalRequires

  beforeEach(() => {
    originalEnv = { ...process.env }
    originalRequires = cds.env.requires
    cds.env.requires = { ...(cds.env.requires ?? {}) }
    delete process.env.N8N_BASE_URL
    delete process.env.N8N_API_KEY
    delete process.env.N8N_USE_TEST_WEBHOOK
  })

  afterEach(() => {
    process.env = originalEnv
    cds.env.requires = originalRequires
  })

  it("resolves inline credentials (highest precedence after destinations)", async () => {
    cds.env.requires[SVC] = {
      credentials: { url: "https://n8n.example.com", apiKey: "top-secret" },
    }
    const c = await resolveN8nConnection()
    expect(c.baseUrl).toBe("https://n8n.example.com")
    expect(c.apiKey).toBe("top-secret")
    expect(c.authHeaders).toEqual({})
    expect(c.useTestWebhook).toBe(false)
  })

  it("falls through to N8N_API_KEY when credentials only supply the url", async () => {
    cds.env.requires[SVC] = {
      credentials: { url: "https://n8n.example.com" },
    }
    process.env.N8N_API_KEY = "env-key"
    const c = await resolveN8nConnection()
    expect(c.apiKey).toBe("env-key")
  })

  it("resolves env vars when no credentials are configured", async () => {
    cds.env.requires[SVC] = {}
    process.env.N8N_BASE_URL = "https://from-plain-env.example.com"
    process.env.N8N_API_KEY = "plain-env-key"
    const c = await resolveN8nConnection()
    expect(c.baseUrl).toBe("https://from-plain-env.example.com")
    expect(c.apiKey).toBe("plain-env-key")
  })

  it("throws when no configuration resolves", async () => {
    cds.env.requires[SVC] = {}
    await expect(resolveN8nConnection()).rejects.toThrow(/no credentials/i)
  })

  it("defaults useTestWebhook to false when N8N_USE_TEST_WEBHOOK is unset", async () => {
    cds.env.requires[SVC] = {
      credentials: { url: "https://n8n.example.com" },
    }
    const c = await resolveN8nConnection()
    expect(c.useTestWebhook).toBe(false)
  })

  it("honours credentials.useTestWebhook when explicitly set", async () => {
    cds.env.requires[SVC] = {
      credentials: { url: "https://n8n.example.com", useTestWebhook: true },
    }
    const c = await resolveN8nConnection()
    expect(c.useTestWebhook).toBe(true)
  })

  it("enables useTestWebhook when N8N_USE_TEST_WEBHOOK is set", async () => {
    cds.env.requires[SVC] = {
      credentials: { url: "https://n8n.example.com" },
    }
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    const c = await resolveN8nConnection()
    expect(c.useTestWebhook).toBe(true)
  })

  describe("destination-based resolution", () => {
    it("uses the destination even when a leftover url is present in credentials", async () => {
      // Simulate a hybrid setup where an inline `url` lingers alongside a
      // user-configured destination — destination must win.
      cds.env.requires[SVC] = {
        credentials: {
          url: "http://localhost:5678",
          destination: "managed-n8n",
        },
      }

      // Monkey-patch the destination module for this test only.
      const destModule = require("../../lib/auth/destination")
      const original = destModule.resolveDestination
      destModule.resolveDestination = async (name) => ({
        url: `https://managed.example.com/api/${name}`,
        originalProperties: {
          destinationConfiguration: {
            "URL.headers.X-N8N-API-KEY": "key-from-destination",
          },
        },
        authHeaders: { Authorization: "Bearer outer-token" },
      })

      try {
        // Re-require the connection module so it picks up the patched destination.
        delete require.cache[require.resolve("../../lib/api/connection")]
        const { resolveN8nConnection: fresh } = require("../../lib/api/connection")
        const c = await fresh()
        expect(c.baseUrl).toBe("https://managed.example.com/api/managed-n8n")
        expect(c.apiKey).toBe("key-from-destination")
        expect(c.authHeaders).toEqual({ Authorization: "Bearer outer-token" })
      } finally {
        destModule.resolveDestination = original
        delete require.cache[require.resolve("../../lib/api/connection")]
      }
    })
  })
})

describe("resolveUseTestWebhook", () => {
  let originalEnv
  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.N8N_USE_TEST_WEBHOOK
  })
  afterEach(() => {
    process.env = originalEnv
  })

  it("returns false by default", () => {
    expect(resolveUseTestWebhook({})).toBe(false)
  })

  it("honours credentials.useTestWebhook (Boolean coercion)", () => {
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: true } })).toBe(true)
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: false } })).toBe(false)
  })

  it("falls back to N8N_USE_TEST_WEBHOOK when credentials omit the flag", () => {
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    expect(resolveUseTestWebhook({})).toBe(true)
  })

  it("lets credentials override the env var", () => {
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: false } })).toBe(false)
  })

  it("honours the destination-provided flag with highest precedence", () => {
    const dest = { originalProperties: { "URL.useTestWebhook": "true" } }
    expect(resolveUseTestWebhook({}, dest)).toBe(true)
  })

  it("destination wins over credentials and env", () => {
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    const dest = { originalProperties: { "URL.useTestWebhook": "" } }
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: true } }, dest)).toBe(false)
  })
})
