const cds = require("@sap/cds")
const destination = require("../../lib/auth/destination")
const { resolveN8nConnection, resolveWebhookAuthHeaders } = require("../../lib/api/connection")

describe("resolveN8nConnection", () => {
  let originalRequires
  let resolveDestinationSpy

  beforeEach(() => {
    originalRequires = cds.env.requires
    cds.env.requires = { ...(cds.env.requires ?? {}) }
    resolveDestinationSpy = vi.spyOn(destination, "resolveDestination")
  })

  afterEach(() => {
    cds.env.requires = originalRequires
    resolveDestinationSpy.mockRestore()
  })

  it("resolves inline credentials (highest precedence after destinations)", async () => {
    cds.env.requires["n8n"] = {
      credentials: { url: "https://n8n.example.com", apiKey: "top-secret" },
    }
    const c = await resolveN8nConnection()
    expect(c.baseUrl).toBe("https://n8n.example.com")
    expect(c.apiKey).toBe("top-secret")
    expect(c.authHeaders).toEqual({})
    expect(c.webhookAuthHeaders).toEqual({})
  })

  it("carries webhookAuth headers through inline credentials", async () => {
    cds.env.requires["n8n"] = {
      credentials: {
        url: "https://n8n.example.com",
        webhookAuth: { type: "basic", username: "u", password: "p" },
      },
    }
    const c = await resolveN8nConnection()
    const expected = Buffer.from("u:p").toString("base64")
    expect(c.webhookAuthHeaders).toEqual({ Authorization: `Basic ${expected}` })
  })

  it("throws when no configuration resolves", async () => {
    cds.env.requires["n8n"] = {}
    await expect(resolveN8nConnection()).rejects.toThrow(/no connection configured/i)
  })

  it("uses the destination even when a leftover url is present in credentials", async () => {
    // URL from resolved destination should be prioritized over credentials.url
    cds.env.requires["n8n"] = {
      credentials: {
        url: "http://localhost:5678",
        destination: "managed-n8n",
      },
    }

    resolveDestinationSpy.mockImplementation(async (name) => ({
      url: `https://managed.example.com/api/${name}`,
      originalProperties: {
        "URL.headers.X-N8N-API-KEY": "key-from-destination",
      },
      authHeaders: { Authorization: "Bearer outer-token" },
    }))

    const c = await resolveN8nConnection()
    expect(resolveDestinationSpy).toHaveBeenCalledWith("managed-n8n")
    expect(c.baseUrl).toBe("https://managed.example.com/api/managed-n8n")
    expect(c.apiKey).toBe("key-from-destination")
    expect(c.authHeaders).toEqual({ Authorization: "Bearer outer-token" })
  })
})

describe("resolveWebhookAuthHeaders", () => {
  let originalCreds

  beforeAll(() => {
    originalCreds = cds.env.requires.n8n.credentials
  })

  afterAll(() => {
    cds.env.requires.n8n.credentials = originalCreds
  })

  const setWebhookAuth = (webhookAuth) => {
    cds.env.requires.n8n.credentials = webhookAuth ? { webhookAuth } : {}
  }

  it("returns an empty object when webhookAuth is unset", () => {
    setWebhookAuth(undefined)
    expect(resolveWebhookAuthHeaders()).toEqual({})
  })

  it("builds a Basic Authorization header", () => {
    setWebhookAuth({ type: "basic", username: "alice", password: "s3cret" })
    const headers = resolveWebhookAuthHeaders()
    const expected = Buffer.from("alice:s3cret").toString("base64")
    expect(headers).toEqual({ Authorization: `Basic ${expected}` })
  })

  it("builds a Bearer Authorization header", () => {
    setWebhookAuth({ type: "bearer", token: "abc.def.ghi" })
    expect(resolveWebhookAuthHeaders()).toEqual({ Authorization: "Bearer abc.def.ghi" })
  })

  it("builds a custom Header Auth entry", () => {
    setWebhookAuth({ type: "header", name: "X-Webhook-Token", value: "42" })
    expect(resolveWebhookAuthHeaders()).toEqual({ "X-Webhook-Token": "42" })
  })

  it("accepts mixed-case type values", () => {
    setWebhookAuth({ type: "Basic", username: "u", password: "p" })
    expect(resolveWebhookAuthHeaders().Authorization).toMatch(/^Basic /)
  })

  it("rejects unknown types with a helpful error", () => {
    setWebhookAuth({ type: "oauth2" })
    expect(() => resolveWebhookAuthHeaders()).toThrow(/unsupported webhookAuth type 'oauth2'/)
  })

  it("rejects basic without username or password", () => {
    setWebhookAuth({ type: "basic", username: "u" })
    expect(() => resolveWebhookAuthHeaders()).toThrow(/requires username and password/)
  })

  it("rejects header without name or value", () => {
    setWebhookAuth({ type: "header", name: "X" })
    expect(() => resolveWebhookAuthHeaders()).toThrow(/requires name and value/)
  })

  it("rejects bearer without token", () => {
    setWebhookAuth({ type: "bearer" })
    expect(() => resolveWebhookAuthHeaders()).toThrow(/requires token/)
  })
})
