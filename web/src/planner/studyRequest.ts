import type { Limits, Scenario } from './model'

export const studySites = [
  ['Shackleton Ridge', 'shackleton-ridge'],
  ['Mons Mouton', 'mons-mouton'],
  ['Malapert Massif', 'malapert-massif'],
] as const

export const studyExamples = [
  { label: 'Find sites and dates within my limits', question: 'Search Mons Mouton for a 15-day mission with low light <= 48 h and Earth obstruction <= 72 h.' },
  { label: 'Compare two sites over time', question: 'Compare Shackleton and Mons Mouton for 15 days.' },
  { label: 'See where terrain extent changes the answer', question: 'Compare the current pad with 48 km and 96 km terrain.' },
]

type StudyContext = {
  scenarios: [Scenario, Scenario]
  active: number
  days: number
  limits: Limits
  epoch: string
  hours: number
}

export type StudyPlan =
  | { kind: 'search'; sites: string[]; days: number; limits: Limits; mast: number; from: number; through: number }
  | { kind: 'compare'; scenarios: [Scenario, Scenario]; days: number }
  | { kind: 'terrain'; scenarios?: [Scenario]; days?: number }

export type StudyInterpretation =
  | { status: 'ready'; plan: StudyPlan }
  | { status: 'clarify' | 'coverage' | 'unsupported'; message: string }

export function interpretStudy(input: string, context: StudyContext): StudyInterpretation {
  const query = input.trim().toLowerCase()
  const selected = context.scenarios[context.active]
  const polar = studySites.some(([, id]) => id === selected.site)
  if (!query) return { status: 'clarify', message: 'What would you like to compare or search?' }
  if (/\b(?:link budget|rf|relay|landing safety|ice extraction|battery|temperature|thermal|power budget)\b/.test(query)) {
    return { status: 'unsupported', message: 'This study tool screens terrain, sunlight and Earth-center visibility. Use the manual power panel for an energy estimate or choose a geometry study below.' }
  }
  if (/\b(?:year|years|annual|month|months|tomorrow|next week|next month|today|whole moon|any two points|coordinates)\b/.test(query)) {
    return { status: 'coverage', message: 'The bundled study tools cover a 30-day ephemeris window and three terrain-backed polar grids. Try two supported pads or dates within the shown window.' }
  }
  if (/\b(?:then|after that|rerun|re-run)\b/.test(query)) {
    return { status: 'unsupported', message: 'Run one study at a time. Start with a search, open a candidate, then ask to compare its 48 km and 96 km horizons.' }
  }
  if (/\b(?:terrain|coarse|finer|resolution)\b/.test(query) && !/\b(?:search|find)\b/.test(query)) {
    if (!polar) return { status: 'coverage', message: 'Select a terrain-backed polar pad before comparing 48 km and 96 km horizons.' }
    if (/\b(?:resolution|finer|coarse)\b/.test(query) && !/48\s*km.*96\s*km|96\s*km.*48\s*km/.test(query)) {
      return { status: 'coverage', message: 'The available comparison varies terrain extent from 48 km to 96 km. Choose the terrain example to inspect that sensitivity at the selected pad.' }
    }
    if (!/48\s*km.*96\s*km|96\s*km.*48\s*km/.test(query)) {
      return { status: 'clarify', message: 'Which terrain comparison? Try 48 km versus 96 km at the current pad.' }
    }
    return { status: 'ready', plan: { kind: 'terrain' } }
  }
  const duration = query.match(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*days?\b/)
  const days = duration ? Number(duration[1]) : context.days
  if (!Number.isInteger(days) || days < 1 || days > 15) {
    return { status: 'coverage', message: 'Choose a whole mission duration from 1 to 15 days.' }
  }
  const latest = context.hours - days * 24
  const dates = [...query.matchAll(/\b(\d{4}-\d{2}-\d{2})(?:t(\d{2}):00(?:z)?)?\b/g)]
  if (/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:(?!00(?:z)?(?:\s|$|[.,]))\d{2}/.test(query)) {
    return { status: 'clarify', message: 'Use an hourly UTC start, such as 2026-11-16T08:00Z.' }
  }
  const starts = dates.map(([, day, hour]) => {
    const iso = day + 'T' + (hour ?? '00') + ':00:00Z'
    const time = Date.parse(iso)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 13) === iso.slice(0, 13)
      ? (time - Date.parse(context.epoch)) / 3600000 : NaN
  })
  if (starts.some(hour => !Number.isInteger(hour) || hour < 0 || hour > latest)) {
    return { status: 'coverage', message: 'At least one requested UTC start falls outside the available window for that mission duration.' }
  }
  const sites = studySites.flatMap(([label, id]) => {
    const alias = label.toLowerCase().split(' ')[0]
    const index = query.search(new RegExp('\\b' + alias + '\\b'))
    return index >= 0 ? [{ id, index }] : []
  }).sort((a, b) => a.index - b.index).map(item => item.id)

  if (/\b(?:search|find)\b/.test(query)) {
    if (!sites.length && !/\b(?:this area|current region|all (?:three|polar) regions)\b/.test(query)) {
      return { status: 'clarify', message: 'Which region? Choose Shackleton, Mons Mouton, Malapert, or all three polar regions.' }
    }
    const targets = sites.length ? sites : /\ball\b/.test(query) ? studySites.map(([, id]) => id) : polar ? [selected.site] : []
    if (!targets.length) return { status: 'coverage', message: 'The selected site has no compiled search grid. Choose one of the three polar regions.' }
    if (starts.length > 2 || (starts.length === 2 && starts[0] > starts[1])) {
      return { status: 'clarify', message: 'Provide up to two UTC dates in chronological order.' }
    }
    const limits = { ...context.limits }
    const patterns = [
      ['dark', /(?:low light|darkness)\s*(?:<=|≤|under|at most)\s*(\d+(?:\.\d+)?)\s*(?:h|hours?)\b/],
      ['earth', /earth(?:-center)? obstruction\s*(?:<=|≤|under|at most)\s*(\d+(?:\.\d+)?)\s*(?:h|hours?)\b/],
      ['slope', /slope\s*(?:<=|≤|under|at most)\s*(\d+(?:\.\d+)?)\s*(?:°|degrees?)/],
    ] as const
    const statedLimits = [/\b(?:low light|darkness)\b/, /\bearth(?:-center)? obstruction\b/, /\bslope\b/]
    for (const [i, [key, pattern]] of patterns.entries()) {
      const match = query.match(pattern)
      if (!match && statedLimits[i].test(query)) {
        return { status: 'clarify', message: 'Write limits as “low light <= 48 h”, “Earth obstruction <= 72 h”, or “slope <= 5 degrees”. Omitted limits use the manual planner settings.' }
      }
      if (match) limits[key] = Number(match[1])
    }
    if (limits.slope > 90) return { status: 'clarify', message: 'Choose a slope limit between 0 and 90 degrees.' }
    return { status: 'ready', plan: { kind: 'search', sites: targets, days, limits, mast: selected.mast,
      from: starts[0] ?? 0, through: starts.at(-1) ?? latest } }
  }
  if (/\bcompare\b/.test(query)) {
    if (/\b(?:pad|pads)\s*#?\d+\b/.test(query)) {
      return { status: 'clarify', message: 'Select the numbered pads in Manual, then ask to compare the current scenarios. Named regions in Ask use their center pads.' }
    }
    if (sites.length > 2 || starts.length > 2) return { status: 'clarify', message: 'Choose two scenarios to compare.' }
    if (sites.length < 2 && starts.length < 2 && !/\b(?:current|selected)\b/.test(query)) {
      return { status: 'clarify', message: 'Name two supported regions, give two UTC dates for the selected pad, or ask to compare the current scenarios.' }
    }
    const scenarios = context.scenarios.map((current, i) => {
      const site = sites[i] ?? sites[0]
      const pad = sites.length ? { ...current, site, node: 480, customLat: undefined, customLon: undefined }
        : starts.length === 2 ? selected : current
      return { ...pad, start: starts[i] ?? starts[0] ?? current.start }
    }) as [Scenario, Scenario]
    if (scenarios.some(s => s.start > latest)) return { status: 'coverage', message: 'The selected starts leave too little data for that duration. Provide earlier UTC starts.' }
    return { status: 'ready', plan: { kind: 'compare', scenarios, days } }
  }
  return { status: 'unsupported', message: 'Try a site or date comparison, a regional search, or a terrain extent study. The examples below show requests this version can run.' }
}
