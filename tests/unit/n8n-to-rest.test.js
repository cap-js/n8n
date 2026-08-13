const N8nService = require("../../srv/n8n-to-rest")
const { assertPathSafe } = N8nService._internals

describe("assertPathSafe", () => {
  it("accepts a plain path", () => {
    expect(() => assertPathSafe("my-hook")).not.toThrow()
  })
  it("accepts a leading-slash path", () => {
    expect(() => assertPathSafe("/my-hook")).not.toThrow()
  })
  it("rejects missing / empty path", () => {
    expect(() => assertPathSafe(undefined)).toThrow(/Missing required parameter/)
    expect(() => assertPathSafe("")).toThrow(/Missing required parameter/)
    expect(() => assertPathSafe("   ")).toThrow(/Missing required parameter/)
  })
  it("rejects absolute URLs (SSRF hardening)", () => {
    expect(() => assertPathSafe("https://x.y/webhook/my-hook")).toThrow(/relative path/i)
    expect(() => assertPathSafe("http://internal/x")).toThrow(/relative path/i)
  })
  it("rejects protocol-relative URLs", () => {
    expect(() => assertPathSafe("//evil.example/x")).toThrow(/relative path/i)
  })
  it("rejects newline characters (log-injection defence)", () => {
    expect(() => assertPathSafe("my-hook\r\nInjected: header")).toThrow(/newline/i)
  })
  it('rejects ".." path segments', () => {
    expect(() => assertPathSafe("../api/v1/workflows")).toThrow(/\.\./)
    expect(() => assertPathSafe("foo/../bar")).toThrow(/\.\./)
  })
})

describe("N8nService._trigger HTTP method selection", () => {
  const cds = require("@sap/cds")

  let originalFetch
  let savedEnv
  let savedRequires
  let capturedInit

  beforeEach(() => {
    capturedInit = null
    originalFetch = globalThis.fetch
    savedEnv = {
      url: process.env.N8N_BASE_URL,
      key: process.env.N8N_API_KEY,
      test: process.env.N8N_USE_TEST_WEBHOOK,
    }
    savedRequires = cds.env.requires
    cds.env.requires = {
      N8nService: {
        credentials: {
          url: "http://x:5678",
          apiKey: "key-1",
        },
      },
    }
    globalThis.fetch = async (url, init) => {
      capturedInit = { url, init }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "",
      }
    }
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    cds.env.requires = savedRequires
    for (const [name, val] of [
      ["N8N_BASE_URL", savedEnv.url],
      ["N8N_API_KEY", savedEnv.key],
      ["N8N_USE_TEST_WEBHOOK", savedEnv.test],
    ]) {
      if (val === undefined) delete process.env[name]
      else process.env[name] = val
    }
  })

  function makeService() {
    return Object.create(N8nService.prototype)
  }

  function makeReq(data) {
    return {
      data,
      query: { SELECT: {} },
      target: { name: "N8nService.trigger" },
    }
  }

  it("POSTs with JSON body when payload is non-empty", async () => {
    const srv = makeService()
    await srv._trigger(makeReq({ path: "my-hook", payload: { foo: "bar" } }))
    expect(capturedInit.url).toBe("http://x:5678/webhook/my-hook")
    expect(capturedInit.init.method).toBe("POST")
    expect(capturedInit.init.headers["Content-Type"]).toBe("application/json")
    expect(capturedInit.init.headers["X-N8N-API-KEY"]).toBe("key-1")
    expect(capturedInit.init.body).toBe(JSON.stringify({ foo: "bar" }))
  })

  it("GETs (no body, no Content-Type) when payload is undefined", async () => {
    const srv = makeService()
    await srv._trigger(makeReq({ path: "my-hook" }))
    expect(capturedInit.url).toBe("http://x:5678/webhook/my-hook")
    expect(capturedInit.init.method).toBe("GET")
    expect(capturedInit.init.body).toBeUndefined()
    expect(capturedInit.init.headers["Content-Type"]).toBeUndefined()
    expect(capturedInit.init.headers["X-N8N-API-KEY"]).toBe("key-1")
  })

  it("GETs when payload is an empty object", async () => {
    const srv = makeService()
    await srv._trigger(makeReq({ path: "my-hook", payload: {} }))
    expect(capturedInit.init.method).toBe("GET")
    expect(capturedInit.init.body).toBeUndefined()
  })

  it("uses /webhook-test prefix when useTestWebhook is true", async () => {
    cds.env.requires.N8nService.credentials.useTestWebhook = true
    const srv = makeService()
    await srv._trigger(makeReq({ path: "my-hook", payload: { a: 1 } }))
    expect(capturedInit.url).toBe("http://x:5678/webhook-test/my-hook")
    expect(capturedInit.init.method).toBe("POST")
  })
})
