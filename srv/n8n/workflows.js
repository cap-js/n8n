const { parseResponse, getProperty, extractIds } = require("../../lib/handlers/utils")
const { n8nRequest } = require("../../lib/api/connection")

const WORKFLOW_READ_ONLY_FIELDS = [
  "id",
  "active",
  "createdAt",
  "updatedAt",
  "isArchived",
  "versionId",
  "triggerCount",
  "tags",
  "meta",
  "shared",
  "activeVersion",
]

// Removes fields the n8n API considers read-only. Returns a shallow copy so
// the caller's input is untouched.
function stripReadOnly(payload) {
  if (!payload || typeof payload !== "object") return payload
  const out = { ...payload }
  for (const f of WORKFLOW_READ_ONLY_FIELDS) delete out[f]
  return out
}

async function readWorkflows(req) {
  const ids = extractIds(req)
  if (ids) {
    const rows = []
    for (const id of ids) {
      const response = await n8nRequest({
        method: "GET",
        path: `/api/v1/workflows/${encodeURIComponent(id)}`,
      })
      const row = await parseResponse(req, response)
      if (row && (typeof row !== "object" || Object.keys(row).length > 0)) {
        rows.push(row)
      }
    }
    if (req.query.SELECT?.one) return rows[0]
    return rows
  }

  // No id in the where-clause — list all with optional filters.
  const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
  const params = new URLSearchParams()
  const active = getProperty(where, "active")
  const name = getProperty(where, "name")
  if (active != null) params.set("active", String(active))
  if (name) params.set("name", name)
  if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
  const qs = params.toString()
  const path = qs ? `/api/v1/workflows?${qs}` : "/api/v1/workflows"

  const response = await n8nRequest({ method: "GET", path })
  return parseResponse(req, response)
}

async function createWorkflow(req) {
  const body = stripReadOnly(req.data ?? {})
  for (const required of ["name", "nodes", "connections", "settings"]) {
    if (body[required] == null) {
      return req.reject(400, `Missing required workflow field: ${required}`)
    }
  }
  const response = await n8nRequest({
    method: "POST",
    path: "/api/v1/workflows",
    body,
  })
  return parseResponse(req, response)
}

const WORKFLOW_PUT_REQUIRED_FIELDS = ["name", "nodes", "connections", "settings"]

async function updateWorkflow(req) {
  const [id] = extractIds(req) ?? []
  if (!id) return req.reject(400, "Missing workflow id for UPDATE")
  const body = stripReadOnly(req.data ?? {})

  // Back-fill any PUT-mandatory field the caller left out from the currently stored workflow
  const missing = WORKFLOW_PUT_REQUIRED_FIELDS.filter((f) => body[f] == null)
  if (missing.length > 0) {
    const currentResponse = await n8nRequest({
      method: "GET",
      path: `/api/v1/workflows/${encodeURIComponent(id)}`,
    })
    const current = await parseResponse(req, currentResponse)
    if (!current || (typeof current === "object" && Object.keys(current).length === 0)) {
      return req.reject(404, `Workflow ${id} not found`)
    }
    for (const f of missing) {
      if (current[f] != null) body[f] = current[f]
    }
  }

  const response = await n8nRequest({
    method: "PUT",
    path: `/api/v1/workflows/${encodeURIComponent(id)}`,
    body,
  })
  return parseResponse(req, response)
}

async function deleteWorkflow(req) {
  const ids = extractIds(req)
  if (!ids || ids.length === 0) return req.reject(400, "Missing workflow id for DELETE")

  const results = []
  for (const id of ids) {
    const response = await n8nRequest({
      method: "DELETE",
      path: `/api/v1/workflows/${encodeURIComponent(id)}`,
    })
    results.push(await parseResponse(req, response))
  }
  return ids.length === 1 ? results[0] : results
}

async function publishWorkflow(req) {
  const { id, versionId, name, description } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for publishWorkflow")
  const body = {}
  if (versionId) body.versionId = versionId
  if (name) body.name = name
  if (description) body.description = description
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/publish`,
    body: Object.keys(body).length > 0 ? body : undefined,
  })
  return parseResponse(req, response)
}

async function unpublishWorkflow(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for unpublishWorkflow")
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/unpublish`,
  })
  return parseResponse(req, response)
}

async function archiveWorkflow(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing workflow id for archiveWorkflow")
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/workflows/${encodeURIComponent(id)}/archive`,
  })
  return parseResponse(req, response)
}

module.exports = {
  readWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  publishWorkflow,
  unpublishWorkflow,
  archiveWorkflow,
  // Exposed for reuse and unit tests.
  stripReadOnly,
  WORKFLOW_READ_ONLY_FIELDS,
  WORKFLOW_PUT_REQUIRED_FIELDS,
}
