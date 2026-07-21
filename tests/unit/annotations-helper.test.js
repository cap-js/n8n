'use strict'

const {
  findTriggerAnnotations,
  buildTriggerCache,
  extractQualifier,
} = require('../../lib/shared/annotations-helper')

const CUD = ['CREATE', 'UPDATE', 'DELETE']

// Helper to build a fake CSN-shaped entity object.
function ent(name, annotations, actions) {
  return { name, actions, ...annotations }
}

describe('extractQualifier', () => {
  it('returns undefined for base annotation', () => {
    expect(extractQualifier('@n8n.trigger', '@n8n.trigger')).toBeUndefined()
  })
  it('returns qualifier portion', () => {
    expect(extractQualifier('@n8n.trigger#one', '@n8n.trigger')).toBe('one')
  })
  it('returns undefined for weird separator', () => {
    expect(extractQualifier('@n8n.trigger.foo', '@n8n.trigger')).toBeUndefined()
  })
})

describe('findTriggerAnnotations — string shorthand', () => {
  it('picks up plain string form and defaults to CREATE + UPDATE', () => {
    const e = ent('Foo', { '@n8n.trigger': 'my-hook' })
    expect(findTriggerAnnotations(e)).toEqual([
      {
        qualifier: undefined,
        workflow: 'my-hook',
        on: ['CREATE', 'UPDATE'],
        conditionExpr: undefined,
        inputs: undefined,
      },
    ])
  })

  it('picks up qualified string form', () => {
    const e = ent('Foo', { '@n8n.trigger#other': 'other-hook' })
    const anns = findTriggerAnnotations(e)
    expect(anns).toHaveLength(1)
    expect(anns[0].qualifier).toBe('other')
    expect(anns[0].workflow).toBe('other-hook')
  })
})

describe('findTriggerAnnotations — record form', () => {
  it('reads workflow / on / if / inputs', () => {
    const e = ent('Foo', {
      '@n8n.trigger.workflow': 'wf-a',
      '@n8n.trigger.on': 'UPDATE',
      '@n8n.trigger.if': { xpr: [{ ref: ['status'] }, '=', { val: 'shipped' }] },
      '@n8n.trigger.inputs': [{ '=': '$self.ID' }],
    })
    const anns = findTriggerAnnotations(e)
    expect(anns).toHaveLength(1)
    expect(anns[0]).toMatchObject({
      workflow: 'wf-a',
      on: ['UPDATE'],
      qualifier: undefined,
    })
    expect(anns[0].conditionExpr).toBeDefined()
    expect(anns[0].inputs).toEqual([{ '=': '$self.ID' }])
  })

  it('supports array on: values', () => {
    const e = ent('Foo', {
      '@n8n.trigger.workflow': 'wf-a',
      '@n8n.trigger.on': ['CREATE', 'UPDATE'],
    })
    const anns = findTriggerAnnotations(e)
    expect(anns[0].on).toEqual(['CREATE', 'UPDATE'])
  })

  it('skips record form when required keys missing', () => {
    // has .workflow but no .on -> ignored at scan time (build validation will
    // report the error separately).
    const e = ent('Foo', { '@n8n.trigger.workflow': 'wf-a' })
    expect(findTriggerAnnotations(e)).toEqual([])
  })

  it('captures multiple qualified record annotations', () => {
    const e = ent('Foo', {
      '@n8n.trigger#one.workflow': 'wf-one',
      '@n8n.trigger#one.on': 'CREATE',
      '@n8n.trigger#two.workflow': 'wf-two',
      '@n8n.trigger#two.on': 'DELETE',
    })
    const anns = findTriggerAnnotations(e)
    expect(anns).toHaveLength(2)
    expect(new Set(anns.map((a) => a.workflow))).toEqual(new Set(['wf-one', 'wf-two']))
  })
})

describe('buildTriggerCache', () => {
  it('produces one cache entry per (entity,event)', () => {
    const entities = [
      ent('Books', { '@n8n.trigger': 'book-hook' }),   // CREATE + UPDATE
      ent('Orders', {
        '@n8n.trigger.workflow': 'order-hook',
        '@n8n.trigger.on': 'UPDATE',
      }),
    ]
    const cache = buildTriggerCache(entities, CUD)
    // Books -> CREATE + UPDATE, Orders -> UPDATE
    expect(cache.size).toBe(3)
    expect(cache.get('Books:CREATE').triggerAnnotations[0].workflow).toBe('book-hook')
    expect(cache.get('Books:UPDATE').triggerAnnotations[0].workflow).toBe('book-hook')
    expect(cache.get('Orders:UPDATE').triggerAnnotations[0].workflow).toBe('order-hook')
  })

  it('expands wildcard "*" to CRUD + bound actions', () => {
    const entities = [
      ent(
        'Books',
        {
          '@n8n.trigger.workflow': 'star-hook',
          '@n8n.trigger.on': '*',
        },
        { archive: {} },
      ),
    ]
    const cache = buildTriggerCache(entities, CUD)
    expect(new Set([...cache.keys()])).toEqual(
      new Set(['Books:CREATE', 'Books:UPDATE', 'Books:DELETE', 'Books:archive']),
    )
  })
})
