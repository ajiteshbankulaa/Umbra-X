import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { analyze, defaultPower, searchObserver, searchObserverDual } from './model.ts'
import { createWasmSearchEngine } from './wasmSearch.ts'

const here = dirname(fileURLToPath(import.meta.url))
const releaseRoot = resolve(here, '../../public/data/planner-release')
export const wasmPath = resolve(here, '../../public/wasm/umbra_core.wasm')
export const polarSites = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']

async function readBinary(relPath, expectedHash) {
  const buf = await readFile(resolve(releaseRoot, relPath))
  if (expectedHash) {
    const actual = createHash('sha256').update(buf).digest('hex')
    assert.equal(actual, expectedHash, `Hash mismatch for ${relPath}`)
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

export async function loadPolarSiteBundle(site) {
  const manifest = JSON.parse(await readFile(resolve(releaseRoot, site, 'manifest.json'), 'utf8'))
  const meta = JSON.parse(await readFile(resolve(releaseRoot, site, 'planner.json'), 'utf8'))
  const [vecBuf, hLocalBuf, errBuf, slopeBuf, psrBuf, h96Buf, h48Buf, distBuf, covBuf] = await Promise.all([
    readBinary(`planner/${meta.vectorHash}.bin`, meta.vectorHash),
    readBinary(`${site}/horizons.bin`, meta.localHash),
    readBinary(`${site}/horizons_err.bin`),
    readBinary(`${site}/dem_slope.bin`),
    readBinary(`${site}/psr_mask.bin`),
    readBinary(`planner/${meta.regional.regional}.bin`, meta.regional.regional),
    readBinary(`planner/${meta.regional.sensitivity}.bin`, meta.regional.sensitivity),
    readBinary(`planner/${meta.regional.distance}.bin`, meta.regional.distance),
    readBinary(`planner/${meta.regional.coverage}.bin`, meta.regional.coverage),
  ])
  return {
    site,
    manifest,
    meta,
    vectors: new Float64Array(vecBuf),
    localHorizons: new Float32Array(hLocalBuf),
    horizonErr: new Float32Array(errBuf),
    slope: new Float32Array(slopeBuf),
    psr: new Uint8Array(psrBuf),
    h96: new Float32Array(h96Buf),
    h48: new Float32Array(h48Buf),
    dist: new Float32Array(distBuf),
    cov: new Uint8Array(covBuf),
  }
}

export function buildObserver(bundle, node, mast) {
  const g = bundle.manifest.analysis_grid
  const row = Math.floor(node / 31)
  const col = node % 31
  const px = (g.start_pixel + g.step_pixel * row) * 256 + (g.start_pixel + g.step_pixel * col)
  const off = (node * 5 + mast) * 360
  return {
    coordinates: bundle.meta.observers[node],
    horizon: bundle.h96.subarray(off, off + 360),
    reference: bundle.h48.subarray(off, off + 360),
    horizonError: bundle.horizonErr.subarray(node * 360, (node + 1) * 360),
    distance: bundle.dist.subarray(off, off + 360),
    coverage: bundle.cov.subarray(node * 360, (node + 1) * 360),
    mast: bundle.manifest.mast_heights_m[mast],
    slope: bundle.slope[px],
    psr: bundle.psr[px],
  }
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function summarize(times) {
  const cold = times[0]
  const warm = times.slice(1).sort((a, b) => a - b)
  return {
    coldMs: cold,
    p50Ms: percentile(warm, 50),
    p95Ms: percentile(warm, 95),
  }
}

async function main() {
  const tLoad0 = performance.now()
  const bundles = await Promise.all(polarSites.map(loadPolarSiteBundle))
  const loadMs = performance.now() - tLoad0
  console.log(`Loaded & SHA-256 verified 3 polar release bundles in ${loadMs.toFixed(1)} ms`)

  // Phase 1 check: opening 48h Shackleton Ridge launch-delay decision chain (pad 481 -> node 480, 5 m mast)
  const shack = bundles[0]
  const pad481 = buildObserver(shack, 480, 2)
  const r0 = analyze(pad481, shack.vectors, 0, 15 * 24 * 12, shack.meta, defaultPower)
  const r48 = analyze(pad481, shack.vectors, 48 * 12, 15 * 24 * 12, shack.meta, defaultPower)
  console.log(
    `\n[Phase 1 Decision Chain — Shackleton Ridge Pad 481 (5 m mast)]\n` +
      `  start +0h : longestDark=${r0.longestDark.toFixed(1)}h, longestEarth=${r0.longestEarth.toFixed(1)}h, slope=${r0.slope.toFixed(2)}°, battery=${r0.batteryKg.toFixed(1)}kg, feasible=${r0.feasible}\n` +
      `  start +48h: longestDark=${r48.longestDark.toFixed(1)}h, longestEarth=${r48.longestEarth.toFixed(1)}h, slope=${r48.slope.toFixed(2)}°, battery=${r48.batteryKg.toFixed(1)}kg, feasible=${r48.feasible}`,
  )
  assert.ok(r0.slope > 5)

  const wasmBytes = await readFile(wasmPath)
  const wasmGzipBytes = gzipSync(wasmBytes).byteLength
  const tWasmInit0 = performance.now()
  const wasm = await createWasmSearchEngine(wasmBytes)
  const wasmInitMs = performance.now() - tWasmInit0

  const steps = 15 * 24 * 12
  const limits = { dark: 48, earth: 72, slope: 5 }
  const mast = 2

  const runSearch = fn => {
    const keys = []
    for (const bundle of bundles) {
      for (let node = 0; node < 961; node++) {
        const obs = buildObserver(bundle, node, mast)
        if (obs.slope == null || obs.slope > limits.slope) continue
        const starts = fn(obs, bundle.vectors, steps, bundle.meta, limits, 0)
        for (const s of starts) keys.push(`${bundle.site}:${node}:${s}`)
      }
    }
    return keys
  }

  const runBaseline = (obs, vectors, st, meta, lim, sigma) => {
    const a = searchObserver(obs, vectors, st, meta, lim, sigma)
    const b = new Set(searchObserver({ ...obs, horizon: obs.reference }, vectors, st, meta, lim, sigma))
    return a.filter(s => b.has(s))
  }

  // Strict parity check across sigma {0, 1, 2, 3}
  console.log('\n[Phase 2 Parity Check across sigma in {0, 1, 2, 3} & masts {0, 2, 4}]')
  for (const sigma of [0, 1, 2, 3]) {
    for (const m of [0, 2, 4]) {
      if (sigma > 0 && m !== 2) continue
      const refSet = []
      const optSet = []
      const wasmSet = []
      for (const bundle of bundles) {
        for (let node = 0; node < 961; node++) {
          const obs = buildObserver(bundle, node, m)
          if (obs.slope == null || obs.slope > limits.slope) continue
          const rA = runBaseline(obs, bundle.vectors, steps, bundle.meta, limits, sigma)
          const rB = searchObserverDual(obs, bundle.vectors, steps, bundle.meta, limits, sigma)
          const rC = wasm.searchDual(obs, bundle.vectors, steps, bundle.meta, limits, sigma)
          assert.deepEqual(rB, rA, `Optimized TS parity mismatch at ${bundle.site} pad ${node} mast ${m} sigma ${sigma}`)
          assert.deepEqual(rC, rA, `WASM parity mismatch at ${bundle.site} pad ${node} mast ${m} sigma ${sigma}`)
          for (const s of rA) refSet.push(`${bundle.site}:${node}:${s}`)
          for (const s of rB) optSet.push(`${bundle.site}:${node}:${s}`)
          for (const s of rC) wasmSet.push(`${bundle.site}:${node}:${s}`)
        }
      }
      assert.equal(optSet.length, refSet.length)
      assert.equal(wasmSet.length, refSet.length)
      console.log(`  mast=${bundleMastLabel(m)} sigma=${sigma}: 100% exact parity (${refSet.length.toLocaleString()} pairs)`)
    }
  }

  // Warm/Cold Latency Benchmark (7 runs each: 1 cold + 6 warm)
  const runs = 7
  const timesBase = []
  const timesOpt = []
  const timesWasm = []

  for (let r = 0; r < runs; r++) {
    const t0 = performance.now()
    const kBase = runSearch(runBaseline)
    timesBase.push(performance.now() - t0)

    const t1 = performance.now()
    const kOpt = runSearch((o, v, s, m, l, sig) => searchObserverDual(o, v, s, m, l, sig))
    timesOpt.push(performance.now() - t1)

    const t2 = performance.now()
    const kWasm = runSearch((o, v, s, m, l, sig) => wasm.searchDual(o, v, s, m, l, sig))
    timesWasm.push(performance.now() - t2)
  }

  const sBase = summarize(timesBase)
  const sOpt = summarize(timesOpt)
  const sWasm = summarize(timesWasm)
  const memMb = process.memoryUsage().rss / (1024 * 1024)

  console.log('\n[Phase 2 Search Performance (3 sites x 961 pads x 2 profiles x 361 starts at 15 days)]')
  console.log(`  WASM binary   : ${wasmBytes.byteLength} bytes raw (${wasmGzipBytes} bytes gzip), init ${wasmInitMs.toFixed(2)} ms, process RSS ${memMb.toFixed(1)} MB`)
  console.log(`  Baseline TS   : cold ${sBase.coldMs.toFixed(1)} ms | warm p50 ${sBase.p50Ms.toFixed(1)} ms | warm p95 ${sBase.p95Ms.toFixed(1)} ms`)
  console.log(`  Optimized TS  : cold ${sOpt.coldMs.toFixed(1)} ms | warm p50 ${sOpt.p50Ms.toFixed(1)} ms | warm p95 ${sOpt.p95Ms.toFixed(1)} ms (${(sBase.p50Ms / sOpt.p50Ms).toFixed(2)}x vs Baseline)`)
  console.log(`  Rust -> WASM  : cold ${sWasm.coldMs.toFixed(1)} ms | warm p50 ${sWasm.p50Ms.toFixed(1)} ms | warm p95 ${sWasm.p95Ms.toFixed(1)} ms (${(sBase.p50Ms / sWasm.p50Ms).toFixed(2)}x vs Baseline, ${(sOpt.p50Ms / sWasm.p50Ms).toFixed(2)}x vs Opt TS)`)
}

function bundleMastLabel(mast) {
  return ['1.5m', '3.0m', '5.0m', '10.0m', '20.0m'][mast] ?? String(mast)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
