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

function direction(vectors: Float64Array, offset: number, frame: ReturnType<typeof basis>) {
  const x = vectors[offset] - frame.r*frame.up[0]
  const y = vectors[offset+1] - frame.r*frame.up[1]
  const z = vectors[offset+2] - frame.r*frame.up[2]
  const dot = (axis: number[]) => x*axis[0]+y*axis[1]+z*axis[2]
  return { az: (Math.atan2(dot(frame.east), dot(frame.north))/rad+360)%360,
    el: Math.atan2(dot(frame.up), Math.hypot(dot(frame.north),dot(frame.east)))/rad }
}
type Direction = ReturnType<typeof direction>
export interface Sky {
  sun: Direction; earth: Direction; station: Direction
  sunHorizon: number; earthHorizon: number; sunSigma: number; earthSigma: number
  sunMargin: number; earthMargin: number; stationUp: number
  stationAccess: boolean; solar: number; incidenceFactor: number; regionalComplete: boolean; obstructionM: number
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
  const covered = (az: number) => observer.coverage[Math.floor(az)] && observer.coverage[Math.ceil(az)%360]
  return {sun, earth, station, sunHorizon, earthHorizon, sunSigma, earthSigma, sunMargin, earthMargin, stationUp,
    stationAccess: stationUp >= mask && station.el > stationHorizon,
    solar: diskFraction(sunMargin), incidenceFactor: arrayEfficiency(sun.el, arrayMode),
    regionalComplete: Boolean(covered(sun.az) && covered(earth.az)),
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
  return {sky,dark,earth,station,generation,solarHours:steps*dt-dark.reduce((n,e)=>n+e.hours,0),
    earthHours:steps*dt-earth.reduce((n,e)=>n+e.hours,0),stationHours:station.reduce((n,e)=>n+e.hours,0),
    disagreementHours:sky.filter(s=>s.stationAccess!==(s.earthMargin>0)).length*dt,
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

export function costTradeoff(massAvoided: number, incrementalEquipment: number, rate: number | null) {
  const breakEven = massAvoided !== 0 ? incrementalEquipment/massAvoided : null
  return {breakEven:breakEven!=null && breakEven>=0 ? breakEven : null,
    avoided: rate==null ? null : massAvoided*rate-incrementalEquipment}
}
