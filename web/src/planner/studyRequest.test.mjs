import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretStudy, studyExamples } from './studyRequest.ts'

const baseline = { site: 'shackleton-ridge', node: 42, start: 0, mast: 2 }
const context = {
  scenarios: [baseline, { ...baseline, start: 48 }],
  active: 0,
  days: 15,
  limits: { dark: 48, earth: 72, slope: 5 },
  epoch: '2026-11-14T00:00:00Z',
  hours: 720,
}

test('examples route to three separate science tools', () => {
  assert.deepEqual(studyExamples.map(({ question }) => interpretStudy(question, context).plan.kind),
    ['search', 'compare', 'terrain'])
})

test('search preserves requested region, launch interval and constraints', () => {
  const result = interpretStudy('Find sites in Mons Mouton from 2026-11-15T08:00Z through 2026-11-17 with low light <= 0 h and slope <= 3 degrees.', context)
  assert.deepEqual(result, { status: 'ready', plan: {
    kind: 'search', sites: ['mons-mouton'], days: 15,
    limits: { dark: 0, earth: 72, slope: 3 }, mast: 2, from: 32, through: 72,
  } })
})

test('date comparison retains the chosen pad rather than snapping to a site center', () => {
  const result = interpretStudy('Compare 2026-11-15 and 2026-11-16 for 10 days.', context)
  assert.deepEqual(result.plan.scenarios.map(({ node, start }) => [node, start]), [[42, 24], [42, 48]])
})

test('coverage, unsupported physics, and missing input have distinct responses', () => {
  for (const [input, status] of [
    ['Compare any two points across a year', 'coverage'],
    ['Compare the current pad on 2027-01-01', 'coverage'],
    ['Can my RF link work?', 'unsupported'],
    ['Search for good pads', 'clarify'],
    ['Search Mons Mouton with Earth obstruction less than 13 hours', 'clarify'],
    ['Compare pad 17 and pad 18 at Mons Mouton', 'clarify'],
    ['Compare 2026-11-15T08:30Z and 2026-11-16', 'clarify'],
    ['Search this area then rerun at finer resolution', 'unsupported'],
  ]) {
    assert.equal(interpretStudy(input, context).status, status, input)
  }
})
