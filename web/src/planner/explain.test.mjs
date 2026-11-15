import test from 'node:test'
import assert from 'node:assert/strict'
import {
  answerScenarioQuestion,
  buildComparisonRecord,
  CURATED_SOURCES,
  QUICK_QUESTIONS,
  retrieveSources,
  summarizeComparison,
} from './explain.ts'
import { defaultPower } from './model.ts'

function makeSideReport(opts = {}) {
  const {
    solarHours = 280,
    earthHours = 210,
    stationHours = 110,
    disagreementHours = 100,
    longestDark = 52.8,
    longestEarth = 103.7,
    minSunEl = -1.2,
    maxSunEl = 2.4,
    minEarthEl = -5.1,
    maxEarthEl = 6.2,
    slope = 4.1,
    psr = 0,
    complete = true,
    usableWh = 5400,
    batteryKg = 45,
    totalKg = 65,
    headroomKg = 35,
    unmetWh = 0,
    feasible = true,
  } = opts
  const dark = opts.longestDark ?? 52.8
  const earth = opts.longestEarth ?? 103.7
  return {
    sky: [],
    dark: [],
    earth: [],
    station: [],
    generation: [],
    solarHours,
    earthHours,
    stationHours,
    dsnHours: opts.dsnHours,
    dsnDisagreementHours: opts.dsnDisagreementHours,
    disagreementHours,
    longestDark,
    longestEarth,
    referenceLongestDark: opts.referenceLongestDark ?? dark,
    referenceLongestEarth: opts.referenceLongestEarth ?? earth,
    minSunEl,
    maxSunEl,
    minEarthEl,
    maxEarthEl,
    slope,
    psr,
    complete,
    referenceDark: 0,
    referenceEarth: 0,
    usableWh,
    batteryKg,
    totalKg,
    headroomKg,
    unmetWh,
    feasible,
    soc: [1],
  }
}

function makeObserver({ coordinates = [-89.45, -138.0, 2100], mast = 5, slope = 4.1, psr = 0, covered = 360 } = {}) {
  const coverage = new Uint8Array(360)
  coverage.fill(1, 0, covered)
  return {
    coordinates,
    horizon: new Float32Array(360),
    reference: new Float32Array(360),
    distance: new Float32Array(360),
    coverage,
    mast,
    slope,
    psr,
  }
}

const meta = {
  schema: 1,
  start: '2026-11-14T00:00:00Z',
  stepMinutes: 5,
  count: 8641,
  vectorHash: 'aaaa1111bbbb2222cccc3333dddd4444aaaa1111bbbb2222cccc3333dddd4444',
  localHash: '1111222233334444555566667777888811112222333344445555666677778888',
  frame: 'MOON_ME_DE440_ME421',
  station: { name: 'Goldstone DSS-14', maskDeg: 10, source: 'https://naif.jpl.nasa.gov' },
  kernels: {},
  observers: [],
  regional: {
    radiusM: 96000,
    comparisonRadiusM: 48000,
    source: 'LOLA',
    regional: '9999888877776666',
    distance: '1',
    coverage: '2',
    sensitivity: '3',
  },
}

function buildSampleRecord(overridesA = {}, overridesB = {}, opts = {}) {
  const scenarios = opts.scenarios ?? [
    { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
    { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
  ]
  return buildComparisonRecord({
    scenarios,
    items: [
      {
        report: makeSideReport(overridesA.report),
        pad: makeObserver(overridesA.pad),
        meta,
        hasRegionalTerrain: overridesA.hasRegionalTerrain ?? true,
        siteName: overridesA.siteName ?? 'Shackleton Ridge',
      },
      {
        report: makeSideReport({ longestEarth: 55.7, ...overridesB.report }),
        pad: makeObserver(overridesB.pad),
        meta,
        hasRegionalTerrain: overridesB.hasRegionalTerrain ?? true,
        siteName: overridesB.siteName ?? 'Shackleton Ridge',
      },
    ],
    days: 15,
    limits: { dark: 48, earth: 72, slope: 5 },
    power: opts.power ?? defaultPower,
    deliveryRatePerKg: opts.rate ?? null,
  })
}

// 22+ Labeled Evaluation Cases
const cases = [
  {
    name: '01: Earth launch delay numbers reflect exact baseline vs alternative values',
    build: () => buildSampleRecord(),
    q: 'How does the 48h launch delay change Earth blackouts?',
    check: ans => {
      assert.match(ans.headline, /-48\.0 h \(103\.7 h -> 55\.7 h\)/)
      assert.equal(ans.citations.some(c => c.id === 'jpl-de440-dss14' || c.id === 'lola-extent-96km'), true)
    },
  },
  {
    name: '02: Swapping baseline and alternative reverses sign without stale cache',
    build: () =>
      buildSampleRecord(
        { report: { longestEarth: 55.7 } },
        { report: { longestEarth: 103.7 } },
        {
          scenarios: [
            { site: 'shackleton-ridge', node: 480, start: 48, mast: 2 },
            { site: 'shackleton-ridge', node: 480, start: 0, mast: 2 },
          ],
        },
      ),
    q: 'How does switching change Earth blackouts?',
    check: ans => {
      assert.match(ans.headline, /\+48\.0 h \(55\.7 h -> 103\.7 h\)/)
    },
  },
  {
    name: '03: RecordId updates cleanly when dates change (no cross-scenario cache)',
    build: () => [
      buildSampleRecord(),
      buildSampleRecord(
        { report: { longestEarth: 90.2 } },
        { report: { longestEarth: 42.1 } },
        {
          scenarios: [
            { site: 'shackleton-ridge', node: 480, start: 24, mast: 2 },
            { site: 'shackleton-ridge', node: 480, start: 72, mast: 2 },
          ],
        },
      ),
    ],
    q: 'Which is better for Earth DTE?',
    check: (_ans, recs) => {
      const [r1, r2] = recs
      const a1 = answerScenarioQuestion(r1, 'How does Earth blackout change?')
      const a2 = answerScenarioQuestion(r2, 'How does Earth blackout change?')
      assert.notEqual(a1.recordId, a2.recordId)
      assert.match(a1.headline, /103\.7 h -> 55\.7 h/)
      assert.match(a2.headline, /90\.2 h -> 42\.1 h/)
    },
  },
  {
    name: '04: Geometric DSS-14 visibility explicitly denies RF link guarantee',
    build: () => buildSampleRecord(),
    q: 'Does Goldstone DSS-14 visibility guarantee a working RF link?',
    check: ans => {
      assert.match(ans.headline, /^No — geometric Earth\/DSS-14 visibility is necessary, not sufficient/i)
      assert.match(ans.explanation, /110\.0 h/)
      assert.ok(ans.caveats.some(c => /link budget/i.test(c) && /scheduling/i.test(c)))
    },
  },
  {
    name: '05: Mapped PSR explicitly denies confirmed extractable water ice',
    build: () => buildSampleRecord({ report: { psr: 1 }, pad: { psr: 1 } }),
    q: 'Does mapped PSR=1 prove there is extractable water ice here?',
    check: ans => {
      assert.match(ans.headline, /^No — a mapped PSR indicates persistent geometric shadow/i)
      assert.match(ans.explanation, /PSR=1/)
      assert.ok(ans.caveats.some(c => /neutron|radar|spectral/i.test(c)))
    },
  },
  {
    name: '06: Incomplete 80S boundary coverage flags partial azimuths and excludes verification',
    build: () => buildSampleRecord({ report: { complete: false }, pad: { covered: 284 } }),
    q: 'Is regional terrain coverage complete across 360 azimuths?',
    check: ans => {
      assert.match(ans.headline, /lacks complete 96 km LOLA/i)
      assert.match(ans.explanation, /284\/360/)
      assert.ok(ans.caveats.some(c => /284\/360/i.test(c) && /excluded/i.test(c)))
    },
  },
  {
    name: '07: Level-sphere custom coordinate flags 0 deg fallback cleanly',
    build: () => buildSampleRecord({ hasRegionalTerrain: false, siteName: 'Custom Coordinates', report: { slope: null } }),
    q: 'Is my custom coordinate using 96 km LOLA horizon coverage?',
    check: ans => {
      assert.match(ans.headline, /lacks complete/i)
      assert.ok(ans.caveats.some(c => /0 deg level-sphere horizon/i.test(c)))
    },
  },
  {
    name: '08: Unit conversion Wh -> kWh when prompt asks in kWh',
    build: () => buildSampleRecord({ report: { usableWh: 5400 } }, { report: { usableWh: 2700 } }),
    q: 'How much battery storage is needed in kWh?',
    check: ans => {
      assert.match(ans.explanation, /5\.40 kWh/)
      assert.match(ans.explanation, /2\.70 kWh/)
    },
  },
  {
    name: '09: Unit conversion W -> kW when prompt asks in kW',
    build: () => buildSampleRecord({}, {}, { power: { ...defaultPower, arrayW: 1200, loadW: 300 } }),
    q: 'Compare array power in kW and load requirements.',
    check: ans => {
      assert.match(ans.headline, /1\.20 kW/)
      assert.match(ans.headline, /0\.30 kW/)
    },
  },
  {
    name: '10: Unit conversion deg -> rad when prompt asks in radians',
    build: () => buildSampleRecord({ report: { minSunEl: -2.0, maxSunEl: 3.0 } }),
    q: 'Report solar power angles and slope in radians.',
    check: ans => {
      assert.match(ans.factsUsed.find(f => f.label.includes('slope'))?.baseline ?? '', /rad/)
      assert.match(ans.explanation, /rad/)
    },
  },
  {
    name: '11: Viable alternative turns failing baseline into verified safe option',
    build: () =>
      buildSampleRecord(
        { report: { longestDark: 52.8, longestEarth: 103.7, slope: 5.6 }, pad: { slope: 5.6 } },
        { report: { longestDark: 31.2, longestEarth: 42.0, slope: 3.4 }, pad: { slope: 3.4 }, siteName: 'Mons Mouton' },
      ),
    q: 'Which scenario is safer under the configured limits?',
    check: ans => {
      assert.match(ans.headline, /Alternative \(Mons Mouton Pad #481\) is the safer verified option/)
      assert.match(ans.explanation, /-21\.6 h/)
    },
  },
  {
    name: '12: Viable baseline vs failing alternative identifies Baseline as safer',
    build: () =>
      buildSampleRecord(
        { report: { longestDark: 24.0, longestEarth: 36.0, slope: 2.5 }, pad: { slope: 2.5 } },
        { report: { longestDark: 80.0, longestEarth: 90.0, slope: 6.2 }, pad: { slope: 6.2 } },
      ),
    q: 'Which option is safer?',
    check: ans => {
      assert.match(ans.headline, /Baseline \(Shackleton Ridge Pad #481\) is the safer verified option/)
    },
  },
  {
    name: '13: Neither viable refuses to recommend either and flags threshold checks',
    build: () =>
      buildSampleRecord(
        { report: { longestDark: 52.8, longestEarth: 103.7, slope: 5.6 }, pad: { slope: 5.6 } },
        { report: { longestDark: 52.8, longestEarth: 55.7, slope: 5.6 }, pad: { slope: 5.6 } },
      ),
    q: 'Which scenario meets all constraints?',
    check: ans => {
      assert.match(ans.headline, /Neither scenario passes every configured threshold/)
    },
  },
  {
    name: '14: Both viable confirms both meet geometry limits',
    build: () =>
      buildSampleRecord(
        { report: { longestDark: 30, longestEarth: 40, slope: 3 }, pad: { slope: 3 } },
        { report: { longestDark: 25, longestEarth: 35, slope: 2 }, pad: { slope: 2 } },
      ),
    q: 'Which option passes all thresholds?',
    check: ans => {
      assert.match(ans.headline, /Both scenarios meet all configured geometry thresholds/)
    },
  },
  {
    name: '15: Unmet load warning surfaces explicitly in power summary',
    build: () => buildSampleRecord({ report: { unmetWh: 1450, feasible: false } }),
    q: 'How is our battery power and unmet load budget looking?',
    check: ans => {
      assert.match(ans.explanation, /Unmet load occurs: Baseline 1450 Wh/)
    },
  },
  {
    name: '16: Array orientation mode (vertical vs horizontal) appears in power headline',
    build: () => buildSampleRecord({}, {}, { power: { ...defaultPower, arrayMode: 'vertical' } }),
    q: 'How does array orientation affect power generation?',
    check: ans => {
      assert.match(ans.headline, /vertical array/)
    },
  },
  {
    name: '17: Complete 360/360 polar coverage confirms verified coverage',
    build: () => buildSampleRecord(),
    q: 'Confirm whether horizon coverage is complete.',
    check: ans => {
      assert.match(ans.headline, /complete 360\/360-azimuth 96 km LOLA/)
      assert.equal(ans.caveats.length, 0)
    },
  },
  {
    name: '18: Lexical retrieval prioritizes LOLA height uncertainty on sigma query',
    build: () => buildSampleRecord(),
    q: 'Why does LOLA 2-sigma height uncertainty matter?',
    check: () => {
      const hits = retrieveSources('Why does LOLA 2-sigma height uncertainty matter?', 2)
      assert.equal(hits[0].id, 'lola-barker-2023')
    },
  },
  {
    name: '19: Lexical retrieval prioritizes Glaser 96 km extent on ridge occlusion query',
    build: () => buildSampleRecord(),
    q: 'Why does 96 km ridge terrain matter more than 48 km?',
    check: () => {
      const hits = retrieveSources('Why does 96 km ridge terrain matter more than 48 km?', 2)
      assert.equal(hits[0].id, 'lola-extent-96km')
    },
  },
  {
    name: '20: Lexical retrieval prioritizes JPL DE440 / DSS-14 on comm query',
    build: () => buildSampleRecord(),
    q: 'Explain Goldstone DSS-14 Earth libration RF visibility.',
    check: () => {
      const hits = retrieveSources('Explain Goldstone DSS-14 Earth libration RF visibility.', 2)
      assert.equal(hits[0].id, 'jpl-de440-dss14')
    },
  },
  {
    name: '21: summarizeComparison calculates exact dark, earth, and battery deltas',
    build: () =>
      buildSampleRecord(
        { report: { longestDark: 50, longestEarth: 100, batteryKg: 60 } },
        { report: { longestDark: 35, longestEarth: 45, batteryKg: 42 } },
      ),
    q: 'summary check',
    check: (_ans, rec) => {
      const s = summarizeComparison(rec)
      assert.match(s, /-15\.0 h \(50\.0 h -> 35\.0 h\)/)
      assert.match(s, /-55\.0 h \(100\.0 h -> 45\.0 h\)/)
      assert.match(s, /-18\.0 kg/)
    },
  },
  {
    name: '22: All QUICK_QUESTIONS yield non-empty grounded answers with source links',
    build: () => buildSampleRecord({ report: { slope: 3.2 }, pad: { slope: 3.2 } }, { report: { slope: 2.8 }, pad: { slope: 2.8 } }),
    q: 'all quick questions',
    check: (_ans, rec) => {
      assert.ok(CURATED_SOURCES.length >= 5)
      for (const qq of QUICK_QUESTIONS) {
        const res = answerScenarioQuestion(rec, qq)
        assert.ok(res.headline.length > 10)
        assert.ok(res.explanation.length > 20)
        assert.ok(res.citations.length >= 1)
        assert.equal(res.recordId, rec.pairId)
      }
    },
  },
  {
    name: '23: 3-complex NASA DSN metrics surface alongside DSS-14 in RF link evaluation',
    build: () => buildSampleRecord(
      { report: { earthHours: 210, stationHours: 110, dsnHours: 205, dsnDisagreementHours: 5 } },
      { report: { earthHours: 230, stationHours: 120, dsnHours: 226, dsnDisagreementHours: 4 } },
    ),
    q: 'How does 3-complex DSN visibility compare to DSS-14?',
    check: ans => {
      assert.match(ans.explanation, /205\.0 h 3-complex DSN|205\.0 h/i)
      assert.match(ans.explanation, /226\.0 h 3-complex DSN/i)
      assert.ok(ans.factsUsed.some(f => /3-Complex DSN/i.test(f.label) && /205\.0 h DSN/.test(f.baseline)))
    },
  },
]

test(`Phase 3 evaluation suite passes all ${cases.length} scenario-grounded Q&A cases with zero numeric drift`, () => {
  for (const tc of cases) {
    const built = tc.build()
    if (Array.isArray(built)) {
      tc.check(null, built)
    } else {
      const ans = answerScenarioQuestion(built, tc.q)
      tc.check(ans, built)
    }
  }
})
