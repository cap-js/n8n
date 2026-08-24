const HTTP_METHODS = Object.freeze(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"])
const HTTP_METHOD_SET = new Set(HTTP_METHODS)

function normalizeHttpMethod(method) {
  if (typeof method !== "string") return undefined
  const normalized = method.trim().toUpperCase()
  return HTTP_METHOD_SET.has(normalized) ? normalized : undefined
}

module.exports = { HTTP_METHODS, normalizeHttpMethod }
