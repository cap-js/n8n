const cds = require("@sap/cds")
const destination = require("../../lib/auth/destination")
const {
  resolveN8nConnection,
  resolveWebhookAuthHeaders,
} = require("../../lib/api/connection")

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
  it("returns an empty object when webhookAuth is unset", () => {
    expect(resolveWebhookAuthHeaders({})).toEqual({})
    expect(resolveWebhookAuthHeaders({ credentials: {} })).toEqual({})
  })

  it("builds a Basic Authorization header", () => {
    const headers = resolveWebhookAuthHeaders({
      credentials: { webhookAuth: { type: "basic", username: "alice", password: "s3cret" } },
    })
    const expected = Buffer.from("alice:s3cret").toString("base64")
    expect(headers).toEqual({ Authorization: `Basic ${expected}` })
  })

  it("builds a Bearer Authorization header", () => {
    const headers = resolveWebhookAuthHeaders({
      credentials: { webhookAuth: { type: "bearer", token: "abc.def.ghi" } },
    })
    expect(headers).toEqual({ Authorization: "Bearer abc.def.ghi" })
  })

  it("builds a custom Header Auth entry", () => {
    const headers = resolveWebhookAuthHeaders({
      credentials: { webhookAuth: { type: "header", name: "X-Webhook-Token", value: "42" } },
    })
    expect(headers).toEqual({ "X-Webhook-Token": "42" })
  })

  it("accepts mixed-case type values", () => {
    const headers = resolveWebhookAuthHeaders({
      credentials: { webhookAuth: { type: "Basic", username: "u", password: "p" } },
    })
    expect(headers.Authorization).toMatch(/^Basic /)
  })

  it("rejects unknown types with a helpful error", () => {
    expect(() =>
      resolveWebhookAuthHeaders({ credentials: { webhookAuth: { type: "oauth2" } } }),
    ).toThrow(/unsupported webhookAuth type 'oauth2'/)
  })

  it("rejects basic without username or password", () => {
    expect(() =>
      resolveWebhookAuthHeaders({ credentials: { webhookAuth: { type: "basic", username: "u" } } }),
    ).toThrow(/requires username and password/)
  })

  it("rejects header without name or value", () => {
    expect(() =>
      resolveWebhookAuthHeaders({ credentials: { webhookAuth: { type: "header", name: "X" } } }),
    ).toThrow(/requires name and value/)
  })

  it("rejects bearer without token", () => {
    expect(() =>
      resolveWebhookAuthHeaders({ credentials: { webhookAuth: { type: "bearer" } } }),
    ).toThrow(/requires token/)
  })
})
