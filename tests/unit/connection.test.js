const cds = require("@sap/cds")
const {
  resolveN8nConnection,
  resolveTimeouts,
  resolveUseTestWebhook,
} = require("../../lib/api/connection")
const { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS } = require("../../lib/constants")

const SVC = "N8nService"

// cds.env.profiles is a getter - override via defineProperty so we can control
// which profile is active during a test.
function setProfiles(profiles) {
  Object.defineProperty(cds.env, "profiles", {
    configurable: true,
    get: () => profiles,
  })
}
function restoreProfiles(descriptor) {
  Object.defineProperty(cds.env, "profiles", descriptor)
}

describe("resolveN8nConnection", () => {
  let originalEnv
  let originalRequires
  let originalProfilesDescriptor

  beforeEach(() => {
    originalEnv = { ...process.env }
    originalRequires = cds.env.requires
    originalProfilesDescriptor = Object.getOwnPropertyDescriptor(cds.env, "profiles")
    cds.env.requires = { ...(cds.env.requires ?? {}) }
    delete process.env.N8N_BASE_URL
    delete process.env.N8N_API_KEY
    delete process.env.N8N_CONNECT_TIMEOUT_MS
    delete process.env.N8N_READ_TIMEOUT_MS
    delete process.env.N8N_USE_TEST_WEBHOOK
  })

  afterEach(() => {
    process.env = originalEnv
    cds.env.requires = originalRequires
    if (originalProfilesDescriptor) {
      restoreProfiles(originalProfilesDescriptor)
    }
  })

  it("resolves inline credentials (highest precedence)", async () => {
    cds.env.requires[SVC] = {
      credentials: { baseUrl: "https://n8n.example.com", apiKey: "top-secret" },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe("https://n8n.example.com")
    expect(c.apiKey).toBe("top-secret")
    // Legacy `headers` field is preserved for backward compatibility.
    expect(c.headers).toEqual({ "X-N8N-API-KEY": "top-secret" })
  })

  it("resolves env vars when no credentials configured", async () => {
    cds.env.requires[SVC] = {}
    process.env.N8N_BASE_URL = "https://from-plain-env.example.com"
    process.env.N8N_API_KEY = "plain-env-key"
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe("https://from-plain-env.example.com")
    expect(c.apiKey).toBe("plain-env-key")
  })

  it("falls back to localhost:5678 in development profile", async () => {
    cds.env.requires[SVC] = {}
    setProfiles(["development"])
    process.env.NODE_ENV = "development"
    const c = await resolveN8nConnection(SVC)
    expect(c.baseUrl).toBe("http://localhost:5678")
    expect(c.apiKey).toBeUndefined()
  })

  it("throws when no config resolves and not in development", async () => {
    cds.env.requires[SVC] = {}
    setProfiles(["production"])
    process.env.NODE_ENV = "production"
    await expect(resolveN8nConnection(SVC)).rejects.toThrow(/no credentials/i)
  })

  it("includes default timeouts in the resolved connection", async () => {
    cds.env.requires[SVC] = {
      credentials: { baseUrl: "https://n8n.example.com" },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.timeout).toEqual({
      connect: DEFAULT_CONNECT_TIMEOUT_MS,
      read: DEFAULT_READ_TIMEOUT_MS,
    })
  })

  it("defaults useTestWebhook to false", async () => {
    cds.env.requires[SVC] = {
      credentials: { baseUrl: "https://n8n.example.com" },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.useTestWebhook).toBe(false)
  })

  it("honours credentials.useTestWebhook when explicitly true", async () => {
    cds.env.requires[SVC] = {
      credentials: {
        baseUrl: "https://n8n.example.com",
        useTestWebhook: true,
      },
    }
    const c = await resolveN8nConnection(SVC)
    expect(c.useTestWebhook).toBe(true)
  })

  it("honours the N8N_USE_TEST_WEBHOOK env var when credentials omit the flag", async () => {
    cds.env.requires[SVC] = {
      credentials: { baseUrl: "https://n8n.example.com" },
    }
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    const c = await resolveN8nConnection(SVC)
    expect(c.useTestWebhook).toBe(true)
  })

  describe("destination-based resolution", () => {
    it("uses the destination even when a leftover baseUrl is present in credentials", async () => {
      // Simulate the plugin's own [development] default polluting credentials
      // alongside a user-configured destination - destination must win.
      cds.env.requires[SVC] = {
        credentials: {
          baseUrl: "http://localhost:5678",
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
        const c = await fresh(SVC)
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

describe("resolveTimeouts", () => {
  let originalEnv
  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.N8N_CONNECT_TIMEOUT_MS
    delete process.env.N8N_READ_TIMEOUT_MS
  })
  afterEach(() => {
    process.env = originalEnv
  })

  it("returns defaults when nothing is configured", () => {
    expect(resolveTimeouts({})).toEqual({
      connect: DEFAULT_CONNECT_TIMEOUT_MS,
      read: DEFAULT_READ_TIMEOUT_MS,
    })
  })

  it("honours credentials.timeout over defaults", () => {
    const r = resolveTimeouts({
      credentials: { timeout: { connect: 500, read: 2500 } },
    })
    expect(r).toEqual({ connect: 500, read: 2500 })
  })

  it("honours env vars when credentials do not specify timeouts", () => {
    process.env.N8N_CONNECT_TIMEOUT_MS = "1500"
    process.env.N8N_READ_TIMEOUT_MS = "4500"
    expect(resolveTimeouts({})).toEqual({ connect: 1500, read: 4500 })
  })

  it("gives credentials precedence over env vars", () => {
    process.env.N8N_CONNECT_TIMEOUT_MS = "1500"
    process.env.N8N_READ_TIMEOUT_MS = "4500"
    const r = resolveTimeouts({
      credentials: { timeout: { connect: 100, read: 200 } },
    })
    expect(r).toEqual({ connect: 100, read: 200 })
  })

  it("ignores negative or non-numeric values and falls through to defaults", () => {
    const r = resolveTimeouts({
      credentials: { timeout: { connect: "nope", read: -1 } },
    })
    expect(r).toEqual({
      connect: DEFAULT_CONNECT_TIMEOUT_MS,
      read: DEFAULT_READ_TIMEOUT_MS,
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

  it("honours credentials.useTestWebhook set to true", () => {
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: true } })).toBe(true)
  })

  it("accepts string forms in credentials.useTestWebhook", () => {
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: "true" } })).toBe(true)
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: "1" } })).toBe(true)
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: "false" } })).toBe(false)
  })

  it("falls back to N8N_USE_TEST_WEBHOOK env var when credentials omit the flag", () => {
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    expect(resolveUseTestWebhook({})).toBe(true)
  })

  it("lets credentials override the env var", () => {
    process.env.N8N_USE_TEST_WEBHOOK = "true"
    expect(resolveUseTestWebhook({ credentials: { useTestWebhook: false } })).toBe(false)
  })

  it("honours the destination-provided flag when nothing else specifies it", () => {
    const dest = { originalProperties: { "URL.useTestWebhook": "true" } }
    expect(resolveUseTestWebhook({}, dest)).toBe(true)
  })
})
