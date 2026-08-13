const { parseResponse, getProperty } = require("../../lib/handlers/utils")
function n8nRequest(opts) {
  return require("../n8n-to-rest").n8nRequest(opts)
}

// Extracts the execution id from a READ / DELETE / bound-action request
function extractExecutionId(req) {
  const last = req.params?.at?.(-1)
  if (last != null) {
    if (typeof last === "object" && last.id != null) return last.id
    if (typeof last !== "object") return last
  }
  
  if (req.data?.id) return req.data.id
  
  const cqn = req.query?.DELETE ?? req.query?.UPDATE
  const ref = cqn?.from?.ref ?? cqn?.entity?.ref
  const where = ref?.at?.(-1)?.where ?? cqn?.where
  if (where) {
    const id = getProperty(where, "id")
    if (id) return id
  }
  return null
}

async function readExecutions(req) {
  const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
  const id = getProperty(where, "id")

  let path = "/api/v1/executions"
  if (id) {
    path += `/${encodeURIComponent(id)}?includeData=true`
  } else {
    const params = new URLSearchParams()
    const workflowId = getProperty(where, "workflowId")
    const status = getProperty(where, "status")
    if (workflowId) params.set("workflowId", workflowId)
    if (status) params.set("status", status)
    if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
    const qs = params.toString()
    if (qs) path += `?${qs}`
  }

  const response = await n8nRequest({ method: "GET", path })
  return parseResponse(req, response)
}

async function deleteExecution(req) {
  const id = extractExecutionId(req)
  if (!id) return req.reject(400, "Missing execution id for DELETE")
  const response = await n8nRequest({
    method: "DELETE",
    path: `/api/v1/executions/${encodeURIComponent(id)}`,
  })
  return parseResponse(req, response)
}

async function retryExecution(req) {
  const { id, loadWorkflow } = req.data ?? {}
  if (!id) return req.reject(400, "Missing execution id for retryExecution")
  const body = loadWorkflow != null ? { loadWorkflow: !!loadWorkflow } : undefined
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/executions/${encodeURIComponent(id)}/retry`,
    body,
  })
  return parseResponse(req, response)
}

async function stopExecution(req) {
  const { id } = req.data ?? {}
  if (!id) return req.reject(400, "Missing execution id for stopExecution")
  const response = await n8nRequest({
    method: "POST",
    path: `/api/v1/executions/${encodeURIComponent(id)}/stop`,
  })
  return parseResponse(req, response)
}

module.exports = {
  readExecutions,
  deleteExecution,
  retryExecution,
  stopExecution,
  // Exposed for reuse and unit tests.
  extractExecutionId,
}
