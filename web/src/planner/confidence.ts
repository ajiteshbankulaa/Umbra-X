export type ConfidenceTier = 'Model-supported' | 'Sensitive' | 'Incomplete' | 'Not modeled'

export interface ScenarioConfidenceInput {
  complete: boolean
  coveredAzimuths?: number
  hasRegionalTerrain: boolean
  is80mLive?: boolean
  slope: number | null
  slopeLimit: number
  longestDark: number
  referenceLongestDark: number
  darkLimit: number
  longestEarth: number
  referenceLongestEarth: number
  earthLimit: number
  feasible: boolean
  unmetWh: number
  headroomKg: number
  sigma: number
}

export interface DomainConfidence {
  id: 'terrain' | 'slope' | 'power' | 'rf_ice'
  label: string
  tier: ConfidenceTier
  reason: string
}

export interface ScenarioConfidenceReport {
  overall: Exclude<ConfidenceTier, 'Not modeled'>
  powerFeasible: boolean
  domains: DomainConfidence[]
  notModeled: string[]
}

export function badgeClassForTier(tier: ConfidenceTier): string {
  if (tier === 'Model-supported') return 'badge-meets'
  if (tier === 'Sensitive') return 'badge-warn'
  if (tier === 'Incomplete') return 'badge-exceeds'
  return 'badge-muted'
}

/**
 * Classify scenario outputs into explicit epistemic confidence tiers:
 * Model-supported, Sensitive, Incomplete, and Not modeled.
 */
export function classifyScenarioConfidence(input: ScenarioConfidenceInput): ScenarioConfidenceReport {
  const extentDeltaDark = Math.abs(input.longestDark - input.referenceLongestDark)
  const extentDeltaEarth = Math.abs(input.longestEarth - input.referenceLongestEarth)
  const darkFlipsLimit = (input.longestDark <= input.darkLimit) !== (input.referenceLongestDark <= input.darkLimit)
  const earthFlipsLimit = (input.longestEarth <= input.earthLimit) !== (input.referenceLongestEarth <= input.earthLimit)
  const extentSensitive = extentDeltaDark > 0.05 || extentDeltaEarth > 0.05 || darkFlipsLimit || earthFlipsLimit

  let terrainTier: Exclude<ConfidenceTier, 'Not modeled'> = 'Model-supported'
  let terrainReason = '96 km 20 m + 80 m LOLA hybrid horizon with 360/360 azimuth coverage.'
  if (!input.hasRegionalTerrain || !input.complete || (input.coveredAzimuths !== undefined && input.coveredAzimuths < 360)) {
    terrainTier = 'Incomplete'
    terrainReason = !input.hasRegionalTerrain
      ? 'Ephemeris-only or local-only footprint; regional 96 km LOLA ridges missing.'
      : `Partial horizon coverage (${input.coveredAzimuths ?? '<360'}/360 azimuths); gaps bias outages optimistically.`
  } else if (input.is80mLive || extentSensitive || input.sigma === 0) {
    terrainTier = 'Sensitive'
    const drivers: string[] = []
    if (extentSensitive) {
      drivers.push(`48 km vs 96 km shifts outages (${extentDeltaDark.toFixed(1)} h dark, ${extentDeltaEarth.toFixed(1)} h Earth)`)
    }
    if (input.is80mLive) {
      drivers.push('80 m live raster smooths sub-80 m local ridges (>1 deg horizon delta observed)')
    }
    if (input.sigma === 0) {
      drivers.push('0-sigma nominal surface omits LOLA vertical uncertainty (>15 h dark swing at 2-3 sigma on rim pads)')
    }
    terrainReason = drivers.join('; ') + '.'
  }

  let slopeTier: Exclude<ConfidenceTier, 'Not modeled'> = 'Model-supported'
  let slopeReason = 'Coarse 20 m LOLA finite-difference slope (lander-scale boulders/craters <20 m not modeled).'
  if (input.slope === null) {
    slopeTier = 'Incomplete'
    slopeReason = 'Slope unavailable for this scenario.'
  } else if (Math.abs(input.slope - input.slopeLimit) <= 0.5) {
    slopeTier = 'Sensitive'
    slopeReason = `Slope ${input.slope.toFixed(2)}° sits within ±0.5° of ${input.slopeLimit}° limit (20 m gradient vs LOLA LDSM differs ~0.2–0.4° RMSE).`
  }

  let powerTier: Exclude<ConfidenceTier, 'Not modeled'> = 'Model-supported'
  let powerReason = 'Deterministic hourly/5-min energy balance over geometry-bounded PV (idealized tracked array & constant load).'
  if (!input.complete) {
    powerTier = 'Incomplete'
    powerReason = 'Unbounded horizon gaps prevent closed power-outage sizing.'
  } else if (!input.feasible || Math.abs(input.headroomKg) <= 5.0 || input.sigma === 0) {
    powerTier = 'Sensitive'
    if (!input.feasible) {
      powerReason = `Power/mass budget fails (unmet ${input.unmetWh.toFixed(0)} Wh, headroom ${input.headroomKg.toFixed(1)} kg) under idealized load.`
    } else if (input.sigma === 0) {
      powerReason = `Zero LOLA height-error margin (0-sigma) and idealized tracked array; headroom ${input.headroomKg.toFixed(1)} kg.`
    } else {
      powerReason = `Narrow mass headroom (${input.headroomKg.toFixed(1)} kg <= 5 kg) under idealized constant load.`
    }
  }

  const domains: DomainConfidence[] = [
    { id: 'terrain', label: 'Terrain & Illumination', tier: terrainTier, reason: terrainReason },
    { id: 'slope', label: '20 m Grid Slope', tier: slopeTier, reason: slopeReason },
    { id: 'power', label: 'Power & Storage', tier: powerTier, reason: powerReason },
    {
      id: 'rf_ice',
      label: 'RF Link & PSR Ice',
      tier: 'Not modeled',
      reason: 'DSN geometric LoS omits RF link budget/scheduling; mapped PSR does not confirm ground-truth water ice.',
    },
  ]

  const activeTiers = [terrainTier, slopeTier, powerTier]
  const overall: Exclude<ConfidenceTier, 'Not modeled'> = activeTiers.includes('Incomplete')
    ? 'Incomplete'
    : activeTiers.includes('Sensitive')
      ? 'Sensitive'
      : 'Model-supported'

  return {
    overall,
    powerFeasible: input.feasible,
    domains,
    notModeled: [
      'RF carrier link margin, multipath, & DSN scheduling',
      'Sub-20 m boulder/crater landing hazards',
      'Regolith thermal transients & battery temperature derating',
      'Surface water-ice abundance inside mapped PSRs',
    ],
  }
}

export function combinePairConfidence(
  baseline: ScenarioConfidenceReport,
  alternative: ScenarioConfidenceReport,
): Exclude<ConfidenceTier, 'Not modeled'> {
  if (baseline.overall === 'Incomplete' || alternative.overall === 'Incomplete') return 'Incomplete'
  if (baseline.overall === 'Sensitive' || alternative.overall === 'Sensitive') return 'Sensitive'
  return 'Model-supported'
}
