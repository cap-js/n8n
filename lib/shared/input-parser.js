'use strict'

/**
 * Parses `@n8n.trigger.inputs` CSN entries and builds a nested tree describing
 * which entity fields should be included in the payload sent to n8n.
 *
 * Ported from process/lib/shared/input-parser.ts to plain JavaScript.
 * Behavioural parity with the process plugin's input parser is intentional so
 * users familiar with @cap-js/process pick this up without surprises.
 *
 * ## CSN input formats
 *
 * Simple:  { '=': '$self.field' }
 * Aliased: { path: { '=': '$self.field' }, as: 'alias' }
 *
 * The special marker '*' returned in path segments indicates "expand all
 * scalar fields", used both for the wildcard `$self` shortcut and to combine
 * expand-all with explicit nested fields for the same association.
 */

const WILDCARD = '*'

/**
 * @param {*} entry
 * @returns {boolean}
 */
function isAliasInput(entry) {
  return entry && typeof entry === 'object' && 'path' in entry && 'as' in entry
}

/**
 * @param {*} entry
 * @returns {boolean}
 */
function isSimpleInput(entry) {
  return entry && typeof entry === 'object' && '=' in entry && !('path' in entry)
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
  if (pathString === '$self') return [WILDCARD]
  return pathString.replace(/^\$self\./, '').split('.')
}

/**
 * Parses the raw CSN inputs array into parsed entries with path segments and
 * an optional alias.
 *
 * @param {Array|undefined} inputsCSN
 * @returns {Array<{path:string[],alias?:string}>}
 */
function parseInputsArray(inputsCSN) {
  if (!inputsCSN || inputsCSN.length === 0) return []
  const parsed = []
  for (const entry of inputsCSN) {
    if (isAliasInput(entry)) {
      parsed.push({ path: parsePath(entry.path['=']), alias: entry.as })
    } else if (isSimpleInput(entry)) {
      parsed.push({ path: parsePath(entry['=']), alias: undefined })
    }
  }
  return parsed
}

/**
 * Element kinds used to select the correct tree-builder handler.
 */
const ElementKind = Object.freeze({
  SCALAR: 'SCALAR',
  ASSOC_EXPAND_ALL: 'ASSOC_EXPAND_ALL',
  ASSOC_WITH_NESTED: 'ASSOC_WITH_NESTED',
  MULTI_ALIAS: 'MULTI_ALIAS',
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
  const directEntries = group.filter((e) => e.path.length === 1)
  const nonAliasedDirect = directEntries.find((e) => !e.alias)
  const aliasedDirect = directEntries.filter((e) => e.alias)
  const nestedEntries = group
    .filter((e) => e.path.length > 1)
    .map((e) => ({ path: e.path.slice(1), alias: e.alias }))
  return { directEntries, nonAliasedDirect, aliasedDirect, nestedEntries }
}

function classifyElement(analysis, isAssocOrComp) {
  const { nonAliasedDirect, aliasedDirect, nestedEntries } = analysis

  if (aliasedDirect.length > 1 && !nonAliasedDirect) {
    return {
      kind: ElementKind.MULTI_ALIAS,
      primaryAlias: undefined,
      additionalAliasedNodes: aliasedDirect.map((e) => ({ alias: e.alias })),
    }
  }

  if (!isAssocOrComp && aliasedDirect.length > 0 && nonAliasedDirect) {
    return {
      kind: ElementKind.SCALAR,
      primaryAlias: undefined,
      additionalAliasedNodes: aliasedDirect.map((e) => ({ alias: e.alias })),
    }
  }

  if (nestedEntries.length > 0) {
    return {
      kind: ElementKind.ASSOC_WITH_NESTED,
      primaryAlias: analysis.directEntries[0]?.alias,
      additionalAliasedNodes: [],
    }
  }

  if (isAssocOrComp) {
    return {
      kind: ElementKind.ASSOC_EXPAND_ALL,
      primaryAlias: analysis.directEntries[0]?.alias,
      additionalAliasedNodes: [],
    }
  }

  return {
    kind: ElementKind.SCALAR,
    primaryAlias: analysis.directEntries[0]?.alias,
    additionalAliasedNodes: [],
  }
}

function preprocessEntries(entries, rootEntity) {
  const groups = groupEntriesByFirstSegment(entries)
  const result = []

  for (const [elementName, group] of groups) {
    const element = rootEntity.getElement(elementName)
    const isAssocOrComp = element?.isAssocOrComp ?? false
    const targetEntity = element?.targetEntity ?? rootEntity

    const analysis = analyzeEntryGroup(group)
    const classification = classifyElement(analysis, isAssocOrComp)

    let nestedEntries = analysis.nestedEntries
    if (
      isAssocOrComp &&
      analysis.nonAliasedDirect &&
      nestedEntries.length > 0 &&
      classification.kind !== ElementKind.MULTI_ALIAS
    ) {
      nestedEntries = [{ path: [WILDCARD], alias: undefined }, ...nestedEntries]
    }

    result.push({
      name: elementName,
      kind: classification.kind,
      primaryAlias: classification.primaryAlias,
      nestedEntries,
      additionalAliasedNodes: classification.additionalAliasedNodes,
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
 *   - targetVariable?: string
 *   - associatedInputElements?: InputTreeNode[]  (present iff association/composition)
 */
function buildInputTree(entries, rootEntity) {
  if (entries.length === 0) return []
  const preprocessed = preprocessEntries(entries, rootEntity)
  const result = []

  for (const el of preprocessed) {
    switch (el.kind) {
      case ElementKind.SCALAR: {
        result.push({ sourceElement: el.name, targetVariable: el.primaryAlias })
        for (const { alias } of el.additionalAliasedNodes) {
          result.push({ sourceElement: el.name, targetVariable: alias })
        }
        break
      }
      case ElementKind.ASSOC_EXPAND_ALL: {
        result.push({
          sourceElement: el.name,
          targetVariable: el.primaryAlias,
          associatedInputElements: [],
        })
        for (const { alias } of el.additionalAliasedNodes) {
          result.push({
            sourceElement: el.name,
            targetVariable: alias,
            associatedInputElements: [],
          })
        }
        break
      }
      case ElementKind.ASSOC_WITH_NESTED: {
        const nested = buildInputTree(el.nestedEntries, el.targetEntity)
        result.push({
          sourceElement: el.name,
          targetVariable: el.primaryAlias,
          associatedInputElements: nested,
        })
        for (const { alias } of el.additionalAliasedNodes) {
          result.push({
            sourceElement: el.name,
            targetVariable: alias,
            associatedInputElements: nested,
          })
        }
        break
      }
      case ElementKind.MULTI_ALIAS: {
        for (const { alias } of el.additionalAliasedNodes) {
          if (el.isAssocOrComp) {
            if (el.nestedEntries.length > 0) {
              const nested = buildInputTree(el.nestedEntries, el.targetEntity)
              result.push({
                sourceElement: el.name,
                targetVariable: alias,
                associatedInputElements: nested,
              })
            } else {
              result.push({
                sourceElement: el.name,
                targetVariable: alias,
                associatedInputElements: [],
              })
            }
          } else {
            result.push({ sourceElement: el.name, targetVariable: alias })
          }
        }
        break
      }
    }
  }

  return result
}

module.exports = {
  WILDCARD,
  ElementKind,
  isAliasInput,
  isSimpleInput,
  parsePath,
  parseInputsArray,
  buildInputTree,
}
