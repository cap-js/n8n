'use strict'

const {
  parsePath,
  parseInputsArray,
  buildInputTree,
  WILDCARD,
} = require('../../lib/shared/input-parser')

// Minimal EntityContext mock. `elements` map: name -> { isAssocOrComp, children? }.
function makeContext(elements) {
  return {
    getElement(name) {
      const el = elements?.[name]
      if (!el) return undefined
      return {
        isAssocOrComp: !!el.isAssocOrComp,
        targetEntity: el.children ? makeContext(el.children) : makeContext(elements),
      }
    },
  }
}

describe('parsePath', () => {
  it('returns wildcard for $self alone', () => {
    expect(parsePath('$self')).toEqual([WILDCARD])
  })
  it('strips $self. prefix', () => {
    expect(parsePath('$self.foo')).toEqual(['foo'])
  })
  it('splits nested paths', () => {
    expect(parsePath('$self.items.title')).toEqual(['items', 'title'])
  })
})

describe('parseInputsArray', () => {
  it('handles simple and aliased entries', () => {
    expect(
      parseInputsArray([
        { '=': '$self.ID' },
        { path: { '=': '$self.total' }, as: 'orderAmount' },
      ]),
    ).toEqual([
      { path: ['ID'], alias: undefined },
      { path: ['total'], alias: 'orderAmount' },
    ])
  })
  it('returns [] for undefined / empty inputs', () => {
    expect(parseInputsArray(undefined)).toEqual([])
    expect(parseInputsArray([])).toEqual([])
  })
})

describe('buildInputTree', () => {
  it('emits a scalar node', () => {
    const tree = buildInputTree(
      [{ path: ['ID'], alias: undefined }],
      makeContext({ ID: { isAssocOrComp: false } }),
    )
    expect(tree).toEqual([{ sourceElement: 'ID', targetVariable: undefined }])
  })

  it('emits an expand-all composition node', () => {
    const tree = buildInputTree(
      [{ path: ['items'], alias: undefined }],
      makeContext({ items: { isAssocOrComp: true, children: {} } }),
    )
    expect(tree).toEqual([
      {
        sourceElement: 'items',
        targetVariable: undefined,
        associatedInputElements: [],
      },
    ])
  })

  it('emits a composition with specific nested fields (wildcard NOT injected when only nested)', () => {
    const tree = buildInputTree(
      [
        { path: ['items', 'title'], alias: undefined },
      ],
      makeContext({
        items: {
          isAssocOrComp: true,
          children: { title: { isAssocOrComp: false } },
        },
      }),
    )
    expect(tree).toEqual([
      {
        sourceElement: 'items',
        targetVariable: undefined,
        associatedInputElements: [
          { sourceElement: 'title', targetVariable: undefined },
        ],
      },
    ])
  })

  it('injects wildcard when combining expand-all with specific nested fields', () => {
    const tree = buildInputTree(
      [
        { path: ['items'], alias: undefined },
        { path: ['items', 'title'], alias: undefined },
      ],
      makeContext({
        items: {
          isAssocOrComp: true,
          children: { title: { isAssocOrComp: false } },
        },
      }),
    )
    expect(tree).toEqual([
      {
        sourceElement: 'items',
        targetVariable: undefined,
        associatedInputElements: [
          { sourceElement: WILDCARD },
          { sourceElement: 'title', targetVariable: undefined },
        ],
      },
    ])
  })

  it('produces two nodes for multi-alias scalar', () => {
    const tree = buildInputTree(
      [
        { path: ['ID'], alias: 'OrderId' },
        { path: ['ID'], alias: 'RefId' },
      ],
      makeContext({ ID: { isAssocOrComp: false } }),
    )
    expect(tree).toEqual([
      { sourceElement: 'ID', targetVariable: 'OrderId' },
      { sourceElement: 'ID', targetVariable: 'RefId' },
    ])
  })

  it('produces additional aliased sibling nodes for scalar with alias + non-alias', () => {
    const tree = buildInputTree(
      [
        { path: ['ID'], alias: undefined },
        { path: ['ID'], alias: 'OrderId' },
      ],
      makeContext({ ID: { isAssocOrComp: false } }),
    )
    expect(tree).toEqual([
      { sourceElement: 'ID', targetVariable: undefined },
      { sourceElement: 'ID', targetVariable: 'OrderId' },
    ])
  })
})
