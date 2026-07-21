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
  it('handles simple entries', () => {
    expect(
      parseInputsArray([
        { '=': '$self.ID' },
        { '=': '$self.total' },
      ]),
    ).toEqual([
      { path: ['ID'] },
      { path: ['total'] },
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
      [{ path: ['ID'] }],
      makeContext({ ID: { isAssocOrComp: false } }),
    )
    expect(tree).toEqual([{ sourceElement: 'ID' }])
  })

  it('emits an expand-all composition node', () => {
    const tree = buildInputTree(
      [{ path: ['items'] }],
      makeContext({ items: { isAssocOrComp: true, children: {} } }),
    )
    expect(tree).toEqual([
      {
        sourceElement: 'items',
        associatedInputElements: [],
      },
    ])
  })

  it('emits a composition with specific nested fields (wildcard NOT injected when only nested)', () => {
    const tree = buildInputTree(
      [
        { path: ['items', 'title'] },
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
        associatedInputElements: [
          { sourceElement: 'title' },
        ],
      },
    ])
  })

  it('injects wildcard when combining expand-all with specific nested fields', () => {
    const tree = buildInputTree(
      [
        { path: ['items'] },
        { path: ['items', 'title'] },
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
        associatedInputElements: [
          { sourceElement: WILDCARD },
          { sourceElement: 'title' },
        ],
      },
    ])
  })
})
