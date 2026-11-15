import type { Limits, Metadata, Observer } from './model'

interface UmbraWasmExports {
  memory: WebAssembly.Memory
  alloc_vectors(len: number): number
  h96_ptr(): number
  h48_ptr(): number
  err_ptr(): number
  cov_ptr(): number
  out_ptr(): number
  search_pad_dual(
    latDeg: number,
    lonDeg: number,
    heightM: number,
    mastM: number,
    n: number,
    steps: number,
    stepMinutes: number,
    darkLimitH: number,
    earthLimitH: number,
    sigma: number,
    hasErr: number,
  ): number
  alloc_site_pack(nodeCount: number): number
  pack_coords_ptr(): number
  pack_slopes_ptr(): number
  pack_h96_ptr(): number
  pack_h48_ptr(): number
  pack_err_ptr(): number
  pack_cov_ptr(): number
  pack_counts_ptr(): number
  pack_starts_ptr(): number
  search_site_pack(
    nodeCount: number,
    mastM: number,
    n: number,
    steps: number,
    stepMinutes: number,
    darkLimitH: number,
    earthLimitH: number,
    slopeLimit: number,
    sigma: number,
    hasSlopes: number,
    hasErr: number,
    startMin: number,
    startMax: number,
  ): number
}

export interface SitePackSearchOptions {
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
}

export interface WasmSearchEngine {
  readonly byteLength: number
  searchDual(observer: Observer, vectors: Float64Array, steps: number, meta: Metadata, limits: Limits, sigma?: number): number[]
  searchSiteDual(opts: SitePackSearchOptions): Map<number, number[]>
}

export async function createWasmSearchEngine(source: ArrayBuffer | Uint8Array | string): Promise<WasmSearchEngine> {
  let bytes: ArrayBuffer | Uint8Array
  if (typeof source === 'string') {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`Failed to fetch WASM module: ${res.status}`)
    bytes = await res.arrayBuffer()
  } else {
    bytes = source
  }

  const instantiated = (await WebAssembly.instantiate(bytes as BufferSource, {})) as unknown as
    | WebAssembly.WebAssemblyInstantiatedSource
    | { instance: WebAssembly.Instance }
  const instance = 'instance' in instantiated ? instantiated.instance : (instantiated as unknown as WebAssembly.Instance)
  const exp = instance.exports as unknown as UmbraWasmExports

  let uploadedVectors: Float64Array | null = null
  let uploadedPackKey: string | null = null
  let uploadedPackHasErr = 0
  let cachedBuffer: ArrayBuffer | null = null
  let f64 = new Float64Array(exp.memory.buffer)
  let f32 = new Float32Array(exp.memory.buffer)
  let i32 = new Int32Array(exp.memory.buffer)
  let u8 = new Uint8Array(exp.memory.buffer)

  const syncViews = () => {
    if (cachedBuffer !== exp.memory.buffer) {
      cachedBuffer = exp.memory.buffer
      f64 = new Float64Array(cachedBuffer)
      f32 = new Float32Array(cachedBuffer)
      i32 = new Int32Array(cachedBuffer)
      u8 = new Uint8Array(cachedBuffer)
    }
  }

  const ptrH96 = exp.h96_ptr() >> 2
  const ptrH48 = exp.h48_ptr() >> 2
  const ptrErr = exp.err_ptr() >> 2
  const ptrCov = exp.cov_ptr()

  return {
    byteLength: bytes.byteLength,
    searchDual(observer: Observer, vectors: Float64Array, steps: number, meta: Metadata, limits: Limits, sigma = 0) {
      if (observer.slope != null && observer.slope > limits.slope) return []
      const n = meta.count - 1
      if (n <= 0) return []

      if (uploadedVectors !== vectors) {
        const vecPtr = exp.alloc_vectors(vectors.length)
        syncViews()
        f64.set(vectors, vecPtr >> 3)
        uploadedVectors = vectors
      } else {
        syncViews()
      }

      f32.set(observer.horizon, ptrH96)
      f32.set(observer.reference, ptrH48)
      const hasErr = observer.horizonError && sigma !== 0 ? 1 : 0
      if (hasErr && observer.horizonError) {
        f32.set(observer.horizonError, ptrErr)
      }
      u8.set(observer.coverage, ptrCov)

      const count = exp.search_pad_dual(
        observer.coordinates[0],
        observer.coordinates[1],
        observer.coordinates[2],
        observer.mast,
        n,
        steps,
        meta.stepMinutes,
        limits.dark,
        limits.earth,
        sigma,
        hasErr,
      )

      syncViews()
      const outOffset = exp.out_ptr() >> 2
      const result = new Array<number>(count)
      for (let i = 0; i < count; i++) {
        result[i] = i32[outOffset + i]
      }
      return result
    },
    searchSiteDual(opts: SitePackSearchOptions) {
      const { siteKey, nodeCount, mastM, vectors, steps, meta, limits, minStep, maxStep, getObserver } = opts
      const sigma = opts.sigma ?? 0
      const passingStartsByNode = new Map<number, number[]>()
      const n = meta.count - 1
      if (n <= 0 || nodeCount <= 0) return passingStartsByNode

      const vectorsChanged = uploadedVectors !== vectors
      if (vectorsChanged) {
        const vecPtr = exp.alloc_vectors(vectors.length)
        syncViews()
        f64.set(vectors, vecPtr >> 3)
        uploadedVectors = vectors
      }

      const packKey = `${siteKey}:${meta.localHash}:${nodeCount}`
      if (uploadedPackKey !== packKey) {
        exp.alloc_site_pack(nodeCount)
        syncViews()
        const coordsOff = exp.pack_coords_ptr() >> 3
        const slopesOff = exp.pack_slopes_ptr() >> 2
        const h96Off = exp.pack_h96_ptr() >> 2
        const h48Off = exp.pack_h48_ptr() >> 2
        const errOff = exp.pack_err_ptr() >> 2
        const covOff = exp.pack_cov_ptr()
        let hasErr = 1
        for (let node = 0; node < nodeCount; node++) {
          const obs = getObserver(node)
          f64[coordsOff + node * 3] = obs.coordinates[0]
          f64[coordsOff + node * 3 + 1] = obs.coordinates[1]
          f64[coordsOff + node * 3 + 2] = obs.coordinates[2]
          f32[slopesOff + node] = obs.slope == null ? 1e6 : obs.slope
          f32.set(obs.horizon, h96Off + node * 360)
          f32.set(obs.reference, h48Off + node * 360)
          if (obs.horizonError) {
            f32.set(obs.horizonError, errOff + node * 360)
          } else {
            hasErr = 0
          }
          u8.set(obs.coverage, covOff + node * 360)
        }
        uploadedPackKey = packKey
        uploadedPackHasErr = hasErr
      } else {
        syncViews()
      }

      const totalStarts = exp.search_site_pack(
        nodeCount,
        mastM,
        n,
        steps,
        meta.stepMinutes,
        limits.dark,
        limits.earth,
        limits.slope,
        sigma,
        1,
        sigma !== 0 && uploadedPackHasErr ? 1 : 0,
        minStep,
        maxStep,
      )
      syncViews()

      if (totalStarts <= 0) return passingStartsByNode
      const countsOff = exp.pack_counts_ptr() >> 2
      const startsOff = exp.pack_starts_ptr() >> 2
      const stepHours = meta.stepMinutes / 60
      let cursor = 0
      for (let node = 0; node < nodeCount; node++) {
        const c = i32[countsOff + node]
        if (c > 0) {
          const hours: number[] = []
          let prev = Number.NaN
          for (let j = 0; j < c; j++) {
            const h = Math.round(i32[startsOff + cursor + j] * stepHours)
            if (h !== prev) {
              hours.push(h)
              prev = h
            }
          }
          if (hours.length > 0) {
            passingStartsByNode.set(node, hours)
          }
          cursor += c
        }
      }
      return passingStartsByNode
    },
  }
}
