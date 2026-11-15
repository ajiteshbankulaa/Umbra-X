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
}

export interface WasmSearchEngine {
  readonly byteLength: number
  searchDual(observer: Observer, vectors: Float64Array, steps: number, meta: Metadata, limits: Limits, sigma?: number): number[]
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
  }
}
