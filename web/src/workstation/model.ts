import { computeCommercialMetrics, computeTerminatorPlasmaRisk, simulateGridWindow, solveLightToIceNetwork, solveShadowSurfingPath } from '../engine/heliosEngine'
import type { SiteData } from '../types/helios'
import { palette } from './TerrainViewport'

export const sites = [
  ['shackleton-ridge', 'Shackleton Rim & PSR', 'Artemis III'],
  ['mons-mouton', 'Mons Mouton', 'IM-2 Athena & PRIME-1'],
  ['malapert-massif', 'Malapert Massif', 'IM-1 region'],
  ['apollo-11', 'Apollo 11', 'NSSDCA educator baseline'],
] as const
export type SiteId = typeof sites[number][0]
export interface Settings { delay: number; mast: number; sigma: number; node: number; inventory: number }
function longestHiddenRun(isHidden: (hour: number) => boolean) {
  let currentRun = 0
  let longestRun = 0

  for (let hour = 0; hour < 360; hour++) {
    if (isHidden(hour)) {
      currentRun++
      longestRun = Math.max(longestRun, currentRun)
    } else {
      currentRun = 0
    }
  }

  return longestRun
}
export function analyze(site: SiteData, { delay, mast, sigma, node, inventory }: Settings) {
  const window = simulateGridWindow(site, { launchDelayHours: delay, mastIndex: mast, sigma })
  const plasma = computeTerminatorPlasmaRisk(window)
  const network = solveLightToIceNetwork(window, { primaryNode: node })
  const primary = network?.primary ?? node
  const longestSunBlackout = longestHiddenRun(hour =>
  window.solarFraction[hour * window.nodeCount + primary] < 0.1)
  const longestEarthBlackout = longestHiddenRun(hour =>
  !window.earthVisible[hour * window.nodeCount + primary])
  const route = solveShadowSurfingPath(window, plasma, { startNode: primary })
  const finance = network && computeCommercialMetrics(window, plasma, network, route, { iceInventoryKg: inventory })
  const times = Array.from({ length: 360 }, (_, hour) => hour * window.nodeCount)
  const values = (node: number) => times.map(i => window.solarFraction[i + node])
  const solarA = values(primary)
  const solarB = network?.twin == null ? null : values(network.twin)
  const solarRover = route ? times.map((i, h) => window.solarFraction[i + route.path[h]]) : null
  const capacity = 100 * 150 * .8
  const charge = [capacity, capacity, capacity]
  const soc = [[], [], []] as number[][]
  const engineering = [0, 1, 2].map(() => ({ dark: 0, blackout: 0, field: 0, esd: 0, dust: 0 }))
  const source = (i: number) => 400 * window.solarFraction[i] * (1 - plasma.dustPowerLossPct[i] / 100) - 120 - window.heaterW[i]
  let remainingIce = inventory
  times.forEach((base, hour) => {
    const a = base + primary
    const b = network?.twin == null ? a : base + network.twin
    const r = route ? base + route.path[hour] : a
    const roverDrive = route && hour && route.path[hour] !== route.path[hour - 1]
      ? route.driveWhPerM * site.manifest.analysis_grid.spacing_m : 0
    const netA = source(a), netB = a === b ? 0 : source(b), netGrid = netA + netB
    let beam = 0
    if (network?.iceTarget != null && remainingIce > 0) {
      const eligible = network.beamSources.reduce((sum, node) => sum + Math.max(0, source(base + node)), 0)
      beam = Math.min(eligible, Math.max(0, netGrid), remainingIce * 1000 / (.4 * .2))
      remainingIce = Math.max(0, remainingIce - beam * .4 * .2 / 1000)
    }
    const delta = [netA, netGrid - beam, source(r) - roverDrive]
    const channels = [[a, a], [a, b], [r, r]]
    channels.forEach(([x, y], j) => {
      charge[j] = Math.max(0, Math.min(capacity, charge[j] + delta[j]))
      soc[j].push(charge[j] / capacity)
      engineering[j].dark += +(window.solarFraction[x] < .1 && window.solarFraction[y] < .1)
      engineering[j].blackout += +(!window.earthVisible[x] && !window.earthVisible[y])
      engineering[j].field = Math.max(engineering[j].field, plasma.electricFieldVm[x], plasma.electricFieldVm[y])
      engineering[j].esd += +(!!(plasma.esdHazard[x] || plasma.esdHazard[y]))
      engineering[j].dust = Math.max(engineering[j].dust, plasma.dustPowerLossPct[x], plasma.dustPowerLossPct[y])
    })
  })
  return { window, plasma, network, route, finance, primary, solarA, solarB, solarRover, soc, engineering,
    longestSunBlackout, longestEarthBlackout,
    tracks: [
      { label: 'Pad A solar', unit: '%', color: palette.gold, values: solarA.map(x => x * 100), max: 100 },
      { label: 'Twin B solar', unit: '%', color: palette.cyan, values: solarB?.map(x => x * 100) ?? [], max: 100 },
      { label: 'Rover solar', unit: '%', color: palette.emerald, values: solarRover?.map(x => x * 100) ?? [], max: 100 },
      { label: 'Standalone SoC', unit: '%', color: palette.red, values: soc[0].map(x => x * 100), max: 100 },
      { label: 'Grid SoC', unit: '%', color: palette.emerald, values: network?.twin == null ? [] : soc[1].map(x => x * 100), max: 100 },
      { label: 'Rover SoC', unit: '%', color: '#7eeecb', values: route ? soc[2].map(x => x * 100) : [], max: 100 },
      { label: 'Pad A electric field', unit: 'V/m', color: palette.amber,
        values: times.map(i => plasma.electricFieldVm[i + primary]), max: 45 },
      { label: 'PSR secondary light', unit: 'W/m²', color: palette.violet,
        values: network?.iceTarget == null ? [] : Array.from(network.passiveRadiosityWm2) },
    ],
  }
}
export type Analysis = ReturnType<typeof analyze>
export type Track = Analysis['tracks'][number]
