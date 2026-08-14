const { n8nRequest } = require("../../lib/api/connection")
const { parseResponse, getProperty, extractIds } = require("../../lib/handlers/utils")

async function readExecutions(req) {
  const ids = extractIds(req)
  if (ids) {
    const responses = await Promise.all(
      ids.map((id) =>
        n8nRequest({
          method: "GET",
          path: `/api/v1/executions/${encodeURIComponent(id)}?includeData=true`,
        }),
      ),
    )
    const rows = (await Promise.all(responses.map((r) => parseResponse(req, r)))).filter(
      (row) => row && (typeof row !== "object" || Object.keys(row).length > 0),
    )
    if (req.query.SELECT?.one) return rows[0]
    return rows
  }

  // No id in the where-clause — list with optional filters.
  const where = req.query.SELECT.from.ref.at(-1)?.where || req.query.SELECT.where
  const params = new URLSearchParams()
  const workflowId = getProperty(where, "workflowId")
  const status = getProperty(where, "status")
  if (workflowId) params.set("workflowId", workflowId)
  if (status) params.set("status", status)
  if (req.query.SELECT.limit?.rows?.val) params.set("limit", req.query.SELECT.limit.rows.val)
  const qs = params.toString()
  const path = qs ? `/api/v1/executions?${qs}` : "/api/v1/executions"

  const response = await n8nRequest({ method: "GET", path })
  return parseResponse(req, response)
}

async function deleteExecution(req) {
  const ids = extractIds(req)
  if (!ids || ids.length === 0) return req.reject(400, "Missing execution id for DELETE")

  const responses = await Promise.all(
    ids.map((id) =>
      n8nRequest({ method: "DELETE", path: `/api/v1/executions/${encodeURIComponent(id)}` }),
    ),
  )
  const results = await Promise.all(responses.map((r) => parseResponse(req, r)))
  return ids.length === 1 ? results[0] : results
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
}
