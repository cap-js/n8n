"use strict"

/**
 * Parses `@n8n.process.start.inputs` CSN entries and builds a nested tree describing
 * which entity fields should be included in the payload sent to n8n.
 *
 * n8n webhooks receive free-form JSON and do not enforce any input schema, so
 * there is nothing to alias against. Field names from CAP are forwarded as-is;
 * downstream renaming should be done inside the n8n workflow (Edit Fields node).
 *
 * ## CSN input format
 *
 * Simple:  { '=': '$self.field' }
 *
 * The special marker '*' returned in path segments indicates "expand all
 * scalar fields", used both for the wildcard `$self` shortcut and to combine
 * expand-all with explicit nested fields for the same association.
 */

const WILDCARD = "*"

/**
 * @param {*} entry
 * @returns {boolean}
 */
function isSimpleInput(entry) {
  return entry && typeof entry === "object" && "=" in entry
}

/**
 * Parses a path string like "$self.items.title" into ["items", "title"].
 * Strips the "$self." prefix and splits by ".".
 *
 * Special case: "$self" alone returns ['*'] (all scalar fields).
 *
 * @param {string} pathString
 * @returns {string[]}
 */
function parsePath(pathString) {
  if (pathString === "$self") return [WILDCARD]
  return pathString.replace(/^\$self\./, "").split(".")
}

/**
 * Parses the raw CSN inputs array into parsed entries with path segments.
 *
 * @param {Array|undefined} inputsCSN
 * @returns {Array<{path:string[]}>}
 */
function parseInputsArray(inputsCSN) {
  if (!inputsCSN || inputsCSN.length === 0) return []
  const parsed = []
  for (const entry of inputsCSN) {
    if (isSimpleInput(entry)) {
      parsed.push({ path: parsePath(entry["="]) })
    }
  }
  return parsed
}

/**
 * Element kinds used to select the correct tree-builder handler.
 */
const ElementKind = Object.freeze({
  SCALAR: "SCALAR",
  ASSOC_EXPAND_ALL: "ASSOC_EXPAND_ALL",
  ASSOC_WITH_NESTED: "ASSOC_WITH_NESTED",
})

function groupEntriesByFirstSegment(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const first = entry.path[0]
    if (!groups.has(first)) groups.set(first, [])
    groups.get(first).push(entry)
  }
  return groups
}

function analyzeEntryGroup(group) {
  const hasDirectEntry = group.some((e) => e.path.length === 1)
  const nestedEntries = group
    .filter((e) => e.path.length > 1)
    .map((e) => ({ path: e.path.slice(1) }))
  return { hasDirectEntry, nestedEntries }
}

function classifyElement(analysis, isAssocOrComp) {
  const { nestedEntries } = analysis

  if (nestedEntries.length > 0) {
    return ElementKind.ASSOC_WITH_NESTED
  }

  if (isAssocOrComp) {
    return ElementKind.ASSOC_EXPAND_ALL
  }

  return ElementKind.SCALAR
}

function preprocessEntries(entries, rootEntity) {
  const groups = groupEntriesByFirstSegment(entries)
  const result = []

  for (const [elementName, group] of groups) {
    const element = rootEntity.getElement(elementName)
    const isAssocOrComp = element?.isAssocOrComp ?? false
    const targetEntity = element?.targetEntity ?? rootEntity

    const analysis = analyzeEntryGroup(group)
    const kind = classifyElement(analysis, isAssocOrComp)

    let nestedEntries = analysis.nestedEntries
    // When an association/composition is mentioned both directly (expand all)
    // and with specific nested paths, inject a wildcard so downstream nodes
    // still get every scalar of the target plus the explicit sub-selection.
    if (isAssocOrComp && analysis.hasDirectEntry && nestedEntries.length > 0) {
      nestedEntries = [{ path: [WILDCARD] }, ...nestedEntries]
    }

    result.push({
      name: elementName,
      kind,
      nestedEntries,
      isAssocOrComp,
      targetEntity,
    })
  }

  return result
}

/**
 * Builds a tree of `InputTreeNode` from parsed entries.
 *
 * Each node has:
 *   - sourceElement: string
 *   - associatedInputElements?: InputTreeNode[]  (present iff association/composition)
 */
function buildInputTree(entries, rootEntity) {
  if (entries.length === 0) return []
  const preprocessed = preprocessEntries(entries, rootEntity)
  const result = []

  for (const el of preprocessed) {
    switch (el.kind) {
      case ElementKind.SCALAR: {
        result.push({ sourceElement: el.name })
        break
      }
      case ElementKind.ASSOC_EXPAND_ALL: {
        result.push({
          sourceElement: el.name,
          associatedInputElements: [],
        })
        break
      }
      case ElementKind.ASSOC_WITH_NESTED: {
        const nested = buildInputTree(el.nestedEntries, el.targetEntity)
        result.push({
          sourceElement: el.name,
          associatedInputElements: nested,
        })
        break
      }
    }
  }

  return result
}

module.exports = {
  WILDCARD,
  ElementKind,
  isSimpleInput,
  parsePath,
  parseInputsArray,
  buildInputTree,
}
