import { PassageVectorIndex } from './passageIndex.ts'
import type { Limits, Metadata, Observer, Power, Report, Scenario } from './model'

const DEFAULT_SOLAR_THRESHOLD = 0.1

export interface SourcePassage {
  id: string
  title: string
  citation: string
  url: string
  keywords: string[]
  summary: string
}

export const CURATED_SOURCES: SourcePassage[] = [
  {
    id: 'lola-barker-2023',
    title: 'LRO LOLA South-Pole Topography & Height Uncertainty',
    citation: 'Barker, Mazarico et al. (2023), Planetary Science Journal',
    url: 'https://doi.org/10.3847/PSJ/acf3e1',
    keywords: ['lola', 'terrain', 'elevation', 'slope', 'uncertainty', 'sigma', 'error', 'dem', '20m', '80m', 'psr'],
    summary:
      'LRO LOLA 20 m local and 80 m regional polar DEMs supply elevations referenced to the 1,737,400 m sphere, derived surface slopes, 1-sigma height error maps, and mapped PSR classifications.',
  },
  {
    id: 'lola-extent-96km',
    title: 'Far-Field Ridge Occlusion (48 km vs. 96 km Horizon Extent)',
    citation: 'Glaser et al. (2018), PSS · Umbra-X 96 km Regional Sensitivity',
    url: 'https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf',
    keywords: ['96 km', '48 km', 'horizon', 'ridge', 'shadow', 'extent', 'coverage', 'boundary', 'darkness', 'illumination'],
    summary:
      'Distant crater rims 5–96 km away raise lunar south-polar horizon elevations by 18°–23° compared with a 5.12 km tile. Rays that leave the LDEM_80S boundary return incomplete coverage and cannot verify unobstructed visibility.',
  },
  {
    id: 'jpl-de440-dss14',
    title: 'JPL DE440 Ephemerides & 3-Complex NASA DSN (DSS-14/65/43) Geometric Screen',
    citation: 'JPL DE440 / NAIF MOON_ME_DE440_ME421 & NASA DSN 70m Complexes',
    url: 'https://ssd.jpl.nasa.gov/doc/de440_de441.html',
    keywords: ['earth', 'dte', 'comm', 'communication', 'dss-14', 'dss-65', 'dss-43', 'dsn', 'goldstone', 'madrid', 'canberra', 'complex', 'rf', 'link', 'libration', 'de440', 'horizons'],
    summary:
      'DE440 kernels track 5-minute geometric Sun, Earth, and 3-complex NASA DSN vectors (Goldstone DSS-14, Madrid DSS-63, Canberra DSS-43) including lunar orientation in the DE440 frame. Apparent Sun and Earth directions include light-time and stellar aberration. Candidate station geometry uses a simplified 10 degree Earth-side mask; RF and scheduling are outside the screen.',
  },
  {
    id: 'psr-ice-shadowcam',
    title: 'Permanently Shadowed Regions (PSRs) vs. Verified Water Ice',
    citation: 'Paige et al. (2010), Science · NASA ShadowCam / Li et al. (2026)',
    url: 'https://doi.org/10.1126/sciadv.aec8211',
    keywords: ['psr', 'ice', 'water', 'volatile', 'cold', 'trap', 'shadowcam', 'diviner', 'temperature'],
    summary:
      'A mapped PSR identifies terrain in persistent solar shadow over multi-decade illumination simulations, whereas harvestable water-ice abundance requires independent spectral, neutron, or radar confirmation.',
  },
  {
    id: 'polar-solar-battery',
    title: 'Polar Grazing Sunlight, Array Cosine Losses & Battery Sizing',
    citation: 'Umbra-X Power & Battery Sizing Spec (1.54° Obliquity)',
    url: 'https://pgda.gsfc.nasa.gov/products/90',
    keywords: ['power', 'solar', 'battery', 'array', 'vertical', 'horizontal', 'tracked', 'cosine', 'mass', 'wh', 'kwh', 'cost', 'breakeven'],
    summary:
      'At 1.54 deg lunar obliquity, polar sunlight skims the horizon so horizontal panels suffer severe sin(el) cosine losses relative to vertical masts. Battery mass scales with maximum cumulative net energy deficit at 80% usable depth, 95% one-way efficiency, and a 300 W inverter cap.',
  },
]

const passageIndex = new PassageVectorIndex(CURATED_SOURCES.map(source =>
  [source.title, ...source.keywords, source.summary].join(" "),
))

export interface ScenarioRecordSide {
  label: 'Baseline' | 'Alternative'
  siteId: string
  siteName: string
  node: number
  padNumber: number
  coordinates: [number, number, number]
  mastM: number
  startHourOffset: number
  startUtc: string
  durationDays: number
  hasRegionalTerrain: boolean
  complete: boolean
  coveredAzimuths: number
  solarHours: number
  earthHours: number
  stationHours: number
  dsnHours?: number
  longestDsnBlackout?: number
  dsnDisagreementHours?: number
  dsnComplexHours?: { dss14: number; dss63: number; dss43: number }
  disagreementHours: number
  longestDark: number
  longestEarth: number
  referenceLongestDark: number
  referenceLongestEarth: number
  minSunEl: number
  maxSunEl: number
  minEarthEl: number
  maxEarthEl: number
  slopeDeg: number | null
  psr: number
  usableWh: number
  batteryKg: number
  totalKg: number
  headroomKg: number
  unmetWh: number
  feasible: boolean
  viable: boolean
}

export interface ScenarioComparisonRecord {
  schemaVersion: number
  pairId: string
  baseline: ScenarioRecordSide
  alternative: ScenarioRecordSide
  assumptions: {
    limits: Limits
    power: Power
    stationMaskDeg: number
    solarThresholdFrac: number
    deliveryRatePerKg: number | null
  }
  hashes: {
    baselineVectorHash: string
    baselineLocalHash: string
    baselineRegionalHash: string | null
    alternativeVectorHash: string
    alternativeLocalHash: string
    alternativeRegionalHash: string | null
  }
}

export interface RecordBuildInput {
  report: Report
  pad: Observer
  meta: Metadata
  hasRegionalTerrain: boolean
  siteName: string
}

const formatUtc = (epochIso: string, addHours: number) =>
  new Date(Date.parse(epochIso) + addHours * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

function buildSide(
  label: 'Baseline' | 'Alternative',
  scenario: Scenario,
  input: RecordBuildInput,
  days: number,
  limits: Limits,
): ScenarioRecordSide {
  const { report, pad, meta, hasRegionalTerrain, siteName } = input
  let coveredAzimuths = 0
  for (let i = 0; i < pad.coverage.length; i++) {
    if (pad.coverage[i]) coveredAzimuths++
  }
  const slopeOk = pad.slope !== null && pad.slope <= limits.slope
  const darkOk = report.longestDark <= limits.dark && report.referenceLongestDark <= limits.dark
  const earthOk = report.longestEarth <= limits.earth && report.referenceLongestEarth <= limits.earth
  const viable = Boolean(hasRegionalTerrain && report.complete && slopeOk && darkOk && earthOk)

  return {
    label,
    siteId: scenario.site,
    siteName,
    node: scenario.node,
    padNumber: scenario.node + 1,
    coordinates: [pad.coordinates[0], pad.coordinates[1], pad.coordinates[2]],
    mastM: pad.mast,
    startHourOffset: scenario.start,
    startUtc: formatUtc(meta.start, scenario.start),
    durationDays: days,
    hasRegionalTerrain,
    complete: report.complete,
    coveredAzimuths,
    solarHours: report.solarHours,
    earthHours: report.earthHours,
    stationHours: report.stationHours,
    dsnHours: report.dsnHours ?? report.stationHours,
    longestDsnBlackout: report.longestDsnBlackout ?? report.longestEarth,
    dsnDisagreementHours: report.dsnDisagreementHours ?? report.disagreementHours,
    dsnComplexHours: report.dsnComplexHours ?? { dss14: report.stationHours, dss63: 0, dss43: 0 },
    disagreementHours: report.disagreementHours,
    longestDark: report.longestDark,
    longestEarth: report.longestEarth,
    referenceLongestDark: report.referenceLongestDark,
    referenceLongestEarth: report.referenceLongestEarth,
    minSunEl: report.minSunEl,
    maxSunEl: report.maxSunEl,
    minEarthEl: report.minEarthEl,
    maxEarthEl: report.maxEarthEl,
    slopeDeg: report.slope,
    psr: report.psr,
    usableWh: report.usableWh,
    batteryKg: report.batteryKg,
    totalKg: report.totalKg,
    headroomKg: report.headroomKg,
    unmetWh: report.unmetWh,
    feasible: report.feasible,
    viable,
  }
}

export function buildComparisonRecord(args: {
  scenarios: [Scenario, Scenario]
  items: [RecordBuildInput, RecordBuildInput]
  days: number
  limits: Limits
  power: Power
  solarThresholdFrac?: number
  deliveryRatePerKg?: number | null
}): ScenarioComparisonRecord {
  const baseline = buildSide('Baseline', args.scenarios[0], args.items[0], args.days, args.limits)
  const alternative = buildSide('Alternative', args.scenarios[1], args.items[1], args.days, args.limits)
  const hashes = {
    baselineVectorHash: args.items[0].meta.vectorHash,
    baselineLocalHash: args.items[0].meta.localHash,
    baselineRegionalHash: args.items[0].meta.regional?.regional ?? null,
    alternativeVectorHash: args.items[1].meta.vectorHash,
    alternativeLocalHash: args.items[1].meta.localHash,
    alternativeRegionalHash: args.items[1].meta.regional?.regional ?? null,
  }
  const pairId = [
    baseline.siteId,
    baseline.padNumber,
    baseline.startHourOffset,
    alternative.siteId,
    alternative.padNumber,
    alternative.startHourOffset,
    args.days,
    args.limits.dark,
    args.limits.earth,
    args.limits.slope,
    args.power.arrayW,
    args.power.loadW,
    args.power.arrayMode ?? 'tracked',
    args.power.sigma ?? 0,
    hashes.baselineVectorHash.slice(0, 8),
  ].join('|')

  return {
    schemaVersion: 2,
    pairId,
    baseline,
    alternative,
    assumptions: {
      limits: { ...args.limits },
      power: { ...args.power },
      stationMaskDeg: args.items[0].meta.station.maskDeg,
      solarThresholdFrac: args.solarThresholdFrac ?? DEFAULT_SOLAR_THRESHOLD,
      deliveryRatePerKg: args.deliveryRatePerKg ?? null,
    },
    hashes,
  }
}

export function retrieveSources(query: string, topK = 3): SourcePassage[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9°.\-\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2)
  const qLower = query.toLowerCase()

  const similarity = passageIndex.scores(query)
  const scored = CURATED_SOURCES.map((src, index) => {
    let score = 0
    for (const kw of src.keywords) {
      if (qLower.includes(kw)) score += 4
      else if (tokens.some(t => kw.includes(t) || t.includes(kw))) score += 2
    }
    const hay = `${src.title} ${src.summary}`.toLowerCase()
    for (const t of tokens) {
      if (hay.includes(t)) score += 1
    }
    return { src, score: score + 2 * similarity[index] }
  })
  scored.sort((a, b) => b.score - a.score)
  const positive = scored.filter(x => x.score > 0).slice(0, topK).map(x => x.src)
  return positive.length ? positive : [CURATED_SOURCES[0], CURATED_SOURCES[2]]
}

export interface GroundedAnswer {
  headline: string
  explanation: string
  factsUsed: { label: string; baseline: string; alternative: string }[]
  caveats: string[]
  citations: SourcePassage[]
  recordId: string
}

export const QUICK_QUESTIONS = [
  'Which scenario is safer under the configured limits and why?',
  'How does the launch time or site shift affect Earth communication blackouts?',
  'Does Earth or DSS-14 visibility guarantee a working radio link?',
  'Explain solar power, array orientation cosine losses, and battery mass (in kWh).',
  'Does a mapped PSR guarantee extractable water ice here?',
  'Are all horizon rays complete and unaffected by the 80°S terrain boundary?',
]

const n = (v: number, digits = 1) => v.toFixed(digits)
const sNum = (v: number, digits = 1) => (v >= 0 ? '+' : '') + v.toFixed(digits)

function formatSideName(side: ScenarioRecordSide) {
  return side.hasRegionalTerrain ? `${side.siteName} Pad #${side.padNumber} (${side.startUtc})` : `${side.siteName} (${side.startUtc})`
}

export function summarizeComparison(record: ScenarioComparisonRecord): string {
  const { baseline: a, alternative: b } = record
  const darkDelta = b.longestDark - a.longestDark
  const earthDelta = b.longestEarth - a.longestEarth
  const battDelta = b.batteryKg - a.batteryKg
  const verdict =
    b.viable && !a.viable
      ? `Alternative (${b.siteName} Pad #${b.padNumber}) turns a non-viable baseline into a viable option.`
      : a.viable && !b.viable
        ? `Baseline (${a.siteName} Pad #${a.padNumber}) remains viable whereas Alternative fails a constraint.`
        : b.viable && a.viable
          ? 'Both scenarios meet all geometry limits across 48 km and 96 km horizons.'
          : 'Neither scenario satisfies every geometry constraint yet (use Find Optimal Windows or adjust start/pad).'

  return `${verdict} Switching to Alternative shifts longest low-light by ${sNum(darkDelta)} h (${n(a.longestDark)} h -> ${n(b.longestDark)} h), Earth obstruction by ${sNum(earthDelta)} h (${n(a.longestEarth)} h -> ${n(b.longestEarth)} h), and required battery mass by ${sNum(battDelta)} kg.`
}

export function answerScenarioQuestion(record: ScenarioComparisonRecord, question: string): GroundedAnswer {
  const q = question.toLowerCase()
  const { baseline: a, alternative: b, assumptions } = record
  const citations = retrieveSources(question, 3)

  const wantsKwh = /\bkwh\b/.test(q)
  const wantsKw = /\bkw\b/.test(q) && !/\bkwh\b/.test(q)
  const wantsRad = /\brad(ian|ians)?\b/.test(q)
  const asksRfLink = /\b(rf|radio|working link|guarantee.*link|link budget|bitrate|antenna|schedule|dss-?14|dss-?65|dss-?43|dsn|goldstone|madrid|canberra|station|complex)\b/.test(q)
  const asksPsrIce = /\b(ice|water|volatile|psr|shadowed region)\b/.test(q)
  const asksCoverage = /\b(coverage|boundary|80°?s|80s|complete|missing|partial|clip|unsupported|level horizon|custom)\b/.test(q)
  const asksPower = /\b(power|battery|mass|kwh|wh|watt|kw|array|cosine|vertical|horizontal|tracked|load|unmet|cost|budget)\b/.test(q)
  const asksEarth = /\b(earth|blackout|obstruction|libration|dte|comm)\b/.test(q)

  const formatEnergy = (wh: number) => (wantsKwh ? `${n(wh / 1000, 2)} kWh` : `${n(wh, 0)} Wh`)
  const formatPower = (w: number) => (wantsKw ? `${n(w / 1000, 2)} kW` : `${n(w, 0)} W`)
  const formatAngle = (deg: number) => (wantsRad ? `${n((deg * Math.PI) / 180, 4)} rad` : `${n(deg, 1)} deg`)

  const caveats: string[] = []
  if (!a.complete || !b.complete || !a.hasRegionalTerrain || !b.hasRegionalTerrain) {
    const partialNotes: string[] = []
    for (const side of [a, b]) {
      if (!side.hasRegionalTerrain) {
        partialNotes.push(`${side.label} (${side.siteName}) uses a 0 deg level-sphere horizon without LOLA 96 km terrain peaks`)
      } else if (!side.complete) {
        partialNotes.push(`${side.label} (${side.siteName} Pad #${side.padNumber}) has incomplete regional coverage (${side.coveredAzimuths}/360 azimuths covered) and must be excluded from verified recommendations`)
      }
    }
    caveats.push(...partialNotes)
  }

  const factsUsed: GroundedAnswer['factsUsed'] = [
    {
      label: 'Longest low-light',
      baseline: `${n(a.longestDark)} h (limit <= ${assumptions.limits.dark} h)`,
      alternative: `${n(b.longestDark)} h (${sNum(b.longestDark - a.longestDark)} h)`,
    },
    {
      label: 'Longest Earth obstruction',
      baseline: `${n(a.longestEarth)} h (limit <= ${assumptions.limits.earth} h)`,
      alternative: `${n(b.longestEarth)} h (${sNum(b.longestEarth - a.longestEarth)} h)`,
    },
    {
      label: 'Terrain slope & coverage',
      baseline: `${a.slopeDeg === null ? 'N/A (level sphere)' : formatAngle(a.slopeDeg)} · ${a.coveredAzimuths}/360 az`,
      alternative: `${b.slopeDeg === null ? 'N/A (level sphere)' : formatAngle(b.slopeDeg)} · ${b.coveredAzimuths}/360 az`,
    },
    {
      label: wantsKwh ? 'Required storage (kWh) & battery' : 'Required storage & battery',
      baseline: `${formatEnergy(a.usableWh)} · ${n(a.batteryKg)} kg`,
      alternative: `${formatEnergy(b.usableWh)} · ${n(b.batteryKg)} kg`,
    },
  ]

  if (asksRfLink) {
    const aDsn = a.dsnHours ?? a.stationHours
    const bDsn = b.dsnHours ?? b.stationHours
    const aDsnGap = a.dsnDisagreementHours ?? a.disagreementHours
    const bDsnGap = b.dsnDisagreementHours ?? b.disagreementHours
    caveats.push(
      `Geometric screening only: 3-complex NASA DSN (Goldstone DSS-14, Madrid DSS-63, Canberra DSS-43) access checks lunar terrain clearance plus a >=${assumptions.stationMaskDeg} deg Earth-station horizon mask. Actual RF link budget, EIRP/noise margin, DSN scheduling conflicts and station-specific masks are not modeled.`,
    )
    factsUsed.push({
      label: 'Earth vs. 3-Complex DSN & DSS-14',
      baseline: `${n(a.earthHours)} h Earth / ${n(aDsn)} h DSN (${n(a.stationHours)} h DSS-14, ${n(aDsnGap)} h DSN gap)`,
      alternative: `${n(b.earthHours)} h Earth / ${n(bDsn)} h DSN (${n(b.stationHours)} h DSS-14, ${n(bDsnGap)} h DSN gap)`,
    })
    return {
      headline: 'No — geometric Earth/DSS-14 visibility is necessary, not sufficient, for an operational RF link (even across 3-complex NASA DSN).',
      explanation: `${formatSideName(a)} sees Earth center for ${n(a.earthHours)} h, reaches >=${assumptions.stationMaskDeg} deg across the 3-complex NASA DSN (DSS-14/65/43) for ${n(aDsn)} h (${n(aDsnGap)} h DSN vs. Earth-center difference), and sees Goldstone DSS-14 alone for ${n(a.stationHours)} h (${n(a.disagreementHours)} h DSS-14 gap). ${formatSideName(b)} provides ${n(b.earthHours)} h Earth center, ${n(bDsn)} h 3-complex DSN, and ${n(b.stationHours)} h DSS-14 geometry. Real operations still require an RF link budget, antenna pointing, and DSN schedule allocation.`,
      factsUsed,
      caveats,
      citations,
      recordId: record.pairId,
    }
  }

  if (asksPsrIce) {
    caveats.push(
      'Mapped PSR classification follows Barker et al. (2023) multi-year LOLA illumination modeling; volatile or water-ice concentration requires independent neutron, bistatic radar, or spectral evidence.',
    )
    return {
      headline: 'No — a mapped PSR indicates persistent geometric shadow, not confirmed harvestable water ice.',
      explanation: `Baseline (${a.siteName}) is classified as ${a.hasRegionalTerrain ? (a.psr ? 'inside a mapped LOLA PSR (PSR=1)' : 'outside mapped PSR boundaries (PSR=0)') : 'a non-polar / level-horizon reference without polar PSR mapping'}, while Alternative (${b.siteName}) is ${b.hasRegionalTerrain ? (b.psr ? 'inside a mapped LOLA PSR (PSR=1)' : 'outside mapped PSR boundaries (PSR=0)') : 'without polar PSR mapping'}. Note also that a 30-day ephemeris window alone cannot establish permanent shadow.`,
      factsUsed,
      citations,
      caveats,
      recordId: record.pairId,
    }
  }

  if (asksCoverage) {
    return {
      headline:
        a.complete && b.complete && a.hasRegionalTerrain && b.hasRegionalTerrain
          ? 'Both scenarios have complete 360/360-azimuth 96 km LOLA regional coverage.'
          : 'At least one scenario lacks complete 96 km LOLA regional coverage and is treated as preliminary.',
      explanation: `${formatSideName(a)} has ${a.hasRegionalTerrain ? `${a.coveredAzimuths}/360` : '0/360 regional'} terrain-ray azimuths inside LDEM_80S (${a.complete ? 'complete' : 'partial boundary coverage — rays hit the 80°S edge or level fallback'}). ${formatSideName(b)} has ${b.hasRegionalTerrain ? `${b.coveredAzimuths}/360` : '0/360 regional'} terrain-ray azimuths (${b.complete ? 'complete' : 'partial'}). Any coordinate without 360/360 regional coverage is excluded from verified viability recommendations.`,
      factsUsed,
      caveats,
      citations,
      recordId: record.pairId,
    }
  }

  if (asksPower) {
    const mode = assumptions.power.arrayMode ?? 'tracked'
    const unmetNote =
      a.unmetWh > 0 || b.unmetWh > 0
        ? ` Unmet load occurs: Baseline ${formatEnergy(a.unmetWh)}, Alternative ${formatEnergy(b.unmetWh)} under the ${n(assumptions.power.budgetKg)} kg mass budget.`
        : ` Both scenarios meet the ${formatPower(assumptions.power.loadW)} load inside the ${n(assumptions.power.budgetKg)} kg mass budget.`
    return {
      headline: `Modeled with a ${formatPower(assumptions.power.arrayW)} ${mode} array against a ${formatPower(assumptions.power.loadW)} load.`,
      explanation: `${formatSideName(a)} requires ${formatEnergy(a.usableWh)} of usable battery (${n(a.batteryKg)} kg battery; ${n(a.totalKg)} kg installed mass) over a ${n(a.longestDark)} h longest darkness window. ${formatSideName(b)} requires ${formatEnergy(b.usableWh)} (${n(b.batteryKg)} kg battery; ${n(b.totalKg)} kg installed mass; delta ${sNum(b.totalKg - a.totalKg)} kg). Solar elevations span ${formatAngle(a.minSunEl)} to ${formatAngle(a.maxSunEl)} (Baseline) vs. ${formatAngle(b.minSunEl)} to ${formatAngle(b.maxSunEl)} (Alternative).${unmetNote}`,
      factsUsed,
      caveats,
      citations,
      recordId: record.pairId,
    }
  }

  if (asksEarth) {
    const deltaEarth = b.longestEarth - a.longestEarth
    return {
      headline: `Alternative changes longest continuous Earth obstruction by ${sNum(deltaEarth)} h (${n(a.longestEarth)} h -> ${n(b.longestEarth)} h).`,
      explanation: `During ${formatSideName(a)}, Earth center is visible ${n(a.earthHours)} h total with a worst single blackout of ${n(a.longestEarth)} h (Earth elevation ${formatAngle(a.minEarthEl)} to ${formatAngle(a.maxEarthEl)}). Switching to ${formatSideName(b)} gives ${n(b.earthHours)} h total Earth visibility and a worst blackout of ${n(b.longestEarth)} h (${deltaEarth <= 0 ? 'improvement' : 'longer blackout'} by ${n(Math.abs(deltaEarth))} h) due to Moon optical libration relative to distant ridges.`,
      factsUsed,
      caveats,
      citations,
      recordId: record.pairId,
    }
  }

  return {
    headline:
      a.viable && !b.viable
        ? `Baseline (${a.siteName} Pad #${a.padNumber}) is the safer verified option under current limits.`
        : b.viable && !a.viable
          ? `Alternative (${b.siteName} Pad #${b.padNumber}) is the safer verified option under current limits.`
          : b.viable && a.viable
            ? 'Both scenarios meet all configured geometry thresholds; compare battery mass and DTE hours.'
            : 'Neither scenario passes every configured threshold yet — inspect slope, darkness, and coverage below.',
    explanation: summarizeComparison(record),
    factsUsed,
    caveats,
    citations,
    recordId: record.pairId,
  }
}
