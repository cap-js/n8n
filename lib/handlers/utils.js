const cds = require("@sap/cds")

function getProperty(where, property) {
  if (!where) return null
  for (let i = 0; i < where.length; i++) {
    const ele = where[i]
    if (
      ele?.val !== undefined &&
      ((where[i - 1] === "=" && where[i - 2]?.ref && where[i - 2].ref[0] === property) ||
        (where[i + 1] === "=" && where[i + 2]?.ref && where[i + 2].ref[0] === property))
    ) {
      return ele.val
    } else if (ele?.xpr) {
      const val = getProperty(ele.xpr, property)
      if (val) return val
    }
  }
  return null
}

function getPropertyList(where, property) {
  if (!where) return null
  for (let i = 0; i < where.length; i++) {
    const ele = where[i]
    // Look for the triple: {ref:['<property>']} 'in' {list: [{val:...},...]}
    if (
      ele?.list &&
      Array.isArray(ele.list) &&
      where[i - 1] === "in" &&
      where[i - 2]?.ref?.[0] === property
    ) {
      return ele.list.map((v) => v?.val).filter((v) => v !== undefined)
    }
    if (ele?.xpr) {
      const list = getPropertyList(ele.xpr, property)
      if (list) return list
    }
  }
  return null
}

function extractWhereClause(req) {
  const cqn = req.query?.SELECT ?? req.query?.UPDATE ?? req.query?.DELETE
  if (!cqn) return null
  const ref = cqn.from?.ref ?? cqn.entity?.ref
  return ref?.at?.(-1)?.where ?? cqn.where ?? null
}

function extractIds(req, key = "id") {
  const last = req.params?.at?.(-1)
  if (last != null) {
    if (typeof last === "object" && last[key] != null) return [last[key]]
    if (typeof last !== "object") return [last]
  }
  if (req.data?.[key] != null) return [req.data[key]]

  const where = extractWhereClause(req)
  if (where) {
    const list = getPropertyList(where, key)
    if (list && list.length > 0) return list
    const single = getProperty(where, key)
    if (single) return [single]
  }
  return null
}

async function parseResponse(req, response) {
  if (response.ok) {
    const body = await response.json().catch(() => null)
    if (body == null) return body
    let res = Array.isArray(body?.data) ? body.data : body
    if (req.query?.SELECT?.one) {
      res = Array.isArray(res) ? res[0] : res
    }
    return res
  }

  const json = response.headers?.get?.("content-type")?.match?.("json")
    ? await response.json().catch(() => undefined)
    : undefined
  const detail = json?.message ?? response.statusText ?? String(response.status)
  const target = req.target?.name ?? req.event
  cds.error(502, `Error requesting ${target} from n8n: HTTP ${response.status}: ${detail}`)
}

/** Builds a CAP uniform write-result
 * INSERT returns `[{ <keys> }, ...]`;
 * UPDATE/DELETE return `[]`
 *
 * @param {*} rows
 * @param {*} affected
 * @returns
 */
function writeResult(rows, affected) {
  const result = rows ?? []
  Object.defineProperty(result, "affected", { value: affected, enumerable: false })
  return result
}

module.exports = {
  getProperty,
  getPropertyList,
  extractWhereClause,
  extractIds,
  parseResponse,
  writeResult,
}
