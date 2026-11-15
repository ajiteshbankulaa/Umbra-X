import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Float32BufferAttribute,
  LinearFilter,
  RepeatWrapping,
  Texture,
  TextureLoader,
  Vector3,
  type Group,
} from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

export type IntroFocus = 'system' | 'moon' | 'earth' | 'sun'
export type IntroView = 'orbit' | 'pad' | 'polar' | 'chart'

const VIEW_TILT: Record<IntroView, number> = {
  orbit: 0,
  pad: 0.14,
  polar: -0.14,
  chart: 0.08,
}

const FOCUS_DISTANCE: Record<IntroFocus, number> = {
  system: 8.6,
  moon: 7.4,
  earth: 9.0,
  sun: 8.8,
}

const LUNAR_RADIUS_M = 1_737_400
const SCENE_MOON_R = 2.45
const CAP_MAX_R_M = 304_000

const DEFAULT_META = {
  leftM: -304_000,
  rightM: 304_000,
  bottomM: -304_000,
  topM: 304_000,
  radiusM: LUNAR_RADIUS_M,
  minElevM: -6230.2,
  maxElevM: 5617.4,
}

const POLAR_SITES: Array<{
  id: string
  label: string
  lat: number
  lon: number
  color: string
  labelOffset: [number, number, number]
}> = [
  { id: 'shackleton-ridge', label: 'Shackleton', lat: -89.45, lon: -138.05, color: '#10b981', labelOffset: [-0.52, 0.22, 0.28] },
  { id: 'malapert-massif', label: 'Malapert', lat: -86.04, lon: 2.7, color: '#f59e0b', labelOffset: [-0.46, 0.42, -0.18] },
  { id: 'mons-mouton', label: 'Mons Mouton', lat: -84.79, lon: 29.2, color: '#60a5fa', labelOffset: [0.56, 0.34, -0.06] },
]

// Smooth 3D value noise for seamless equirectangular maria, highlands & terrain normals
function hash3(ix: number, iy: number, iz: number): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453123
  return n - Math.floor(n)
}

function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)

  const n000 = hash3(ix, iy, iz)
  const n100 = hash3(ix + 1, iy, iz)
  const n010 = hash3(ix, iy + 1, iz)
  const n110 = hash3(ix + 1, iy + 1, iz)
  const n001 = hash3(ix, iy, iz + 1)
  const n101 = hash3(ix + 1, iy, iz + 1)
  const n011 = hash3(ix, iy + 1, iz + 1)
  const n111 = hash3(ix + 1, iy + 1, iz + 1)

  const nx00 = n000 + (n100 - n000) * ux
  const nx10 = n010 + (n110 - n010) * ux
  const nx01 = n001 + (n101 - n001) * ux
  const nx11 = n011 + (n111 - n011) * ux

  const nxy0 = nx00 + (nx10 - nx00) * uy
  const nxy1 = nx01 + (nx11 - nx01) * uy
  return nxy0 + (nxy1 - nxy0) * uz
}

function fbm3(x: number, y: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq)
    freq *= 2.07
    amp *= 0.5
  }
  return sum
}

/**
 * Generates seamless 3D-sampled lunar highland/mare albedo + Sobel normal map
 * so the globe shows crisp craters, basins, and micro-relief with zero UV seam.
 */
function createLunarGlobeTextures(): { albedo: CanvasTexture; normal: CanvasTexture } {
  const w = 1024
  const h = 512
  const count = w * h
  const height = new Float32Array(count)
  const tone = new Float32Array(count)

  // Deterministic seeded craters on unit sphere (concentrated in highlands, sparse in maria)
  let seed = 19690720
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  interface Crater {
    cx: number
    cy: number
    cz: number
    r: number
    depth: number
    rayed: number
  }
  const craters: Crater[] = []
  for (let i = 0; i < 320; i++) {
    const u = rand() * Math.PI * 2
    const v = Math.acos(2 * rand() - 1)
    const r = i < 20 ? 0.095 + rand() * 0.1 : i < 110 ? 0.032 + rand() * 0.055 : 0.011 + rand() * 0.022
    craters.push({
      cx: Math.sin(v) * Math.cos(u),
      cy: Math.cos(v),
      cz: Math.sin(v) * Math.sin(u),
      r,
      depth: r * (1.1 + rand() * 0.65),
      rayed: i >= 20 && i < 65 && rand() > 0.4 ? 1 : 0,
    })
  }

  for (let py = 0; py < h; py++) {
    // Canvas y=0 maps to v=1 (SphereGeometry +Y / South Pole hero cap orientation)
    const phi = ((py + 0.5) / h) * Math.PI
    const sinP = Math.sin(phi)
    const ny = Math.cos(phi)

    for (let px = 0; px < w; px++) {
      const theta = ((px + 0.5) / w) * Math.PI * 2
      const nx = sinP * Math.cos(theta)
      const nz = sinP * Math.sin(theta)
      const idx = py * w + px

      // Multi-scale mare basins & bright heavily cratered south polar highlands
      const macro = fbm3(nx * 2.1 + 2.1, ny * 2.1 - 1.3, nz * 2.1 + 0.7, 3)
      const mid = fbm3(nx * 8.5 - 3.4, ny * 8.5 + 2.2, nz * 8.5 + 1.1, 3)
      const fine = noise3(nx * 28.0, ny * 28.0, nz * 28.0)
      const grit = noise3(nx * 64.0, ny * 64.0, nz * 64.0)

      // Polar highland factor (keeps upper +Y cap bright and highland-rich matching LOLA texture)
      const highlandBias = Math.max(0, Math.min(1, (ny + 0.25) * 0.95))
      const mareMask = Math.max(0, Math.min(1, (macro - 0.42) * 3.3 - highlandBias * 0.5))

      let hVal = (macro - 0.5) * 0.42 + (mid - 0.5) * 0.24 + (fine - 0.5) * 0.1 + (grit - 0.5) * 0.04
      hVal -= mareMask * 0.18
      let aVal = 0.66 - mareMask * 0.28 + (mid - 0.5) * 0.12 + (fine - 0.5) * 0.06 + (grit - 0.5) * 0.04

      // Craters culled quickly by |ny - cy| < r * 1.32
      for (let ci = 0; ci < craters.length; ci++) {
        const c = craters[ci]
        const maxRange = c.r * 1.32
        if (Math.abs(ny - c.cy) > maxRange) continue
        const dx = nx - c.cx
        const dy = ny - c.cy
        const dz = nz - c.cz
        const dSq = dx * dx + dy * dy + dz * dz
        if (dSq > maxRange * maxRange) continue

        const d = Math.sqrt(dSq) / c.r
        if (d < 0.86) {
          const t = d / 0.86
          hVal -= c.depth * (1 - t * t) * 1.3
          aVal -= 0.04 * (1 - t)
        }
        const rimDelta = (d - 0.94) / 0.12
        const rim = Math.exp(-rimDelta * rimDelta)
        hVal += c.depth * 0.72 * rim
        aVal += (0.08 + c.rayed * 0.11) * rim
        if (c.rayed && d >= 0.9 && d < 1.3) {
          aVal += 0.05 * (1 - (d - 0.9) / 0.4)
        }
      }

      height[idx] = hVal
      tone[idx] = Math.max(0.22, Math.min(0.92, aVal))
    }
  }

  const albedoCanvas = document.createElement('canvas')
  albedoCanvas.width = w
  albedoCanvas.height = h
  const ctxA = albedoCanvas.getContext('2d')!
  const imgA = ctxA.createImageData(w, h)

  const normalCanvas = document.createElement('canvas')
  normalCanvas.width = w
  normalCanvas.height = h
  const ctxN = normalCanvas.getContext('2d')!
  const imgN = ctxN.createImageData(w, h)

  const strength = 3.4
  for (let py = 0; py < h; py++) {
    const pyUp = Math.max(0, py - 1)
    const pyDn = Math.min(h - 1, py + 1)
    const latWeight = Math.max(0.24, Math.sin(((py + 0.5) / h) * Math.PI))
    for (let px = 0; px < w; px++) {
      const pxL = (px - 1 + w) % w
      const pxR = (px + 1) % w
      const idx = py * w + px
      const off = idx * 4

      const lum = Math.round(tone[idx] * 242)
      imgA.data[off] = Math.min(255, lum)
      imgA.data[off + 1] = Math.min(255, lum + 2)
      imgA.data[off + 2] = Math.min(255, lum + 5)
      imgA.data[off + 3] = 255

      const dX = ((height[py * w + pxR] - height[py * w + pxL]) * strength) / latWeight
      const dY = (height[pyDn * w + px] - height[pyUp * w + px]) * strength
      const nx = -dX
      const ny = dY
      const nz = 1.0
      const invLen = 1 / Math.hypot(nx, ny, nz)
      imgN.data[off] = Math.round((nx * invLen * 0.5 + 0.5) * 255)
      imgN.data[off + 1] = Math.round((ny * invLen * 0.5 + 0.5) * 255)
      imgN.data[off + 2] = Math.round((nz * invLen * 0.5 + 0.5) * 255)
      imgN.data[off + 3] = 255
    }
  }

  ctxA.putImageData(imgA, 0, 0)
  ctxN.putImageData(imgN, 0, 0)

  const albedo = new CanvasTexture(albedoCanvas)
  albedo.wrapS = RepeatWrapping
  albedo.wrapT = ClampToEdgeWrapping
  albedo.minFilter = LinearFilter
  albedo.magFilter = LinearFilter
  albedo.needsUpdate = true

  const normal = new CanvasTexture(normalCanvas)
  normal.wrapS = RepeatWrapping
  normal.wrapT = ClampToEdgeWrapping
  normal.minFilter = LinearFilter
  normal.magFilter = LinearFilter
  normal.needsUpdate = true

  return { albedo, normal }
}

function createPinLabelTexture(label: string, accent: string): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 56
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)

  ctx.fillStyle = 'rgba(10, 12, 16, 0.84)'
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(8, 8, c.width - 16, c.height - 16, 20)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.arc(30, 28, 6.5, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#f4f4f5'
  ctx.font = '600 21px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 48, 28.5)

  const tex = new CanvasTexture(c)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

function stereographicToLocal(xm: number, ym: number, heightOffsetScene = 0): Vector3 {
  const r = Math.hypot(xm, ym)
  const colat = 2 * Math.atan(r / (2 * LUNAR_RADIUS_M))
  const sinC = Math.sin(colat)
  const cosC = Math.cos(colat)
  const rad = SCENE_MOON_R + heightOffsetScene
  if (r < 1e-6) return new Vector3(0, rad, 0)
  return new Vector3((xm / r) * sinC * rad, cosC * rad, -(ym / r) * sinC * rad)
}

function latLonToLocal(latDeg: number, lonDeg: number, heightOffsetScene = 0): Vector3 {
  const latRad = (latDeg * Math.PI) / 180
  const lonRad = (lonDeg * Math.PI) / 180
  const colat = Math.PI / 2 + latRad
  const r = 2 * LUNAR_RADIUS_M * Math.tan(colat / 2)
  return stereographicToLocal(r * Math.sin(lonRad), r * Math.cos(lonRad), heightOffsetScene)
}

function buildPolarCapBaseGeometry(): {
  geometry: BufferGeometry
  stereoX: Float32Array
  stereoY: Float32Array
  edgeFade: Float32Array
} {
  const rings = 72
  const segs = 144
  const vertCount = (rings + 1) * (segs + 1)
  const positions = new Float32Array(vertCount * 3)
  const uvs = new Float32Array(vertCount * 2)
  const stereoX = new Float32Array(vertCount)
  const stereoY = new Float32Array(vertCount)
  const edgeFade = new Float32Array(vertCount)

  let ptr = 0
  let uvPtr = 0
  for (let ri = 0; ri <= rings; ri++) {
    const tR = ri / rings
    const r = tR * CAP_MAX_R_M
    const rawFade = r > 220_000 ? Math.max(0, 1 - (r - 220_000) / (CAP_MAX_R_M - 220_000)) : 1
    const fade = rawFade * rawFade * (3 - 2 * rawFade)
    for (let si = 0; si <= segs; si++) {
      const idx = ri * (segs + 1) + si
      const theta = (si / segs) * Math.PI * 2
      const xm = r * Math.sin(theta)
      const ym = r * Math.cos(theta)
      const p = stereographicToLocal(xm, ym, 0)
      positions[ptr] = p.x
      positions[ptr + 1] = p.y
      positions[ptr + 2] = p.z
      ptr += 3
      uvs[uvPtr] = (xm - DEFAULT_META.leftM) / (DEFAULT_META.rightM - DEFAULT_META.leftM)
      uvs[uvPtr + 1] = (ym - DEFAULT_META.bottomM) / (DEFAULT_META.topM - DEFAULT_META.bottomM)
      uvPtr += 2
      stereoX[idx] = xm
      stereoY[idx] = ym
      edgeFade[idx] = fade
    }
  }

  const indices: number[] = []
  for (let ri = 0; ri < rings; ri++) {
    for (let si = 0; si < segs; si++) {
      const a = ri * (segs + 1) + si
      const b = a + 1
      const c = (ri + 1) * (segs + 1) + si
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return { geometry, stereoX, stereoY, edgeFade }
}

function latRingPoints(latDeg: number, segments = 128, lift = 0.015): [number, number, number][] {
  const pts: [number, number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const lon = -180 + (i / segments) * 360
    const p = latLonToLocal(latDeg, lon, lift)
    pts.push([p.x, p.y, p.z])
  }
  return pts
}

function LdaReliefGlobe({ focus, selectedView }: { focus: IntroFocus; selectedView: IntroView }) {
  const moonRef = useRef<Group>(null)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const { camera } = useThree()
  const baseDistance = useRef(FOCUS_DISTANCE[focus])

  const [albedoTex, setAlbedoTex] = useState<Texture | null>(null)
  const [heightReady, setHeightReady] = useState(false)

  const capData = useMemo(() => buildPolarCapBaseGeometry(), [])
  useEffect(() => () => capData.geometry.dispose(), [capData])

  const starPositions = useMemo(() => {
    const count = 360
    const pos = new Float32Array(count * 3)
    let seed = 42071
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < count; i++) {
      const theta = next() * Math.PI * 2
      const phi = Math.acos(2 * next() - 1)
      const r = 18 + next() * 14
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.cos(phi)
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    return pos
  }, [])

  useEffect(() => {
    let cancelled = false
    const baseUrl = import.meta.env.BASE_URL
    const loader = new TextureLoader()
    loader.load(
      `${baseUrl}textures/lola_spole_albedo.png`,
      tex => {
        if (cancelled) {
          tex.dispose()
          return
        }
        tex.minFilter = LinearFilter
        tex.magFilter = LinearFilter
        tex.wrapS = ClampToEdgeWrapping
        tex.wrapT = ClampToEdgeWrapping
        tex.needsUpdate = true
        setAlbedoTex(tex)
      },
      undefined,
      () => {},
    )

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = async () => {
      if (cancelled) return
      let meta = DEFAULT_META
      try {
        const res = await fetch(`${baseUrl}textures/lola_spole_meta.json`)
        if (res.ok) meta = { ...DEFAULT_META, ...(await res.json()) }
      } catch {
        // Fallback to baked LDEM_80S bounds
      }
      if (cancelled) return
      const w = img.width
      const h = img.height
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      const pixels = ctx.getImageData(0, 0, w, h).data
      const posAttr = capData.geometry.getAttribute('position') as Float32BufferAttribute
      const spanM = meta.maxElevM - meta.minElevM
      const scaleScenePerM = 0.085 / Math.max(1000, spanM)
      for (let i = 0; i < posAttr.count; i++) {
        const xm = capData.stereoX[i]
        const ym = capData.stereoY[i]
        const u = (xm - meta.leftM) / (meta.rightM - meta.leftM)
        const v = (ym - meta.bottomM) / (meta.topM - meta.bottomM)
        const px = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))))
        const py = Math.min(h - 1, Math.max(0, Math.round((1 - v) * (h - 1))))
        const normH = pixels[(py * w + px) * 4] / 255
        const elevM = meta.minElevM + normH * spanM
        const disp = ((elevM - meta.minElevM) * scaleScenePerM - 0.015) * capData.edgeFade[i] + 0.002 * capData.edgeFade[i]
        const p = stereographicToLocal(xm, ym, disp)
        posAttr.setXYZ(i, p.x, p.y, p.z)
      }
      posAttr.needsUpdate = true
      capData.geometry.computeVertexNormals()
      setHeightReady(true)
    }
    img.src = `${baseUrl}textures/lola_spole_height.png`

    return () => {
      cancelled = true
    }
  }, [capData])

  const globeTex = useMemo(() => createLunarGlobeTextures(), [])
  const siteBadges = useMemo(
    () =>
      POLAR_SITES.map(site => ({
        id: site.id,
        tex: createPinLabelTexture(site.label, site.color),
      })),
    [],
  )

  useEffect(() => () => albedoTex?.dispose(), [albedoTex])
  useEffect(
    () => () => {
      globeTex.albedo.dispose()
      globeTex.normal.dispose()
      for (const b of siteBadges) b.tex.dispose()
    },
    [globeTex, siteBadges],
  )

  useEffect(() => {
    baseDistance.current = FOCUS_DISTANCE[focus]
  }, [focus])

  const ring85 = useMemo(() => latRingPoints(-85, 128, 0.048), [])
  const ring80 = useMemo(() => latRingPoints(-80, 144, 0.025), [])

  const targetVec = useMemo(() => new Vector3(0, 0.12, 0), [])
  const lookOffset = useMemo(() => new Vector3(), [])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    if (moonRef.current) {
      moonRef.current.rotation.y = 0.22 + Math.sin(t * 0.14) * 0.1 + VIEW_TILT[selectedView]
    }
    if (controlsRef.current) {
      targetVec.set(0, 0.18, 0)
      controlsRef.current.target.lerp(targetVec, 0.06)
      lookOffset.copy(camera.position).sub(controlsRef.current.target)
      const dist = lookOffset.length()
      const desired = baseDistance.current
      if (Math.abs(dist - desired) > 0.05 && dist > 0.01) {
        lookOffset.setLength(dist + (desired - dist) * 0.04)
        camera.position.copy(controlsRef.current.target).add(lookOffset)
      }
      controlsRef.current.update()
    }
  })

  return (
    <>
      <color attach="background" args={['#090a0c']} />
      <ambientLight intensity={0.28} color="#9fb0c7" />
      {/* Grazing solar key light casting crisp south-polar terminator shadows */}
      <directionalLight position={[-10.5, 4.2, 6.2]} intensity={3.5} color="#fff5e4" />
      {/* Subtle cool Earthshine + subtle purple/slate rim fill */}
      <directionalLight position={[7.0, 3.8, 4.5]} intensity={0.75} color="#7ea9e0" />
      <directionalLight position={[0, -5.0, -4.0]} intensity={0.35} color="#8b5cf6" />

      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.04} color="#cbd5e1" sizeAttenuation transparent opacity={0.5} />
      </points>

      {/* Tilted Lunar Globe with sculpted NASA GSFC LOLA 80S-90S South Polar cap facing viewer */}
      <group position={[0, -0.18, 0]} rotation={[0.96, 0.22, 0]} ref={moonRef}>
        <mesh>
          <sphereGeometry args={[SCENE_MOON_R, 72, 54]} />
          <meshStandardMaterial
            map={globeTex.albedo}
            normalMap={globeTex.normal}
            normalScale={[1.05, 1.05]}
            color="#c2c7d0"
            roughness={0.94}
            metalness={0.02}
          />
        </mesh>

        <mesh geometry={capData.geometry}>
          <meshStandardMaterial
            map={albedoTex ?? undefined}
            color={albedoTex ? '#f3f5f8' : '#9aa3b0'}
            roughness={0.9}
            metalness={0.02}
            polygonOffset
            polygonOffsetFactor={-1}
          />
        </mesh>

        <Line points={ring85} color="#94a3b8" lineWidth={0.9} transparent opacity={heightReady ? 0.48 : 0.28} />
        <Line points={ring80} color="#64748b" lineWidth={0.8} transparent opacity={0.38} />

        {POLAR_SITES.map(site => {
          const p = latLonToLocal(site.lat, site.lon, 0.055)
          const labelPos = new Vector3(
            p.x + site.labelOffset[0],
            p.y + site.labelOffset[1],
            p.z + site.labelOffset[2],
          )
          const badge = siteBadges.find(b => b.id === site.id)
          return (
            <group key={site.id}>
              <Line
                points={[
                  [p.x, p.y, p.z],
                  [labelPos.x, labelPos.y, labelPos.z],
                ]}
                color={site.color}
                lineWidth={1.1}
                transparent
                opacity={0.85}
              />
              <group position={[p.x, p.y, p.z]}>
                <mesh>
                  <sphereGeometry args={[0.042, 16, 16]} />
                  <meshBasicMaterial color={site.color} />
                </mesh>
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[0.068, 0.092, 24]} />
                  <meshBasicMaterial color={site.color} transparent opacity={0.72} />
                </mesh>
              </group>
              {badge ? (
                <sprite position={[labelPos.x, labelPos.y + 0.04, labelPos.z]} scale={[0.72, 0.155, 1]}>
                  <spriteMaterial map={badge.tex} transparent depthTest={false} />
                </sprite>
              ) : null}
            </group>
          )
        })}
      </group>

      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.06}
        enablePan={false}
        minDistance={5.0}
        maxDistance={12.0}
      />
    </>
  )
}

export default function IntroScene({ focus, selectedView }: { focus: IntroFocus; selectedView: IntroView }) {
  return (
    <Canvas camera={{ position: [0.1, 1.35, 8.6], fov: 40, near: 0.1, far: 45 }} dpr={[1, 1.5]}>
      <LdaReliefGlobe focus={focus} selectedView={selectedView} />
    </Canvas>
  )
}
