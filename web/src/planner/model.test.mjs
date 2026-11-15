import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { analyze, arrayEfficiency, computePadViabilityMap, countdown, earthEclipseFactorFromVecs, evaluateWindowSummary, intervals, diskFraction, horizonAt, searchObserverDual, solarSemiDiameterDeg, storage, defaultPower, costTradeoff, searchObserver } from './model.ts'
import { createWasmSearchEngine } from './wasmSearch.ts'

test('horizon interpolates across north and finite solar disk crosses smoothly',()=>{
  const h=new Float32Array(360)
  h[359]=2
  assert.equal(horizonAt(h,359.5),1)
  assert.equal(diskFraction(-1),0)
  assert.equal(diskFraction(0),.5)
  assert.equal(diskFraction(1),1)
})
test('events are half-open and identify clipped mission boundaries',()=>{
  assert.deepEqual(intervals([true,false,true,true],.5),[
    {start:0,end:1,hours:.5,atStart:true,atEnd:false},
    {start:2,end:4,hours:1,atStart:false,atEnd:true},
  ])
  assert.deepEqual(intervals([false],1),[])
})
test('storage can recharge and the discharge cap flags intrinsically unmet load',()=>{
  const simple={...defaultPower,loadW:95}
  assert.equal(storage([0,400,0],simple,1).usableWh,100)
  assert.equal(storage([0],{...simple,loadW:400},1).unmetWh,100)
  assert.equal(storage([0],{...simple,budgetKg:20},1).unmetWh,95)
})
test('cost deltas use supplied rates and identify a break-even point',()=>{
  assert.deepEqual(costTradeoff(10,100,5),{breakEven:10,avoided:-50})
  assert.deepEqual(costTradeoff(10,100,20),{breakEven:10,avoided:100})
  assert.equal(costTradeoff(10,100,null).avoided,null)
})
test('station elevation can fail while Earth center is clear; all-window search excludes missing coverage',()=>{
  const observer={coordinates:[0,0,0],mast:0,slope:1,horizon:new Float32Array(360),
    reference:new Float32Array(360),distance:new Float32Array(360),coverage:new Uint8Array(360).fill(1)}
  const vectors=new Float64Array(25*12)
  for(let i=0;i<25;i++) vectors.set([1e8,0,0,1e8,0,0,1e8,0,0,1,0,0],i*12)
  const m={count:25,stepMinutes:5,station:{maskDeg:10}}
  const r=analyze(observer,vectors,0,12,m,defaultPower)
  assert.equal(r.earthHours,1)
  assert.equal(r.stationHours,0)
  assert.deepEqual(searchObserver(observer,vectors,12,m,{dark:0,earth:0,slope:5}),[0,12])
  observer.coverage.fill(0)
  assert.deepEqual(searchObserver(observer,vectors,12,m,{dark:0,earth:0,slope:5}),[])
})

test('a second array reduces unmet load, but hardware and losses can undo the mass benefit',async()=>{
  const {complementaryPower}=await import('./model.ts')
  const p={...defaultPower,loadW:95,hardwareKg:0,budgetKg:0}
  const help=complementaryPower([0],[125],p,125,.8,0,1)
  assert.equal(help.avoidedUnmetWh,95)
  const penalty=complementaryPower([0],[125],p,125,.1,10,1)
  assert.ok(penalty.installedMassDeltaKg>0)
})

test('countdown reports exact hours to next sunset/Earthset or sunrise/Earthrise',()=>{
  const states=[false,false,true,true,true,false]
  assert.deepEqual(countdown(states,0,.5),{visible:true,hoursRemaining:1,nextIndex:2,persistsToEnd:false})
  assert.deepEqual(countdown(states,2,.5),{visible:false,hoursRemaining:1.5,nextIndex:5,persistsToEnd:false})
  assert.deepEqual(countdown(states,5,.5),{visible:true,hoursRemaining:.5,nextIndex:null,persistsToEnd:true})
})

test('array geometry models polar grazing cosine losses vs equatorial overhead Sun',()=>{
  assert.equal(arrayEfficiency(1.5,'tracked'),1)
  assert.ok(arrayEfficiency(1.5,'vertical')>0.999)
  assert.ok(arrayEfficiency(1.5,'horizontal')<0.03)
  assert.ok(arrayEfficiency(90,'horizontal')>0.999)

  const observer={coordinates:[0,0,0],mast:0,slope:1,horizon:new Float32Array(360),
    reference:new Float32Array(360),distance:new Float32Array(360),coverage:new Uint8Array(360).fill(1)}
  const vectors=new Float64Array(13*12)
  const r=1e8, el=1.5*Math.PI/180
  for(let i=0;i<13;i++) vectors.set([r*Math.sin(el),0,r*Math.cos(el),r,0,0,r,0,0,1,0,0],i*12)
  const m={count:13,stepMinutes:5,station:{maskDeg:10}}
  const vert=analyze(observer,vectors,0,12,m,{...defaultPower,arrayMode:'vertical'})
  const horiz=analyze(observer,vectors,0,12,m,{...defaultPower,arrayMode:'horizontal'})
  assert.ok(vert.generation[0]>395)
  assert.ok(horiz.generation[0]<15)
})

test('horizon uncertainty sigma reduces effective sky margin and increases dark/blackout hours',()=>{
  const observer={coordinates:[0,0,0],mast:0,slope:1,horizon:new Float32Array(360),
    reference:new Float32Array(360),horizonError:new Float32Array(360).fill(2),
    distance:new Float32Array(360),coverage:new Uint8Array(360).fill(1)}
  const vectors=new Float64Array(13*12)
  const r=1e8, el=1.0*Math.PI/180
  for(let i=0;i<13;i++) vectors.set([r*Math.sin(el),0,r*Math.cos(el),r*Math.sin(el),0,r*Math.cos(el),r,0,0,1,0,0],i*12)
  const m={count:13,stepMinutes:5,station:{maskDeg:10}}
  const nominal=analyze(observer,vectors,0,12,m,{...defaultPower,sigma:0})
  const conservative=analyze(observer,vectors,0,12,m,{...defaultPower,sigma:1})
  assert.equal(nominal.solarHours,1)
  assert.equal(nominal.earthHours,1)
  assert.equal(conservative.solarHours,0)
  assert.equal(conservative.earthHours,0)
})

test('station azimuth can lack terrain coverage while Sun and Earth remain covered', () => {
  const observer = { coordinates: [0, 0, 0], mast: 0, slope: 1,
    horizon: new Float32Array(360), reference: new Float32Array(360),
    distance: new Float32Array(360), coverage: new Uint8Array(360).fill(1) }
  observer.coverage[90] = 0
  const vectors = new Float64Array([1e8, 0, 0, 1e8, 0, 0, 1e8, 1e6, 0, -1, 0, 0])
  const r = analyze(observer, vectors, 0, 1, { stepMinutes: 5, station: { maskDeg: 10 } }, defaultPower)
  assert.equal(r.complete, true)
  assert.equal(r.sky[0].stationCovered, false)
  assert.equal(r.stationUnknownHours, 1 / 12)
  assert.equal(r.disagreementHours, 0)
  // Degenerate zero s_ME falls back safely to Goldstone DSS-14 behavior
  assert.equal(r.dsnHours, 0)
})

test('3-complex NASA DSN hands off across Goldstone, Madrid, and Canberra when DSS-14 is on Earth far side', () => {
  const DSS14 = [-2353621.365667699, -4641341.49114994, 3677052.329319744]
  const DSS63 = [4849092.518, -360180.348, 4115109.251]
  const wgs = [6378137 ** 2, 6378137 ** 2, 6356752.314245 ** 2]
  const norm = (v) => { const m = Math.hypot(v[0], v[1], v[2]); return [v[0] / m, v[1] / m, v[2] / m] }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const up14 = norm([DSS14[0] / wgs[0], DSS14[1] / wgs[1], DSS14[2] / wgs[2]])
  const up65 = norm([DSS63[0] / wgs[0], DSS63[1] / wgs[1], DSS63[2] / wgs[2]])

  // Construct an orthonormal rotation mapping DSS-63 zenith directly toward the Moon (-X in Moon_ME)
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const r0 = [-up65[0], -up65[1], -up65[2]]
  const zTry = Math.abs(r0[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]
  const r1 = norm(cross(zTry, r0))
  const r2 = cross(r0, r1)
  const rot = (v) => [dot(r0, v), dot(r1, v), dot(r2, v)]

  const s14 = rot(DSS14)
  const u14 = rot(up14)
  const earth = 3.84e8
  const vectors = new Float64Array([
    earth, 0, 0,
    earth, 0, 0,
    earth + s14[0], s14[1], s14[2],
    u14[0], u14[1], u14[2],
  ])
  const observer = { coordinates: [0, 0, 0], mast: 0, slope: 1,
    horizon: new Float32Array(360), reference: new Float32Array(360),
    distance: new Float32Array(360), coverage: new Uint8Array(360).fill(1) }
  const r = analyze(observer, vectors, 0, 1, { stepMinutes: 5, station: { maskDeg: 10 } }, defaultPower)
  assert.equal(r.stationHours, 0)
  assert.equal(r.sky[0].dss14Access, false)
  assert.equal(r.sky[0].dss63Access, true)
  assert.equal(r.sky[0].dsnAccess, true)
  assert.equal(r.sky[0].dsnActiveStation, 'DSS-63 Madrid')
  assert.equal(r.dsnHours, 1 / 12)
  assert.equal(r.longestDsnBlackout, 0)
})

test('computePadViabilityMap classifies viable, Earth-constrained, and slope/darkness-blocked pads identically to analyze', () => {
  const horizons = new Float32Array(3 * 5 * 360)
  const reference = new Float32Array(3 * 5 * 360)
  horizons.fill(25, 2 * 5 * 360, 3 * 5 * 360) // Pad 2 obstructed all around (+25 deg)
  reference.fill(25, 2 * 5 * 360, 3 * 5 * 360)
  horizons.fill(-2, 1 * 5 * 360, 2 * 5 * 360)
  // Pad 1 blocked only toward Earth (east az=90 deg -> 15 deg horizon)
  for (let m = 0; m < 5; m++) horizons[1 * 5 * 360 + m * 360 + 90] = 15
  const coverage = new Uint8Array(3 * 360).fill(1)
  const err = new Float32Array(3 * 360)
  const vectors = new Float64Array(12 * 12)
  // For lat=0, lon=0: up=+X, east=+Y, north=+Z. Sun at north+up (az=0, el~10 deg), Earth at east+up (az=90, el~10 deg)
  for (let i = 0; i < 12; i++) vectors.set([2e7, 0, 1e8, 2e7, 1e8, 0, 2e7, 1e8, 0, 1, 0, 0], i * 12)
  const meta = { count: 12, stepMinutes: 5, station: { maskDeg: 10 }, observers: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }
  const { viability, solarPct } = computePadViabilityMap({
    meta, horizons, reference, horizonError: err, coverage,
    slopes: new Float32Array([2, 2, 2]),
    mast: 0, mastHeightM: 1.5, vectors, startHour: 0, steps: 12,
    limits: { dark: 0.2, earth: 0.2, slope: 5 }, sigma: 0,
  })
  assert.deepEqual(Array.from(viability), [2, 1, 0])
  assert.deepEqual(Array.from(solarPct), [100, 100, 0])

  const obs0 = { coordinates: [0, 0, 0], mast: 1.5, slope: 2, horizon: horizons.slice(0, 360), reference: reference.slice(0, 360), distance: new Float32Array(360), coverage: coverage.slice(0, 360) }
  const summary = evaluateWindowSummary(obs0, vectors, 0, 12, meta, 0)
  assert.equal(summary.solarPct, 100)
  assert.equal(summary.longestDark, 0)
  assert.equal(summary.complete, true)
})

test('solarSemiDiameterDeg tracks perihelion vs aphelion angular radius and diskFraction honors radius', () => {
  const peri = solarSemiDiameterDeg(1.471e11)
  const aph = solarSemiDiameterDeg(1.521e11)
  assert.ok(peri > 0.270 && peri < 0.272)
  assert.ok(aph > 0.261 && aph < 0.263)
  assert.ok(peri > aph)
  assert.equal(diskFraction(0.269, peri) < 1, true)
  assert.equal(diskFraction(0.269, aph), 1)
  assert.equal(diskFraction(-0.269, peri) > 0, true)
  assert.equal(diskFraction(-0.269, aph), 0)
})

test('earthEclipseFactorFromVecs detects umbra/penumbra lunar eclipses while ignoring normal geometry', () => {
  // Normal geometry: Earth along +X, Sun along +Y (orthogonal) -> full unoccluded solar fraction
  assert.equal(earthEclipseFactorFromVecs(0, 1.5e11, 0, 3.84e8, 0, 0), 1)
  // Near-Earth small test sentinel guard (< 1e8 m or < 1e11 m sun): unoccluded
  assert.equal(earthEclipseFactorFromVecs(1.5e8, 0, 0, 3.84e5, 0, 0), 1)
  // Exact total lunar eclipse: Earth centered along Sun direction from Moon
  assert.equal(earthEclipseFactorFromVecs(1.5e11, 0, 0, 3.84e8, 0, 0), 0)
  // Partial penumbral/umbral grazing offset (~0.7 deg off-axis from Earth center)
  const partial = earthEclipseFactorFromVecs(1.5e11, 0, 0, 3.84e8, Math.tan(0.7 * Math.PI / 180) * 3.84e8, 0)
  assert.ok(partial > 0 && partial < 1)
})

test('WASM searchSiteDual matches searchObserverDual identically across multi-pad site pack', async () => {
  const wasmUrl = new URL('../../public/wasm/umbra_core.wasm', import.meta.url)
  const wasmBytes = await readFile(wasmUrl)
  const wasm = await createWasmSearchEngine(wasmBytes)

  const hGood = new Float32Array(360).fill(-2)
  const hBlocked = new Float32Array(360).fill(25)
  const ref = new Float32Array(360).fill(-2)
  const cov = new Uint8Array(360).fill(1)
  const err = new Float32Array(360).fill(0)
  const obsList = [
    { coordinates: [0, 0, 0], mast: 5, slope: 2.5, horizon: hGood, reference: ref, horizonError: err, distance: new Float32Array(360), coverage: cov },
    { coordinates: [0, 0, 0], mast: 5, slope: 7.5, horizon: hGood, reference: ref, horizonError: err, distance: new Float32Array(360), coverage: cov },
    { coordinates: [0, 0, 0], mast: 5, slope: 1.5, horizon: hBlocked, reference: hBlocked, horizonError: err, distance: new Float32Array(360), coverage: cov },
  ]

  // Build 48h (48*12 + 1 steps) of 5-minute vectors with Sun and Earth well above -2 deg horizon at az=0 / az=90
  const steps = 12 * 12 // 12h window
  const totalSteps = 24 * 12 + 1 // 24h trace
  const vectors = new Float64Array(totalSteps * 12)
  for (let i = 0; i < totalSteps; i++) {
    vectors.set([1.5e11, 0, 3e10, 3e7, 3.84e8, 0, 3e7, 3.84e8, 0, 1, 0, 0], i * 12)
  }
  const meta = { count: totalSteps, stepMinutes: 5, station: { maskDeg: 10 }, observers: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }
  const limits = { dark: 2, earth: 2, slope: 5 }
  const batch = wasm.searchSiteDual({
    siteKey: 'unit-pack',
    nodeCount: 3,
    mastM: 5,
    vectors,
    steps,
    meta,
    limits,
    sigma: 0,
    minStep: 0,
    maxStep: totalSteps - 1 - steps,
    getObserver: idx => obsList[idx],
  })

  for (let idx = 0; idx < 3; idx++) {
    const tsSteps = obsList[idx].slope <= limits.slope
      ? searchObserverDual(obsList[idx], vectors, steps, meta, limits, 0)
      : []
    const tsHours = Array.from(new Set(tsSteps.map(s => Math.round((s * meta.stepMinutes) / 60))))
    assert.deepEqual(batch.get(idx) ?? [], tsHours)
  }
  assert.ok((batch.get(0) ?? []).length > 0)
  assert.equal(batch.has(1), false)
  assert.equal(batch.has(2), false)
})
