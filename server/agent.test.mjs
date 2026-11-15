import test from 'node:test'
import assert from 'node:assert/strict'
import { planWithAgent } from './agent.mjs'
import { validatePlan } from './study.mjs'

const search = { kind: 'search', sites: ['mons-mouton'], days: 15, mast: 2,
  from: 24, through: 72, limits: { dark: 0, earth: 72, slope: 5 } }
const reply = (name, args) => ({
  tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

test('agent reads coverage and repairs a rejected model tool call before producing a typed draft', async () => {
  let turn = 0
  const provider = async (messages, tools, choice) => {
    assert.equal(tools.length, 3)
    switch (++turn) {
      case 1:
        assert.equal(choice.function.name, 'inspect_coverage')
        return reply('inspect_coverage', {})
      case 2:
        assert.equal(JSON.parse(messages.at(-1).content).hours, 720)
        return reply('prepare_study', { ...search, days: 365 })
      default:
        assert.match(JSON.parse(messages.at(-1).content).error, /duration/)
        return reply('prepare_study', search)
    }
  }
  const result = await planWithAgent('Search Mons Mouton for zero hours of low light.', {}, { hours: 720 }, provider)
  assert.deepEqual(result.plan, search)
  assert.deepEqual(result.trace, ['inspect_coverage', 'prepare_study', 'prepare_study'])
})

test('unsupported requests return a distinct outcome', async () => {
  const queue = [reply('inspect_coverage', {}), reply('request_clarification', {
    status: 'coverage', message: 'The current data spans 30 days.',
  })]
  const result = await planWithAgent('Search a full year', {}, { hours: 720 }, async () => queue.shift())
  assert.equal(result.status, 'coverage')
  assert.equal(result.plan, undefined)
})

test('normalizes repeated regions and rejects forged coverage and invalid pads', () => {
  assert.deepEqual(validatePlan({ ...search, sites: ['mons-mouton', 'mons-mouton'] }), search)
  assert.throws(() => validatePlan({ ...search, through: 361 }), /coverage/)
  assert.throws(() => validatePlan({ kind: 'terrain', days: 15, scenarios: [
    { site: 'mons-mouton', node: 961, mast: 2, start: 0 },
  ] }), /scenario/)
})
