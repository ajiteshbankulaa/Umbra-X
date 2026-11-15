import test from 'node:test'
import assert from 'node:assert/strict'

import { badgeClassForTier, classifyScenarioConfidence, combinePairConfidence } from './confidence.ts'

const nominalInput = {
  complete: true,
  coveredAzimuths: 360,
  hasRegionalTerrain: true,
  is80mLive: false,
  slope: 3.1,
  slopeLimit: 5.0,
  longestDark: 24.0,
  referenceLongestDark: 24.0,
  darkLimit: 48.0,
  longestEarth: 36.0,
  referenceLongestEarth: 36.0,
  earthLimit: 72.0,
  feasible: true,
  unmetWh: 0,
  headroomKg: 25.0,
  sigma: 2,
}

test('classifyScenarioConfidence distinguishes Model-supported, Sensitive, Incomplete, and Not modeled', () => {
  const strong = classifyScenarioConfidence(nominalInput)
  assert.equal(strong.overall, 'Model-supported')
  assert.equal(strong.powerFeasible, true)
  const rfDomain = strong.domains.find(d => d.id === 'rf_ice')
  assert.equal(rfDomain?.tier, 'Not modeled')
  assert.equal(strong.domains.find(d => d.id === 'terrain')?.tier, 'Model-supported')
  assert.equal(strong.domains.find(d => d.id === 'slope')?.tier, 'Model-supported')
  assert.equal(strong.domains.find(d => d.id === 'power')?.tier, 'Model-supported')

  // Near-5 deg slope & extent flip -> Sensitive
  const borderSlope = classifyScenarioConfidence({ ...nominalInput, slope: 4.85 })
  assert.equal(borderSlope.overall, 'Sensitive')
  assert.equal(borderSlope.domains.find(d => d.id === 'slope')?.tier, 'Sensitive')

  // Power deficit when geometry passes -> overall Sensitive, powerFeasible false
  const powerFail = classifyScenarioConfidence({ ...nominalInput, feasible: false, unmetWh: 1200, headroomKg: -4.0 })
  assert.equal(powerFail.overall, 'Sensitive')
  assert.equal(powerFail.powerFeasible, false)
  assert.equal(powerFail.domains.find(d => d.id === 'power')?.tier, 'Sensitive')

  // 80m live raster or 0-sigma -> Sensitive
  const live80m = classifyScenarioConfidence({ ...nominalInput, is80mLive: true })
  assert.equal(live80m.domains.find(d => d.id === 'terrain')?.tier, 'Sensitive')

  // Partial azimuth coverage or missing regional terrain -> Incomplete
  const partial = classifyScenarioConfidence({ ...nominalInput, complete: false, coveredAzimuths: 201 })
  assert.equal(partial.overall, 'Incomplete')
  assert.equal(partial.domains.find(d => d.id === 'terrain')?.tier, 'Incomplete')

  assert.equal(combinePairConfidence(strong, partial), 'Incomplete')
  assert.equal(combinePairConfidence(strong, borderSlope), 'Sensitive')
  assert.equal(combinePairConfidence(strong, strong), 'Model-supported')

  assert.equal(badgeClassForTier('Model-supported'), 'badge-meets')
  assert.equal(badgeClassForTier('Sensitive'), 'badge-warn')
  assert.equal(badgeClassForTier('Incomplete'), 'badge-exceeds')
  assert.equal(badgeClassForTier('Not modeled'), 'badge-muted')
})
