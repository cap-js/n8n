const N8nService = require("../../srv/n8n-to-rest")
const { assertPathSafe, n8nConfig } = N8nService._internals

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

describe("n8nConfig", () => {
  const cds = require("@sap/cds")
  let savedRequires
  let savedEnv
  beforeEach(() => {
    savedRequires = cds.env.requires
    savedEnv = { url: process.env.N8N_BASE_URL, key: process.env.N8N_API_KEY }
    cds.env.requires = {}
  })
  afterEach(() => {
    cds.env.requires = savedRequires
    if (savedEnv.url === undefined) delete process.env.N8N_BASE_URL
    else process.env.N8N_BASE_URL = savedEnv.url
    if (savedEnv.key === undefined) delete process.env.N8N_API_KEY
    else process.env.N8N_API_KEY = savedEnv.key
  })

  it("reads url + apiKey from cds.env.requires.N8nService.credentials", () => {
    cds.env.requires.N8nService = {
      credentials: { url: "http://x:5678", apiKey: "abc" },
    }
    expect(n8nConfig()).toEqual({ baseUrl: "http://x:5678", apiKey: "abc" })
  })

  it("falls back to N8N_* env vars when credentials are absent", () => {
    process.env.N8N_BASE_URL = "http://envhost:5678"
    process.env.N8N_API_KEY = "env-key"
    expect(n8nConfig()).toEqual({ baseUrl: "http://envhost:5678", apiKey: "env-key" })
  })

  it("mixes: url from config, apiKey from env", () => {
    cds.env.requires.N8nService = { credentials: { url: "http://x:5678" } }
    process.env.N8N_API_KEY = "env-key"
    expect(n8nConfig()).toEqual({ baseUrl: "http://x:5678", apiKey: "env-key" })
  })
})
