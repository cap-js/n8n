"use strict"

/**
 * Probes the `marvin-managed-n8n` BTP destination end-to-end using the
 * plugin's own auth + connection code paths. This exercises the same
 * modules that would run in production, so a green probe here means the
 * plugin can talk to the managed n8n instance.
 *
 * Run:
 *   cds bind --exec -- node scripts/probe-managed-n8n.js
 */

process.env.CDS_CONFIG = JSON.stringify({
  requires: {
    N8nService: {
      kind: "rest-n8n-service",
      credentials: { destination: "marvin-managed-n8n" },
    },
  },
})

const cds = require("@sap/cds")
const { resolveDestination } = require("../lib/auth/destination")
const { resolveN8nConnection } = require("../lib/api/connection")
const { createN8nClient } = require("../lib/api/n8n-client")

async function main() {
  // 1) Raw destination resolution
  console.log("=== 1. resolveDestination(marvin-managed-n8n) ===")
  const dest = await resolveDestination("marvin-managed-n8n")
  if (!dest) {
    console.error("Destination not found.")
    process.exit(1)
  }
  console.log("url:            ", dest.url)
  console.log("authHeader keys:", Object.keys(dest.authHeaders ?? {}))
  const authz = dest.authHeaders?.Authorization
  console.log(
    "Authorization:  ",
    authz ? `${authz.slice(0, 18)}…  (len=${authz.length})` : "(none)",
  )
  const destCfg = dest.originalProperties?.destinationConfiguration ?? dest.originalProperties ?? {}
  const apiKeyOnDest = destCfg["URL.headers.X-N8N-API-KEY"]
  console.log(
    "X-N8N-API-KEY on destination:",
    apiKeyOnDest ? `${apiKeyOnDest.slice(0, 12)}…  (len=${apiKeyOnDest.length})` : "(none)",
  )

  // 2) Plugin's connection resolver
  console.log("\n=== 2. resolveN8nConnection() ===")
  const conn = await resolveN8nConnection("N8nService")
  console.log("baseUrl:        ", conn.baseUrl)
  console.log(
    "apiKey:         ",
    conn.apiKey ? `${conn.apiKey.slice(0, 12)}…  (len=${conn.apiKey.length})` : "(none)",
  )
  console.log("authHeader keys:", Object.keys(conn.authHeaders ?? {}))

  // 3) Real API round-trip via the plugin's client
  console.log("\n=== 3. n8n-client.listExecutions(<test-workflow-id>) ===")
  const client = createN8nClient(() => Promise.resolve(conn))
  try {
    const list = await client.listExecutions("___probe___")
    console.log("OK  (list length:", list.length, ")")
    console.log("sample:", JSON.stringify(list[0] ?? {}, null, 2).slice(0, 400))
  } catch (err) {
    console.log("FAIL:", err.message)
  }

  // 4) Also try a raw GET against the API base to distinguish n8n-side vs proxy-side failures
  console.log("\n=== 4. Raw GET api/v1/workflows?limit=1 (with merged headers) ===")
  const url = `${conn.baseUrl.replace(/\/$/, "")}/api/v1/workflows?limit=1`
  try {
    const res = await fetch(url, {
      headers: {
        ...(conn.authHeaders ?? {}),
        "X-N8N-API-KEY": conn.apiKey,
      },
    })
    console.log("status:", res.status, res.statusText)
    const body = await res.text()
    console.log("body:  ", body.slice(0, 400))
  } catch (err) {
    console.log("fetch error:", err.message)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => cds.shutdown?.())
