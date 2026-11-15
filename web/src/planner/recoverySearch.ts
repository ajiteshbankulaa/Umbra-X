import { evaluateWindowSummary, searchObserverDual } from './model.ts'
import type { Limits, Metadata, Observer } from './model.ts'
import {
  buildDecisionCertificate,
  collectPassingStartsByPad,
  computeCounterfactualDiff,
  evaluateCandidateReportWithSteps,
  evaluateCandidateWithSteps,
  explainRecoveryDecision,
  greatCircleKm,
  rankParetoRecoveryAlternatives,
  validateRecoveryProblem,
} from './recovery.ts'
import type {
  CounterfactualDiff,
  MissionDecisionCertificate,
  MissionRecoveryProblem,
  ParetoSelectionResult,
  ProblemValidationResult,
  RecoveryCandidate,
  RecoveryExplanation,
} from './recovery.ts'

export interface RecoverySiteBundle {
  siteId: string
  meta: Metadata
  vectors: Float64Array
  getObserver: (node: number, mast: number) => Observer
}

export interface WasmDualSearcher {
  searchDual: (
    observer: Observer,
    vectors: Float64Array,
    steps: number,
    meta: Metadata,
    limits: Limits,
    sigma?: number,
  ) => number[]
  searchSiteDual?: (opts: {
    siteKey: string
    nodeCount: number
    mastM: number
    vectors: Float64Array
    steps: number
    meta: Metadata
    limits: Limits
    sigma?: number
    minStep: number
    maxStep: number
    getObserver: (node: number) => Observer
  }) => Map<number, number[]>
}

export interface PadOptionSummary {
  scenario: { site: string; node: number; start: number; mast: number }
  slope: number
  starts: number
  earliestStart: number
  nearestStart: number
  targetStartMatch: boolean
  longestDark: number
  longestEarth: number
  solarPct: number
  dsnHours: number
}

export interface RecoveryRunSuccess {
  ok: true
  cancelled: false
  problem: MissionRecoveryProblem
  validation: ProblemValidationResult
  diff: CounterfactualDiff
  baselineCandidate: RecoveryCandidate
  revisedCandidate: RecoveryCandidate
  selection: ParetoSelectionResult
  explanation: RecoveryExplanation
  certificate: MissionDecisionCertificate
  padOptions: PadOptionSummary[]
  engine: 'Rust/WASM' | 'Optimized TS'
  count: number
  elapsedMs: number
}

export type RecoveryRunResult =
  | RecoveryRunSuccess
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; errors: string[] }

interface GeometryCandidateSummary {
  site: string
  node: number
  start: number
  slope: number
  longestDark: number
  longestEarth: number
  solarPct: number
  displacementKm: number
  absScheduleShiftHours: number
  passingCount: number
}

export async function runMissionRecovery(
  problem: MissionRecoveryProblem,
  loadBundle: (siteId: string) => Promise<RecoverySiteBundle>,
  options?: {
    wasm?: WasmDualSearcher | null
    expectedVectorHashPrefix?: string
    shouldCancel?: () => boolean
    onProgress?: (stage: string) => void
    maxFullEval?: number
    nearMissPadStride?: number
    nearMissHourStep?: number
  },
): Promise<RecoveryRunResult> {
  const t0 = performance.now()
  const shouldCancel = options?.shouldCancel
  const maxFullEval = options?.maxFullEval ?? 64
  const nearMissPadStride = options?.nearMissPadStride ?? 16
  const nearMissHourStep = options?.nearMissHourStep ?? 24

  const firstValidation = validateRecoveryProblem(problem)
  if (!firstValidation.ok) {
    return { ok: false, cancelled: false, errors: firstValidation.errors }
  }

  const sitesNeeded = Array.from(new Set([problem.baseline.site, problem.revised.site, ...firstValidation.sites]))
  const bundles = new Map<string, RecoverySiteBundle>()

  for (const siteId of sitesNeeded) {
    if (shouldCancel?.()) return { ok: false, cancelled: true }
    const bundle = await loadBundle(siteId)
    if (!bundle.meta.regional) {
      return {
        ok: false,
        cancelled: false,
        errors: [`Site '${siteId}' is missing regional 96 km LOLA terrain horizon data.`],
      }
    }
    if (options?.expectedVectorHashPrefix && !bundle.meta.vectorHash.startsWith(options.expectedVectorHashPrefix)) {
      return {
        ok: false,
        cancelled: false,
        errors: [
          `Dataset version mismatch for '${siteId}': expected vectorHash starting with ${options.expectedVectorHashPrefix}, found ${bundle.meta.vectorHash.slice(0, 12)}.`,
        ],
      }
    }
    bundles.set(siteId, bundle)
  }

  if (shouldCancel?.()) return { ok: false, cancelled: true }

  const baseBundle = bundles.get(problem.baseline.site)!
  const revBundle = bundles.get(problem.revised.site)!
  const hoursAvailable = ((revBundle.meta.count - 1) * revBundle.meta.stepMinutes) / 60
  const validation = validateRecoveryProblem(problem, hoursAvailable, revBundle.meta.stepMinutes)
  if (!validation.ok) {
    return { ok: false, cancelled: false, errors: validation.errors }
  }

  const stepHours = revBundle.meta.stepMinutes / 60
  const steps = validation.steps
  const sigma = problem.power.sigma ?? 0

  const baseObs = baseBundle.getObserver(problem.baseline.node, problem.baseline.mast)
  const revObs = revBundle.getObserver(problem.revised.node, problem.revised.mast)
  const baselineAnchor = { coordinates: baseObs.coordinates, start: problem.baseline.start }

  const { candidate: baselineCandidate, report: baselineReport } = evaluateCandidateReportWithSteps({
    site: problem.baseline.site,
    node: problem.baseline.node,
    start: problem.baseline.start,
    mast: problem.baseline.mast,
    observer: baseObs,
    vectors: baseBundle.vectors,
    meta: baseBundle.meta,
    limits: problem.limits,
    power: problem.power,
    baseline: baselineAnchor,
    preference: problem.robustnessPreference,
    startStep: Math.round(problem.baseline.start / stepHours),
    steps,
  })

  const { candidate: revisedCandidate, report: revisedReport } = evaluateCandidateReportWithSteps({
    site: problem.revised.site,
    node: problem.revised.node,
    start: problem.revised.start,
    mast: problem.revised.mast,
    observer: revObs,
    vectors: revBundle.vectors,
    meta: revBundle.meta,
    limits: problem.limits,
    power: problem.power,
    baseline: baselineAnchor,
    preference: problem.robustnessPreference,
    startStep: Math.round(problem.revised.start / stepHours),
    steps,
  })

  const diff = computeCounterfactualDiff({
    baseline: baselineReport,
    revised: revisedReport,
    limits: problem.limits,
    power: problem.power,
    baselineLabel: problem.baselineLabel ?? `${problem.baseline.site} pad ${problem.baseline.node + 1} @ T+${problem.baseline.start}h`,
    revisedLabel: problem.revisedLabel ?? `${problem.revised.site} pad ${problem.revised.node + 1} @ T+${problem.revised.start}h`,
  })

  // Same-pad recovery check: use fast WASM/TS geometry scan when slope passes, else sample bounded coarse hours.
  options?.onProgress?.(`Checking same-pad schedule recovery (pad ${problem.revised.node + 1})…`)
  let sameSiteBest: RecoveryCandidate | null = null
  {
    const minH = Math.ceil(problem.delayWindowHours.minStart)
    const maxH = Math.floor(problem.delayWindowHours.maxStart)
    const minStep = Math.ceil(problem.delayWindowHours.minStart / stepHours)
    const maxStep = Math.floor(problem.delayWindowHours.maxStart / stepHours)
    let candidateHours: number[] = []

    if (revObs.slope != null && revObs.slope <= problem.limits.slope) {
      const rawSteps = options?.wasm
        ? options.wasm.searchDual(revObs, revBundle.vectors, steps, revBundle.meta, problem.limits, sigma)
        : searchObserverDual(revObs, revBundle.vectors, steps, revBundle.meta, problem.limits, sigma)
      const passingHours = Array.from(
        new Set(rawSteps.filter(s => s >= minStep && s <= maxStep).map(s => Math.round(s * stepHours))),
      )
      passingHours.sort((a, b) => Math.abs(a - problem.revised.start) - Math.abs(b - problem.revised.start))
      candidateHours = passingHours.slice(0, 6)
    }

    if (candidateHours.length === 0) {
      const coarseStep = Math.max(6, Math.floor((maxH - minH) / 16) || 6)
      const coarseScores: Array<{ hour: number; violationScore: number }> = []
      const sampled = new Set<number>([
        Math.max(minH, Math.min(maxH, Math.round(problem.revised.start))),
      ])
      for (let h = minH; h <= maxH; h += coarseStep) sampled.add(h)
      for (const h of sampled) {
        const s = evaluateWindowSummary(revObs, revBundle.vectors, Math.round(h / stepHours), steps, revBundle.meta, sigma)
        const slopeFail = revObs.slope == null ? 1 : Math.max(0, revObs.slope - problem.limits.slope) / Math.max(1, problem.limits.slope)
        const darkFail = Math.max(0, s.longestDark - problem.limits.dark) / Math.max(1, problem.limits.dark)
        const earthFail = Math.max(0, s.longestEarth - problem.limits.earth) / Math.max(1, problem.limits.earth)
        const score = slopeFail + darkFail + earthFail - s.solarPct * 1e-4 + Math.abs(h - problem.revised.start) * 1e-5
        coarseScores.push({ hour: h, violationScore: score })
      }
      coarseScores.sort((a, b) => a.violationScore - b.violationScore)
      candidateHours = coarseScores.slice(0, 3).map(x => x.hour)
    }

    for (const pickHour of candidateHours) {
      if (shouldCancel?.()) return { ok: false, cancelled: true }
      const cand = evaluateCandidateWithSteps({
        site: problem.revised.site,
        node: problem.revised.node,
        start: pickHour,
        mast: problem.revised.mast,
        observer: revObs,
        vectors: revBundle.vectors,
        meta: revBundle.meta,
        limits: problem.limits,
        power: problem.power,
        baseline: baselineAnchor,
        preference: problem.robustnessPreference,
        startStep: Math.round(pickHour / stepHours),
        steps,
      })
      if (
        !sameSiteBest ||
        (cand.feasible && !sameSiteBest.feasible) ||
        (cand.feasible === sameSiteBest.feasible && (cand.normalizedViolation ?? 0) < (sameSiteBest.normalizedViolation ?? 0)) ||
        (cand.feasible && sameSiteBest.feasible && cand.absScheduleShiftHours < sameSiteBest.absScheduleShiftHours)
      ) {
        sameSiteBest = cand
      }
      if (cand.feasible) break
    }
  }

  // Regional geometry scan across all sites in scope using WASM or TS dual-extent searcher.
  let engine: 'Rust/WASM' | 'Optimized TS' = options?.wasm ? 'Rust/WASM' : 'Optimized TS'
  let totalCount = 0
  const summaries: GeometryCandidateSummary[] = []
  const padOptions: PadOptionSummary[] = []

  for (let siteIdx = 0; siteIdx < validation.sites.length; siteIdx++) {
    const siteId = validation.sites[siteIdx]
    const bundle = bundles.get(siteId)!
    options?.onProgress?.(`Scanning ${siteId} (${siteIdx + 1}/${validation.sites.length}) with ${engine}…`)
    const collected = collectPassingStartsByPad({
      site: siteId,
      meta: bundle.meta,
      vectors: bundle.vectors,
      days: problem.days,
      mast: problem.revised.mast,
      limits: problem.limits,
      power: problem.power,
      minStart: problem.delayWindowHours.minStart,
      maxStart: problem.delayWindowHours.maxStart,
      getObserver: bundle.getObserver,
      wasm: options?.wasm ?? null,
      shouldCancel,
    })
    if (collected.cancelled) return { ok: false, cancelled: true }
    engine = collected.engine

    for (const [node, starts] of collected.passingStartsByNode.entries()) {
      totalCount += starts.length
      const obs = bundle.getObserver(node, problem.revised.mast)
      const disp = greatCircleKm(baseObs.coordinates[0], baseObs.coordinates[1], obs.coordinates[0], obs.coordinates[1])

      const earliestStart = starts[0]
      let nearestStart = earliestStart
      let bestShift = Math.abs(nearestStart - problem.revised.start)
      let targetStartMatch = false
      for (const h of starts) {
        const diffH = Math.abs(h - problem.revised.start)
        if (diffH < bestShift) {
          bestShift = diffH
          nearestStart = h
        }
        if (diffH === 0) targetStartMatch = true
      }
      const nearestWin = evaluateWindowSummary(obs, bundle.vectors, Math.round(nearestStart / stepHours), steps, bundle.meta, sigma)
      padOptions.push({
        scenario: { site: siteId, node, start: nearestStart, mast: problem.revised.mast },
        slope: obs.slope ?? 90,
        starts: starts.length,
        earliestStart,
        nearestStart,
        targetStartMatch,
        longestDark: nearestWin.longestDark,
        longestEarth: nearestWin.longestEarth,
        solarPct: nearestWin.solarPct,
        dsnHours: nearestWin.dsnHours,
      })

      summaries.push({
        site: siteId,
        node,
        start: nearestStart,
        slope: obs.slope ?? 90,
        longestDark: nearestWin.longestDark,
        longestEarth: nearestWin.longestEarth,
        solarPct: nearestWin.solarPct,
        displacementKm: disp,
        absScheduleShiftHours: Math.abs(nearestStart - problem.baseline.start),
        passingCount: starts.length,
      })

      // Also record earliest zero/low-shift start on nearby low-slope pads so minimal-schedule-shift tradeoffs are represented.
      if (earliestStart !== nearestStart && (disp <= 15 || padOptions.length <= 24)) {
        const earliestWin = evaluateWindowSummary(obs, bundle.vectors, Math.round(earliestStart / stepHours), steps, bundle.meta, sigma)
        summaries.push({
          site: siteId,
          node,
          start: earliestStart,
          slope: obs.slope ?? 90,
          longestDark: earliestWin.longestDark,
          longestEarth: earliestWin.longestEarth,
          solarPct: earliestWin.solarPct,
          displacementKm: disp,
          absScheduleShiftHours: Math.abs(earliestStart - problem.baseline.start),
          passingCount: starts.length,
        })
      }
    }
  }

  // Select diverse candidate set covering Pareto extremities + nearest alternatives up to maxFullEval.
  const selectedKeys = new Set<string>()
  const selectedSummaries: GeometryCandidateSummary[] = []
  const addTop = (sorted: GeometryCandidateSummary[], limit: number) => {
    let added = 0
    for (const item of sorted) {
      if (added >= limit || selectedSummaries.length >= maxFullEval) break
      const key = `${item.site}:${item.node}:${item.start}`
      if (!selectedKeys.has(key)) {
        selectedKeys.add(key)
        selectedSummaries.push(item)
        added++
        if (added >= limit || selectedSummaries.length >= maxFullEval) break
      }
    }
  }

  if (summaries.length <= maxFullEval) {
    addTop(summaries, summaries.length)
  } else {
    addTop([...summaries].sort((a, b) => a.absScheduleShiftHours - b.absScheduleShiftHours || a.displacementKm - b.displacementKm), 16)
    addTop([...summaries].sort((a, b) => a.longestDark - b.longestDark || a.slope - b.slope), 14)
    addTop([...summaries].sort((a, b) => a.longestEarth - b.longestEarth || a.slope - b.slope), 14)
    addTop([...summaries].sort((a, b) => a.slope - b.slope || a.longestDark - b.longestDark), 14)
    addTop([...summaries].sort((a, b) => b.solarPct - a.solarPct || a.longestDark - b.longestDark), 10)
    for (const siteId of validation.sites) {
      addTop(
        summaries.filter(s => s.site === siteId).sort((a, b) => a.longestDark - b.longestDark || a.displacementKm - b.displacementKm),
        6,
      )
    }
  }

  options?.onProgress?.(`Running energy balance & robustness checks on ${selectedSummaries.length} candidate(s)…`)
  const evaluated: RecoveryCandidate[] = []
  for (const s of selectedSummaries) {
    if (shouldCancel?.()) return { ok: false, cancelled: true }
    const bundle = bundles.get(s.site)!
    const obs = bundle.getObserver(s.node, problem.revised.mast)
    evaluated.push(
      evaluateCandidateWithSteps({
        site: s.site,
        node: s.node,
        start: s.start,
        mast: problem.revised.mast,
        observer: obs,
        vectors: bundle.vectors,
        meta: bundle.meta,
        limits: problem.limits,
        power: problem.power,
        baseline: baselineAnchor,
        preference: problem.robustnessPreference,
        startStep: Math.round(s.start / stepHours),
        steps,
      }),
    )
  }

  let selection = rankParetoRecoveryAlternatives({
    evaluated,
    sameSiteBest,
    nearMisses: [revisedCandidate, ...(sameSiteBest ? [sameSiteBest] : [])],
    weights: problem.weights,
  })

  // Bounded near-miss discovery when zero geometry-passing candidates exist anywhere in search scope.
  if (selection.feasibleCount === 0 && summaries.length === 0) {
    options?.onProgress?.('No feasible pads matched constraints; searching closest bounded near-misses…')
    const coarsePool: Array<{ site: string; node: number; start: number; score: number }> = []
    const minH = Math.ceil(problem.delayWindowHours.minStart)
    const maxH = Math.floor(problem.delayWindowHours.maxStart)
    const sampleHours: number[] = []
    for (let h = minH; h <= maxH; h += nearMissHourStep) sampleHours.push(h)
    if (!sampleHours.includes(problem.revised.start) && problem.revised.start >= minH && problem.revised.start <= maxH) {
      sampleHours.push(problem.revised.start)
    }

    for (const siteId of validation.sites) {
      const bundle = bundles.get(siteId)!
      for (let node = 0; node < bundle.meta.observers.length; node += nearMissPadStride) {
        if (shouldCancel?.()) return { ok: false, cancelled: true }
        const obs = bundle.getObserver(node, problem.revised.mast)
        const slopeOver =
          obs.slope == null
            ? 2
            : Math.max(0, obs.slope - problem.limits.slope) / Math.max(0.5, problem.limits.slope)
        for (const h of sampleHours) {
          const win = evaluateWindowSummary(obs, bundle.vectors, Math.round(h / stepHours), steps, bundle.meta, sigma)
          const darkOver = Math.max(0, win.longestDark - problem.limits.dark) / Math.max(1, problem.limits.dark)
          const earthOver = Math.max(0, win.longestEarth - problem.limits.earth) / Math.max(1, problem.limits.earth)
          coarsePool.push({ site: siteId, node, start: h, score: slopeOver + darkOver + earthOver - win.solarPct * 1e-4 })
        }
      }
    }
    coarsePool.sort((a, b) => a.score - b.score)
    const nearMissEvaluated: RecoveryCandidate[] = [revisedCandidate, ...(sameSiteBest ? [sameSiteBest] : [])]
    for (const item of coarsePool.slice(0, 10)) {
      if (shouldCancel?.()) return { ok: false, cancelled: true }
      const bundle = bundles.get(item.site)!
      const obs = bundle.getObserver(item.node, problem.revised.mast)
      nearMissEvaluated.push(
        evaluateCandidateWithSteps({
          site: item.site,
          node: item.node,
          start: item.start,
          mast: problem.revised.mast,
          observer: obs,
          vectors: bundle.vectors,
          meta: bundle.meta,
          limits: problem.limits,
          power: problem.power,
          baseline: baselineAnchor,
          preference: problem.robustnessPreference,
          startStep: Math.round(item.start / stepHours),
          steps,
        }),
      )
    }
    selection = rankParetoRecoveryAlternatives({
      evaluated,
      sameSiteBest,
      nearMisses: nearMissEvaluated,
      weights: problem.weights,
    })
  }

  const sitesMeta: Record<string, Metadata> = {}
  for (const [siteId, b] of bundles.entries()) sitesMeta[siteId] = b.meta

  const explanation = explainRecoveryDecision({
    problem,
    diff,
    revisedCandidate,
    selection,
  })

  const certificate = buildDecisionCertificate({
    problem,
    validation,
    sitesMeta,
    baselineReport,
    revisedReport,
    baselineCandidate,
    revisedCandidate,
    diff,
    selection,
    explanation,
    searchCoverage: {
      geometryPassingPairs: totalCount,
      representativeCandidates: summaries.length,
      detailedCandidates: evaluated.length,
      exhaustivePowerSearch: false,
    },
  })

  return {
    ok: true,
    cancelled: false,
    problem,
    validation,
    diff,
    baselineCandidate,
    revisedCandidate,
    selection,
    explanation,
    certificate,
    padOptions,
    engine,
    count: totalCount,
    elapsedMs: Math.round(performance.now() - t0),
  }
}
