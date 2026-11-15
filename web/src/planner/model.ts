export type Triple = [number, number, number]
export interface Metadata {
  schema: number
  start: string
  stepMinutes: number
  count: number
  vectorHash: string
  localHash: string
  frame: string
  station: { name: string; maskDeg: number; source: string }
  kernels: Record<string, { url: string; sha256: string }>
  observers: Triple[]
  regional: null | { radiusM: number; comparisonRadiusM: number; source: string; regional: string; distance: string; coverage: string; sensitivity: string }
}
export interface Observer {
  coordinates: Triple
  horizon: Float32Array
  reference: Float32Array
  horizonError?: Float32Array
  distance: Float32Array
  coverage: Uint8Array
  mast: number
  slope: number | null
  psr?: number
}
export interface Scenario {
  site: string
  node: number
  start: number
  mast: number
  customLat?: number
  customLon?: number
}
export interface Limits { dark: number; earth: number; slope: number }
export type ArrayMode = 'tracked' | 'vertical' | 'horizontal'
export interface Power {
  arrayW: number
  loadW: number
  specificWh: number
  hardwareKg: number
  budgetKg: number
  arrayMode?: ArrayMode
  sigma?: number
}
export const defaultPower: Power = {
  arrayW: 400,
  loadW: 120,
  specificWh: 150,
  hardwareKg: 20,
  budgetKg: 100,
  arrayMode: 'tracked',
  sigma: 0,
}
export const solarThreshold = .1
const radius = 1737400
const rad = Math.PI / 180

const DSS14_ITRF: Triple = [-2353621.365667699, -4641341.49114994, 3677052.329319744]
const DSS65_ITRF: Triple = [4849092.68, -360180.34, 4114913.25]
const DSS43_ITRF: Triple = [-4460894.92, 2682361.55, -3674748.58]
const WGS84_A2 = 6378137.0 * 6378137.0
const WGS84_B2 = 6356752.314245 * 6356752.314245

function normalize3(x: number, y: number, z: number): Triple {
  const m = Math.hypot(x, y, z) || 1
  return [x / m, y / m, z / m]
}

function cross3(a: Triple, b: Triple): Triple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function wgs84Up(p: Triple): Triple {
  return normalize3(p[0] / WGS84_A2, p[1] / WGS84_A2, p[2] / WGS84_B2)
}

function buildDsnFrame(p: Triple, u: Triple): [Triple, Triple, Triple] | null {
  const pm = Math.hypot(p[0], p[1], p[2])
  const um = Math.hypot(u[0], u[1], u[2])
  if (pm < 1e5 || um < 0.5) return null
  const e1: Triple = [u[0] / um, u[1] / um, u[2] / um]
  const pn: Triple = [p[0] / pm, p[1] / pm, p[2] / pm]
  const c = cross3(e1, pn)
  const cm = Math.hypot(c[0], c[1], c[2])
  if (cm < 1e-6) return null
  const e2: Triple = [c[0] / cm, c[1] / cm, c[2] / cm]
  const e3 = cross3(e1, e2)
  return [e1, e2, e3]
}

function toBasisCoords(v: Triple, b: [Triple, Triple, Triple]): Triple {
  return [
    v[0] * b[0][0] + v[1] * b[0][1] + v[2] * b[0][2],
    v[0] * b[1][0] + v[1] * b[1][1] + v[2] * b[1][2],
    v[0] * b[2][0] + v[1] * b[2][1] + v[2] * b[2][2],
  ]
}

const dsnItrsBasis = buildDsnFrame(DSS14_ITRF, wgs84Up(DSS14_ITRF))!
const DSS65_BASIS = { pos: toBasisCoords(DSS65_ITRF, dsnItrsBasis), up: toBasisCoords(wgs84Up(DSS65_ITRF), dsnItrsBasis) }
const DSS43_BASIS = { pos: toBasisCoords(DSS43_ITRF, dsnItrsBasis), up: toBasisCoords(wgs84Up(DSS43_ITRF), dsnItrsBasis) }

export type DsnComplexName = 'DSS-14 Goldstone' | 'DSS-65 Madrid' | 'DSS-43 Canberra'

export function horizonAt(profile: Float32Array, az: number) {
  const i = Math.floor(az)
  return profile[i] + (profile[(i+1)%360]-profile[i]) * (az-i)
}

export function diskFraction(clearance: number) {
  const x = Math.max(-1, Math.min(1, clearance / .2665))
  return (Math.acos(-x)+x*Math.sqrt(1-x*x))/Math.PI
}

export function arrayEfficiency(elDeg: number, mode: ArrayMode = 'tracked') {
  if (mode === 'tracked') return 1
  if (mode === 'vertical') return Math.max(0, Math.cos(elDeg * rad))
  return Math.max(0, Math.sin(elDeg * rad))
}

function basis(observer: Observer) {
  const [lat, lon, height] = observer.coordinates
  const a = lat*rad, b = lon*rad
  const up = [Math.cos(a)*Math.cos(b), Math.cos(a)*Math.sin(b), Math.sin(a)]
  const north = [-Math.sin(a)*Math.cos(b), -Math.sin(a)*Math.sin(b), Math.cos(a)]
  const east = [-Math.sin(b), Math.cos(b), 0]
  return { up, north, east, r: radius+height+observer.mast }
}

function directionXyz(px: number, py: number, pz: number, frame: ReturnType<typeof basis>) {
  const x = px - frame.r * frame.up[0]
  const y = py - frame.r * frame.up[1]
  const z = pz - frame.r * frame.up[2]
  const east = x * frame.east[0] + y * frame.east[1] + z * frame.east[2]
  const north = x * frame.north[0] + y * frame.north[1] + z * frame.north[2]
  const up = x * frame.up[0] + y * frame.up[1] + z * frame.up[2]
  return {
    az: (Math.atan2(east, north) / rad + 360) % 360,
    el: Math.atan2(up, Math.hypot(north, east)) / rad,
  }
}

function direction(vectors: Float64Array, offset: number, frame: ReturnType<typeof basis>) {
  return directionXyz(vectors[offset], vectors[offset + 1], vectors[offset + 2], frame)
}
type Direction = ReturnType<typeof direction>
export interface Sky {
  sun: Direction; earth: Direction; station: Direction
  sunHorizon: number; earthHorizon: number; sunSigma: number; earthSigma: number
  sunMargin: number; earthMargin: number; stationUp: number
  stationAccess: boolean; stationCovered: boolean
  dss14Access: boolean; dss65Access: boolean; dss43Access: boolean
  dsnAccess: boolean; dsnCovered: boolean; dsnMaxUp: number
  dsnActiveStation: DsnComplexName | null
  solar: number; incidenceFactor: number; regionalComplete: boolean; obstructionM: number
}
function directionOffset(
  px: number,
  py: number,
  pz: number,
  rx: number,
  ry: number,
  rz: number,
  e0: number, e1: number, e2: number,
  n0: number, n1: number, n2: number,
  u0: number, u1: number, u2: number,
) {
  const x = px - rx, y = py - ry, z = pz - rz
  const east = x * e0 + y * e1 + z * e2
  const north = x * n0 + y * n1 + z * n2
  const up = x * u0 + y * u1 + z * u2
  return {
    az: (Math.atan2(east, north) / rad + 360) % 360,
    el: Math.atan2(up, Math.hypot(north, east)) / rad,
  }
}

function horizonAtOffset(profile: Float32Array, offset: number, az: number) {
  const i = Math.floor(az)
  const v0 = profile[offset + i]
  return v0 + (profile[offset + ((i + 1) % 360)] - v0) * (az - i)
}

function evalDsnComplexes(
  vectors: Float64Array,
  i: number,
  frame: ReturnType<typeof basis>,
  horizon: Float32Array,
  horizonOffset: number,
  horizonError: Float32Array | undefined,
  errorOffset: number,
  coverage: Uint8Array,
  coverageOffset: number,
  mask: number,
  sigma: number,
  stationDir: { az: number; el: number },
  stationHorizon: number,
  stationUp: number,
) {
  const cov = (az: number) => Boolean(coverage[coverageOffset + Math.floor(az)] && coverage[coverageOffset + (Math.ceil(az) % 360)])
  const dss14Covered = cov(stationDir.az)
  const dss14Access = dss14Covered && stationUp >= mask && stationDir.el > stationHorizon

  let dss65Access = false
  let dss43Access = false
  let dss65Covered = true
  let dss43Covered = true
  let dsnMaxUp = stationUp
  let dss65Up = -90
  let dss43Up = -90

  const meFrame = buildDsnFrame(
    [vectors[i + 6] - vectors[i + 3], vectors[i + 7] - vectors[i + 4], vectors[i + 8] - vectors[i + 5]],
    [vectors[i + 9], vectors[i + 10], vectors[i + 11]],
  )
  if (meFrame) {
    const evalComplex = (c: { pos: Triple; up: Triple }) => {
      const rx = c.pos[0] * meFrame[0][0] + c.pos[1] * meFrame[1][0] + c.pos[2] * meFrame[2][0]
      const ry = c.pos[0] * meFrame[0][1] + c.pos[1] * meFrame[1][1] + c.pos[2] * meFrame[2][1]
      const rz = c.pos[0] * meFrame[0][2] + c.pos[1] * meFrame[1][2] + c.pos[2] * meFrame[2][2]
      const sx = vectors[i + 3] + rx, sy = vectors[i + 4] + ry, sz = vectors[i + 5] + rz
      const ux = c.up[0] * meFrame[0][0] + c.up[1] * meFrame[1][0] + c.up[2] * meFrame[2][0]
      const uy = c.up[0] * meFrame[0][1] + c.up[1] * meFrame[1][1] + c.up[2] * meFrame[2][1]
      const uz = c.up[0] * meFrame[0][2] + c.up[1] * meFrame[1][2] + c.up[2] * meFrame[2][2]
      const dir = directionXyz(sx, sy, sz, frame)
      const hErr = horizonError ? horizonAtOffset(horizonError, errorOffset, dir.az) : 0
      const hor = horizonAtOffset(horizon, horizonOffset, dir.az) + sigma * hErr
      const dx = frame.up[0] * frame.r - sx, dy = frame.up[1] * frame.r - sy, dz = frame.up[2] * frame.r - sz
      const upDeg = Math.asin(Math.max(-1, Math.min(1, (dx * ux + dy * uy + dz * uz) / Math.hypot(dx, dy, dz)))) / rad
      const covAz = cov(dir.az)
      return { upDeg, covAz, access: covAz && upDeg >= mask && dir.el > hor }
    }
    const c65 = evalComplex(DSS65_BASIS)
    const c43 = evalComplex(DSS43_BASIS)
    dss65Access = c65.access
    dss65Covered = c65.covAz
    dss65Up = c65.upDeg
    dss43Access = c43.access
    dss43Covered = c43.covAz
    dss43Up = c43.upDeg
    dsnMaxUp = Math.max(stationUp, dss65Up, dss43Up)
  }

  const dsnAccess = dss14Access || dss65Access || dss43Access
  const dsnCovered = dsnAccess || (dss14Covered && dss65Covered && dss43Covered)
  const candidates: [DsnComplexName, boolean, number][] = [
    ['DSS-14 Goldstone', dss14Access, stationUp],
    ['DSS-65 Madrid', dss65Access, dss65Up],
    ['DSS-43 Canberra', dss43Access, dss43Up],
  ]
  const active = candidates.filter(([, ok]) => ok).sort((a, b) => b[2] - a[2])[0]?.[0] ?? null
  return { dss14Covered, dss14Access, dss65Access, dss43Access, dsnAccess, dsnCovered, dsnMaxUp, active }
}

function sample(
  observer: Observer,
  vectors: Float64Array,
  index: number,
  frame: ReturnType<typeof basis>,
  mask: number,
  sigma = 0,
  arrayMode: ArrayMode = 'tracked',
): Sky {
  const i = index*12
  const sun = direction(vectors, i, frame), earth = direction(vectors, i+3, frame)
  const station = direction(vectors, i+6, frame)
  const sunSigma = observer.horizonError ? horizonAt(observer.horizonError, sun.az) : 0
  const earthSigma = observer.horizonError ? horizonAt(observer.horizonError, earth.az) : 0
  const stationSigma = observer.horizonError ? horizonAt(observer.horizonError, station.az) : 0
  const sunHorizon = horizonAt(observer.horizon, sun.az) + sigma * sunSigma
  const earthHorizon = horizonAt(observer.horizon, earth.az) + sigma * earthSigma
  const stationHorizon = horizonAt(observer.horizon, station.az) + sigma * stationSigma
  const sunMargin = sun.el - sunHorizon
  const earthMargin = earth.el - earthHorizon
  const x = frame.up[0]*frame.r-vectors[i+6], y = frame.up[1]*frame.r-vectors[i+7], z = frame.up[2]*frame.r-vectors[i+8]
  const stationUp = Math.asin(Math.max(-1,Math.min(1,(x*vectors[i+9]+y*vectors[i+10]+z*vectors[i+11])/Math.hypot(x,y,z))))/rad
  const covered = (az: number) => Boolean(observer.coverage[Math.floor(az)] && observer.coverage[Math.ceil(az)%360])
  const dsn = evalDsnComplexes(
    vectors, i, frame, observer.horizon, 0, observer.horizonError, 0,
    observer.coverage, 0, mask, sigma, station, stationHorizon, stationUp,
  )

  return {sun, earth, station, sunHorizon, earthHorizon, sunSigma, earthSigma, sunMargin, earthMargin, stationUp,
    stationCovered: dsn.dss14Covered,
    stationAccess: dsn.dss14Access,
    dss14Access: dsn.dss14Access,
    dss65Access: dsn.dss65Access,
    dss43Access: dsn.dss43Access,
    dsnAccess: dsn.dsnAccess,
    dsnCovered: dsn.dsnCovered,
    dsnMaxUp: dsn.dsnMaxUp,
    dsnActiveStation: dsn.active,
    solar: diskFraction(sunMargin), incidenceFactor: arrayEfficiency(sun.el, arrayMode),
    regionalComplete: covered(sun.az) && covered(earth.az),
    obstructionM: observer.distance[Math.round(earth.az)%360] }
}

export function intervals(states: boolean[], stepHours: number) {
  const events: { start: number; end: number; hours: number; atStart: boolean; atEnd: boolean }[] = []
  let start = -1
  for (let i=0; i<=states.length; i++) {
    if (states[i] && start < 0) start = i
    if (!states[i] && start >= 0) {
      events.push({start, end:i, hours:(i-start)*stepHours, atStart:start===0, atEnd:i===states.length})
      start = -1
    }
  }
  return events
}

export interface Countdown {
  visible: boolean
  hoursRemaining: number
  nextIndex: number | null
  persistsToEnd: boolean
}

export function countdown(states: boolean[], cursor: number, stepHours: number): Countdown {
  if (!states.length) return { visible: false, hoursRemaining: 0, nextIndex: null, persistsToEnd: true }
  const idx = Math.max(0, Math.min(states.length - 1, cursor))
  const obstructed = Boolean(states[idx])
  let next = -1
  for (let i = idx + 1; i < states.length; i++) {
    if (Boolean(states[i]) !== obstructed) {
      next = i
      break
    }
  }
  return {
    visible: !obstructed,
    hoursRemaining: ((next >= 0 ? next : states.length) - idx) * stepHours,
    nextIndex: next >= 0 ? next : null,
    persistsToEnd: next < 0,
  }
}

export function storage(generation: number[], power: Power, dt: number) {
  // Fully charged at landing, 80% usable depth, 95% one-way efficiency.
  // The example inverter caps battery discharge to 300 W and charging to 300 W.
  const efficiency = .95, depth = .8
  const deltas = generation.map(g => {
    const diff = g-power.loadW
    return (diff >= 0 ? Math.min(300,diff)*efficiency : -Math.min(300,-diff)/efficiency)*dt
  })
  let deficit=0, usableWh=0
  for (const delta of deltas) {
    deficit=Math.max(0,deficit-delta)
    usableWh=Math.max(usableWh,deficit)
  }
  const available = Math.max(0,power.budgetKg-power.hardwareKg)*power.specificWh*depth
  let charge=available, unmetWh=0
  const soc = deltas.map((delta,i)=>{
    unmetWh += Math.max(0,-(generation[i]-power.loadW)-300)*dt + Math.max(0,-(charge+delta))*efficiency
    charge=Math.max(0,Math.min(available,charge+delta))
    return available ? charge/available : 0
  })
  const batteryKg=usableWh/(power.specificWh*depth)
  return {usableWh,batteryKg,totalKg:batteryKg+power.hardwareKg,headroomKg:power.budgetKg-power.hardwareKg-batteryKg,
    unmetWh,soc,feasible:unmetWh<1e-6 && power.hardwareKg+batteryKg<=power.budgetKg}
}

export function analyze(observer: Observer, vectors: Float64Array, start: number, steps: number, meta: Metadata, power: Power) {
  const frame = basis(observer)
  const sigma = power.sigma ?? 0
  const arrayMode = power.arrayMode ?? 'tracked'
  const sky = Array.from({length:steps},(_,i)=>sample(observer,vectors,start+i,frame,meta.station.maskDeg,sigma,arrayMode))
  const dt = meta.stepMinutes/60
  const dark = intervals(sky.map(s=>s.solar<solarThreshold),dt)
  const earth = intervals(sky.map(s=>s.earthMargin<=0),dt)
  const station = intervals(sky.map(s=>s.stationAccess),dt)
  const dsn = intervals(sky.map(s=>s.dsnAccess),dt)
  const dsnBlackout = intervals(sky.map(s=>!s.dsnAccess),dt)
  const longest = (events: typeof dark) => Math.max(0,...events.map(e=>e.hours))
  const generation = sky.map(s=>power.arrayW*s.solar*s.incidenceFactor)
  let referenceDark=0, referenceEarth=0, darkRun=0, earthRun=0, referenceLongestDark=0, referenceLongestEarth=0
  let maxSunEl = -90, minSunEl = 90, maxEarthEl = -90, minEarthEl = 90
  for (const s of sky) {
    maxSunEl = Math.max(maxSunEl, s.sun.el)
    minSunEl = Math.min(minSunEl, s.sun.el)
    maxEarthEl = Math.max(maxEarthEl, s.earth.el)
    minEarthEl = Math.min(minEarthEl, s.earth.el)
    const d=diskFraction(s.sun.el-(horizonAt(observer.reference,s.sun.az)+sigma*s.sunSigma))<solarThreshold
    const e=s.earth.el<=(horizonAt(observer.reference,s.earth.az)+sigma*s.earthSigma)
    referenceDark += +d
    referenceEarth += +e
    darkRun=d?darkRun+1:0
    earthRun=e?earthRun+1:0
    referenceLongestDark=Math.max(referenceLongestDark,darkRun)
    referenceLongestEarth=Math.max(referenceLongestEarth,earthRun)
  }
  return {sky,dark,earth,station,dsn,dsnBlackout,generation,solarHours:steps*dt-dark.reduce((n,e)=>n+e.hours,0),
    earthHours:steps*dt-earth.reduce((n,e)=>n+e.hours,0),stationHours:station.reduce((n,e)=>n+e.hours,0),
    dsnHours:dsn.reduce((n,e)=>n+e.hours,0),
    longestDsnBlackout:longest(dsnBlackout),
    dsnUnknownHours:sky.filter(s=>!s.dsnCovered).length*dt,
    dsnDisagreementHours:sky.filter(s=>s.dsnCovered && s.dsnAccess!==(s.earthMargin>0)).length*dt,
    dsnComplexHours:{
      dss14:sky.filter(s=>s.dss14Access).length*dt,
      dss65:sky.filter(s=>s.dss65Access).length*dt,
      dss43:sky.filter(s=>s.dss43Access).length*dt,
    },
    stationUnknownHours:sky.filter(s=>!s.stationCovered).length*dt,
    disagreementHours:sky.filter(s=>s.stationCovered && s.stationAccess!==(s.earthMargin>0)).length*dt,
    longestDark:longest(dark),longestEarth:longest(earth), slope:observer.slope, psr:observer.psr??0,
    maxSunEl, minSunEl, maxEarthEl, minEarthEl,
    complete:sky.every(s=>s.regionalComplete), referenceDark:referenceDark*dt,referenceEarth:referenceEarth*dt,
    referenceLongestDark:referenceLongestDark*dt,referenceLongestEarth:referenceLongestEarth*dt,
    ...storage(generation,power,dt)}
}
export type Report = ReturnType<typeof analyze>

export function complementaryPower(primary: number[], secondary: number[], power: Power,
  transferW: number, efficiency: number, extraKg: number, stepHours: number) {
  // One load and battery at the primary. The secondary supplies PV only.
  const combined=primary.map((watts,i)=>watts+Math.min(transferW,secondary[i])*efficiency)
  const single=storage(primary,power,stepHours)
  const twin=storage(combined,{...power,hardwareKg:power.hardwareKg+extraKg},stepHours)
  return {single,twin,avoidedUnmetWh:single.unmetWh-twin.unmetWh,
    installedMassDeltaKg:twin.totalKg-single.totalKg}
}

export function searchObserver(observer: Observer, vectors: Float64Array, steps: number, meta: Metadata, limits: Limits, sigma = 0) {
  const frame = basis(observer)
  const n = meta.count-1
  const sun = new Float64Array(n), earth = new Float64Array(n)
  const gaps = new Uint32Array(n+1)
  for (let i=0; i<n; i++) {
    const a=direction(vectors,i*12,frame), b=direction(vectors,i*12+3,frame)
    const sunErr = observer.horizonError ? horizonAt(observer.horizonError, a.az) : 0
    const earthErr = observer.horizonError ? horizonAt(observer.horizonError, b.az) : 0
    sun[i]=+(diskFraction(a.el-(horizonAt(observer.horizon,a.az)+sigma*sunErr))<solarThreshold)
    earth[i]=+(b.el<=horizonAt(observer.horizon,b.az)+sigma*earthErr)
    gaps[i+1]=gaps[i]+ +(!(observer.coverage[Math.floor(a.az)] && observer.coverage[Math.ceil(a.az)%360] &&
      observer.coverage[Math.floor(b.az)] && observer.coverage[Math.ceil(b.az)%360]))
  }
  const runs = (values: Float64Array, limit: number) => {
    const next = new Int32Array(n+1).fill(n)
    const run = new Int32Array(n+1)
    for (let i=n-1;i>=0;i--) run[i]=values[i]?1+run[i+1]:0
    const allowed=Math.floor(limit*60/meta.stepMinutes+1e-9)
    for (let i=n-1;i>=0;i--) next[i]=run[i]>allowed?i:next[i+1]
    return {next,allowed}
  }
  const a=runs(sun,limits.dark), b=runs(earth,limits.earth)
  const good: number[]=[]
  if (observer.slope!=null && observer.slope>limits.slope) return good
  for (let start=0;start+steps<=n;start+=60/meta.stepMinutes) {
    const end=start+steps
    if (a.next[start]+a.allowed<end || b.next[start]+b.allowed<end || gaps[end]!==gaps[start]) continue
    good.push(start)
  }
  return good
}

interface SearchScratch {
  n: number
  sun96: Uint8Array
  earth96: Uint8Array
  sun48: Uint8Array
  earth48: Uint8Array
  gaps: Uint32Array
  nextSun96: Int32Array
  nextEarth96: Int32Array
  nextSun48: Int32Array
  nextEarth48: Int32Array
}
let scratch: SearchScratch | null = null
function getSearchScratch(n: number): SearchScratch {
  if (scratch && scratch.n >= n) return scratch
  scratch = {
    n,
    sun96: new Uint8Array(n),
    earth96: new Uint8Array(n),
    sun48: new Uint8Array(n),
    earth48: new Uint8Array(n),
    gaps: new Uint32Array(n + 1),
    nextSun96: new Int32Array(n + 1),
    nextEarth96: new Int32Array(n + 1),
    nextSun48: new Int32Array(n + 1),
    nextEarth48: new Int32Array(n + 1),
  }
  return scratch
}

/**
 * Single-pass, zero-allocation dual-horizon search evaluating both the primary (96 km)
 * and reference (48 km) terrain profiles with a single topocentric direction pass.
 */
export function searchObserverDual(observer: Observer, vectors: Float64Array, steps: number, meta: Metadata, limits: Limits, sigma = 0) {
  const good: number[] = []
  if (observer.slope != null && observer.slope > limits.slope) return good
  const n = meta.count - 1
  if (n <= 0) return good
  const frame = basis(observer)
  const sc = getSearchScratch(n)
  const { sun96, earth96, sun48, earth48, gaps, nextSun96, nextEarth96, nextSun48, nextEarth48 } = sc
  const up0 = frame.up[0], up1 = frame.up[1], up2 = frame.up[2]
  const n0 = frame.north[0], n1 = frame.north[1], n2 = frame.north[2]
  const e0 = frame.east[0], e1 = frame.east[1], e2 = frame.east[2]
  const rx = frame.r * up0, ry = frame.r * up1, rz = frame.r * up2
  const h96 = observer.horizon
  const h48 = observer.reference
  const err = observer.horizonError
  const cov = observer.coverage

  gaps[0] = 0
  for (let i = 0; i < n; i++) {
    const off = i * 12
    const sx = vectors[off] - rx, sy = vectors[off + 1] - ry, sz = vectors[off + 2] - rz
    const se = sx * e0 + sy * e1 + sz * e2
    const sn = sx * n0 + sy * n1 + sz * n2
    const su = sx * up0 + sy * up1 + sz * up2
    const saz = (Math.atan2(se, sn) / rad + 360) % 360
    const sel = Math.atan2(su, Math.hypot(sn, se)) / rad

    const ex = vectors[off + 3] - rx, ey = vectors[off + 4] - ry, ez = vectors[off + 5] - rz
    const ee = ex * e0 + ey * e1 + ez * e2
    const en = ex * n0 + ey * n1 + ez * n2
    const eu = ex * up0 + ey * up1 + ez * up2
    const eaz = (Math.atan2(ee, en) / rad + 360) % 360
    const eel = Math.atan2(eu, Math.hypot(en, ee)) / rad

    const si = Math.floor(saz), siNext = (si + 1) % 360, sf = saz - si
    const ei = Math.floor(eaz), eiNext = (ei + 1) % 360, ef = eaz - ei

    const sErr = sigma !== 0 && err ? (err[si] + (err[siNext] - err[si]) * sf) * sigma : 0
    const eErr = sigma !== 0 && err ? (err[ei] + (err[eiNext] - err[ei]) * ef) * sigma : 0

    const sh96 = h96[si] + (h96[siNext] - h96[si]) * sf + sErr
    const sh48 = h48[si] + (h48[siNext] - h48[si]) * sf + sErr
    sun96[i] = diskFraction(sel - sh96) < solarThreshold ? 1 : 0
    sun48[i] = diskFraction(sel - sh48) < solarThreshold ? 1 : 0

    const eh96 = h96[ei] + (h96[eiNext] - h96[ei]) * ef + eErr
    const eh48 = h48[ei] + (h48[eiNext] - h48[ei]) * ef + eErr
    earth96[i] = eel <= eh96 ? 1 : 0
    earth48[i] = eel <= eh48 ? 1 : 0

    const ceilS = Math.ceil(saz) % 360
    const ceilE = Math.ceil(eaz) % 360
    gaps[i + 1] = gaps[i] + (cov[si] && cov[ceilS] && cov[ei] && cov[ceilE] ? 0 : 1)
  }

  const allowedDark = Math.floor((limits.dark * 60) / meta.stepMinutes + 1e-9)
  const allowedEarth = Math.floor((limits.earth * 60) / meta.stepMinutes + 1e-9)
  let rS96 = 0, rE96 = 0, rS48 = 0, rE48 = 0
  let curS96 = n, curE96 = n, curS48 = n, curE48 = n
  nextSun96[n] = n
  nextEarth96[n] = n
  nextSun48[n] = n
  nextEarth48[n] = n
  for (let i = n - 1; i >= 0; i--) {
    rS96 = sun96[i] ? rS96 + 1 : 0
    curS96 = rS96 > allowedDark ? i : curS96
    nextSun96[i] = curS96

    rE96 = earth96[i] ? rE96 + 1 : 0
    curE96 = rE96 > allowedEarth ? i : curE96
    nextEarth96[i] = curE96

    rS48 = sun48[i] ? rS48 + 1 : 0
    curS48 = rS48 > allowedDark ? i : curS48
    nextSun48[i] = curS48

    rE48 = earth48[i] ? rE48 + 1 : 0
    curE48 = rE48 > allowedEarth ? i : curE48
    nextEarth48[i] = curE48
  }

  const stepInc = 60 / meta.stepMinutes
  for (let start = 0; start + steps <= n; start += stepInc) {
    const end = start + steps
    if (
      nextSun96[start] + allowedDark < end ||
      nextEarth96[start] + allowedEarth < end ||
      nextSun48[start] + allowedDark < end ||
      nextEarth48[start] + allowedEarth < end ||
      gaps[end] !== gaps[start]
    ) {
      continue
    }
    good.push(start)
  }
  return good
}

export function evaluateWindowSummary(
  observer: Observer,
  vectors: Float64Array,
  startStep: number,
  steps: number,
  meta: Metadata,
  sigma = 0,
) {
  const frame = basis(observer)
  const dt = meta.stepMinutes / 60
  let darkRun = 0, maxDark = 0, earthRun = 0, maxEarth = 0
  let refDarkRun = 0, refMaxDark = 0, refEarthRun = 0, refMaxEarth = 0
  let solarSteps = 0, dsnSteps = 0
  let complete = true

  for (let k = 0; k < steps; k++) {
    const idx = startStep + k
    const i = idx * 12
    const sun = direction(vectors, i, frame)
    const earth = direction(vectors, i + 3, frame)
    const station = direction(vectors, i + 6, frame)
    const sunErr = sigma !== 0 && observer.horizonError ? horizonAt(observer.horizonError, sun.az) * sigma : 0
    const earthErr = sigma !== 0 && observer.horizonError ? horizonAt(observer.horizonError, earth.az) * sigma : 0
    const stErr = sigma !== 0 && observer.horizonError ? horizonAt(observer.horizonError, station.az) * sigma : 0

    const sDark = diskFraction(sun.el - (horizonAt(observer.horizon, sun.az) + sunErr)) < solarThreshold
    const eBlock = earth.el <= horizonAt(observer.horizon, earth.az) + earthErr
    const rsDark = diskFraction(sun.el - (horizonAt(observer.reference, sun.az) + sunErr)) < solarThreshold
    const reBlock = earth.el <= horizonAt(observer.reference, earth.az) + earthErr

    if (!sDark) solarSteps++
    darkRun = sDark ? darkRun + 1 : 0; if (darkRun > maxDark) maxDark = darkRun
    earthRun = eBlock ? earthRun + 1 : 0; if (earthRun > maxEarth) maxEarth = earthRun
    refDarkRun = rsDark ? refDarkRun + 1 : 0; if (refDarkRun > refMaxDark) refMaxDark = refDarkRun
    refEarthRun = reBlock ? refEarthRun + 1 : 0; if (refEarthRun > refMaxEarth) refMaxEarth = refEarthRun

    if (!(observer.coverage[Math.floor(sun.az)] && observer.coverage[Math.ceil(sun.az) % 360] &&
          observer.coverage[Math.floor(earth.az)] && observer.coverage[Math.ceil(earth.az) % 360])) {
      complete = false
    }

    const stHor = horizonAt(observer.horizon, station.az) + stErr
    const x = frame.up[0] * frame.r - vectors[i + 6], y = frame.up[1] * frame.r - vectors[i + 7], z = frame.up[2] * frame.r - vectors[i + 8]
    const stationUp = Math.asin(Math.max(-1, Math.min(1, (x * vectors[i + 9] + y * vectors[i + 10] + z * vectors[i + 11]) / Math.hypot(x, y, z)))) / rad
    const dsn = evalDsnComplexes(
      vectors, i, frame, observer.horizon, 0, observer.horizonError, 0,
      observer.coverage, 0, meta.station.maskDeg, sigma, station, stHor, stationUp,
    )
    if (dsn.dsnAccess) dsnSteps++
  }

  return {
    longestDark: maxDark * dt,
    longestEarth: maxEarth * dt,
    referenceLongestDark: refMaxDark * dt,
    referenceLongestEarth: refMaxEarth * dt,
    solarPct: steps > 0 ? Math.round((solarSteps / steps) * 100) : 0,
    dsnHours: dsnSteps * dt,
    complete,
  }
}

export function computePadViabilityMap(opts: {
  meta: Metadata
  horizons: Float32Array
  reference: Float32Array
  horizonError: Float32Array
  coverage: Uint8Array
  slopes: Float32Array | null
  mast: number
  mastHeightM: number
  vectors: Float64Array
  startHour: number
  steps: number
  limits: Limits
  sigma?: number
}) {
  const { meta, horizons, reference, horizonError, coverage, slopes, mast, mastHeightM, vectors, startHour, steps, limits } = opts
  const sigma = opts.sigma ?? 0
  const nodeCount = meta.observers.length
  const viability = new Uint8Array(nodeCount)
  const solarPct = new Uint8Array(nodeCount)
  const startStep = startHour * Math.round(60 / meta.stepMinutes)
  const allowedDark = Math.floor((limits.dark * 60) / meta.stepMinutes + 1e-9)
  const allowedEarth = Math.floor((limits.earth * 60) / meta.stepMinutes + 1e-9)

  for (let node = 0; node < nodeCount; node++) {
    const [lat, lon, height] = meta.observers[node]
    const a = lat * rad, b = lon * rad
    const u0 = Math.cos(a) * Math.cos(b), u1 = Math.cos(a) * Math.sin(b), u2 = Math.sin(a)
    const n0 = -Math.sin(a) * Math.cos(b), n1 = -Math.sin(a) * Math.sin(b), n2 = Math.cos(a)
    const e0 = -Math.sin(b), e1 = Math.cos(b), e2 = 0
    const r = radius + height + mastHeightM
    const rx = r * u0, ry = r * u1, rz = r * u2

    const hOff = (node * 5 + mast) * 360
    const errOff = node * 360
    const covOff = node * 360
    const slopeBad = slopes != null && slopes[node] > limits.slope

    let darkRun = 0, maxDark = 0, earthRun = 0, maxEarth = 0
    let refDarkRun = 0, refMaxDark = 0, refEarthRun = 0, refMaxEarth = 0
    let solarSteps = 0
    let hasGap = false

    for (let k = 0; k < steps; k++) {
      const off = (startStep + k) * 12
      const sun = directionOffset(vectors[off], vectors[off + 1], vectors[off + 2], rx, ry, rz, e0, e1, e2, n0, n1, n2, u0, u1, u2)
      const earth = directionOffset(vectors[off + 3], vectors[off + 4], vectors[off + 5], rx, ry, rz, e0, e1, e2, n0, n1, n2, u0, u1, u2)

      const si = Math.floor(sun.az), siNext = (si + 1) % 360, sf = sun.az - si
      const ei = Math.floor(earth.az), eiNext = (ei + 1) % 360, ef = earth.az - ei
      const sErr = sigma !== 0 ? (horizonError[errOff + si] + (horizonError[errOff + siNext] - horizonError[errOff + si]) * sf) * sigma : 0
      const eErr = sigma !== 0 ? (horizonError[errOff + ei] + (horizonError[errOff + eiNext] - horizonError[errOff + ei]) * ef) * sigma : 0

      const sh96 = horizons[hOff + si] + (horizons[hOff + siNext] - horizons[hOff + si]) * sf + sErr
      const sh48 = reference[hOff + si] + (reference[hOff + siNext] - reference[hOff + si]) * sf + sErr
      const eh96 = horizons[hOff + ei] + (horizons[hOff + eiNext] - horizons[hOff + ei]) * ef + eErr
      const eh48 = reference[hOff + ei] + (reference[hOff + eiNext] - reference[hOff + ei]) * ef + eErr

      const sDark = diskFraction(sun.el - sh96) < solarThreshold
      const eBlock = earth.el <= eh96
      const rsDark = diskFraction(sun.el - sh48) < solarThreshold
      const reBlock = earth.el <= eh48

      if (!sDark) solarSteps++
      darkRun = sDark ? darkRun + 1 : 0; if (darkRun > maxDark) maxDark = darkRun
      earthRun = eBlock ? earthRun + 1 : 0; if (earthRun > maxEarth) maxEarth = earthRun
      refDarkRun = rsDark ? refDarkRun + 1 : 0; if (refDarkRun > refMaxDark) refMaxDark = refDarkRun
      refEarthRun = reBlock ? refEarthRun + 1 : 0; if (refEarthRun > refMaxEarth) refMaxEarth = refEarthRun

      if (!(coverage[covOff + si] && coverage[covOff + ((Math.ceil(sun.az)) % 360)] &&
            coverage[covOff + ei] && coverage[covOff + ((Math.ceil(earth.az)) % 360)])) {
        hasGap = true
      }
    }

    solarPct[node] = steps > 0 ? Math.round((solarSteps / steps) * 100) : 0
    if (hasGap || slopeBad || maxDark > allowedDark) {
      viability[node] = 0
    } else if (refMaxDark <= allowedDark && maxEarth <= allowedEarth && refMaxEarth <= allowedEarth) {
      viability[node] = 2
    } else {
      viability[node] = 1
    }
  }
  return { viability, solarPct }
}

export function costTradeoff(massAvoided: number, incrementalEquipment: number, rate: number | null) {
  const breakEven = massAvoided !== 0 ? incrementalEquipment/massAvoided : null
  return {breakEven:breakEven!=null && breakEven>=0 ? breakEven : null,
    avoided: rate==null ? null : massAvoided*rate-incrementalEquipment}
}
