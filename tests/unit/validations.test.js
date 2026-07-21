'use strict'

const { validateTriggerAnnotations } = require('../../lib/build/validations')

// Minimal plugin double: collects messages.
function makePlugin() {
  const plugin = {
    messages: [],
    error(msg) { this.messages.push({ severity: 'error', message: msg }) },
    warn(msg) { this.messages.push({ severity: 'warning', message: msg }) },
  }
  return plugin
}

function ent(annotations, actions) {
  return { actions, ...annotations }
}

describe('validateTriggerAnnotations — string shorthand', () => {
  it('accepts a non-empty string', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations('Foo', ent({ '@n8n.trigger': 'my-hook' }), plugin)
    expect(plugin.messages).toEqual([])
  })

  it('rejects empty string', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations('Foo', ent({ '@n8n.trigger': '' }), plugin)
    expect(plugin.messages.some((m) => m.severity === 'error')).toBe(true)
  })
})

describe('validateTriggerAnnotations — record form', () => {
  it('accepts a complete record', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'CREATE',
      }),
      plugin,
    )
    expect(plugin.messages).toEqual([])
  })

  it('reports error when only workflow is set', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({ '@n8n.trigger.workflow': 'wf' }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be present together/i.test(m.message))).toBe(true)
  })

  it('reports error when only on is set', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({ '@n8n.trigger.on': 'CREATE' }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be present together/i.test(m.message))).toBe(true)
  })

  it('reports error for invalid on value', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'READ',
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /not a CRUD event/i.test(m.message))).toBe(true)
  })

  it('accepts bound action name in on', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent(
        {
          '@n8n.trigger.workflow': 'wf',
          '@n8n.trigger.on': 'archive',
        },
        { archive: {} },
      ),
      plugin,
    )
    expect(plugin.messages.filter((m) => m.severity === 'error')).toEqual([])
  })

  it('warns on unknown sub-key', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'CREATE',
        '@n8n.trigger.bogus': 'value',
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => m.severity === 'warning' && /unknown sub-key/i.test(m.message))).toBe(true)
  })

  it('rejects inputs that is not an array', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'CREATE',
        '@n8n.trigger.inputs': 'foo',
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /must be an array/i.test(m.message))).toBe(true)
  })

  it('rejects malformed inputs entry', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'CREATE',
        '@n8n.trigger.inputs': [{ foo: 'bar' }],
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => /each entry/i.test(m.message))).toBe(true)
  })

  it('accepts simple inputs entries', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'CREATE',
        '@n8n.trigger.inputs': [
          { '=': '$self.ID' },
          { '=': '$self.total' },
        ],
      }),
      plugin,
    )
    expect(plugin.messages.filter((m) => m.severity === 'error')).toEqual([])
  })

  it('rejects aliased inputs entries (aliasing not supported)', () => {
    const plugin = makePlugin()
    validateTriggerAnnotations(
      'Orders',
      ent({
        '@n8n.trigger.workflow': 'wf',
        '@n8n.trigger.on': 'CREATE',
        '@n8n.trigger.inputs': [
          { path: { '=': '$self.total' }, as: 'amount' },
        ],
      }),
      plugin,
    )
    expect(plugin.messages.some((m) => m.severity === 'error' && /Aliasing is not supported/i.test(m.message))).toBe(true)
  })
})
