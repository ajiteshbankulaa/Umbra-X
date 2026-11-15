import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferGeometry,
  ClampToEdgeWrapping,
  Float32BufferAttribute,
  LinearFilter,
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
  pad: 0.11,
  polar: -0.1,
  chart: 0.06,
}

const FOCUS_DISTANCE: Record<IntroFocus, number> = {
  system: 8.2,
  moon: 6.4,
  earth: 9.2,
  sun: 8.8,
}

const LUNAR_RADIUS_M = 1_737_400
const SCENE_MOON_R = 2.55
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

const POLAR_SITES: Array<{ id: string; label: string; lat: number; lon: number; color: string }> = [
  { id: 'shackleton-ridge', label: 'Shackleton Ridge', lat: -89.45, lon: -138.05, color: '#10b981' },
  { id: 'mons-mouton', label: 'Mons Mouton', lat: -84.79, lon: 29.2, color: '#60a5fa' },
  { id: 'malapert-massif', label: 'Malapert Massif', lat: -86.04, lon: 2.7, color: '#f59e0b' },
]

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
  const colat = Math.PI / 2 + latRad // 0 at South Pole (-90), +0.1745 rad at -80 deg
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
    const fade = r > 276_000 ? Math.max(0, 1 - (r - 276_000) / (CAP_MAX_R_M - 276_000)) : 1
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

function meridianPoints(lonDeg: number, lift = 0.012): [number, number, number][] {
  const pts: [number, number, number][] = []
  for (let i = 0; i <= 24; i++) {
    const lat = -90 + (i / 24) * 9.8
    const p = latLonToLocal(lat, lonDeg, lift)
    pts.push([p.x, p.y, p.z])
  }
  return pts
}

function LdaReliefGlobe({ focus, selectedView }: { focus: IntroFocus; selectedView: IntroView }) {
  const moonRef = useRef<Group>(null)
  const earthOrbitRef = useRef<Group>(null)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const { camera } = useThree()
  const baseDistance = useRef(FOCUS_DISTANCE[focus])

  const [albedoTex, setAlbedoTex] = useState<Texture | null>(null)
  const [heightReady, setHeightReady] = useState(false)

  const capData = useMemo(() => buildPolarCapBaseGeometry(), [])
  useEffect(() => () => capData.geometry.dispose(), [capData])

  const starPositions = useMemo(() => {
    const count = 480
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
    const loader = new TextureLoader()
    loader.load(
      '/textures/lola_spole_albedo.png',
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
        const res = await fetch('/textures/lola_spole_meta.json')
        if (res.ok) meta = { ...DEFAULT_META, ...(await res.json()) }
      } catch {
        // Fallback to static baked LDEM_80S bounds
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
      const scaleScenePerM = (0.11 / Math.max(1000, spanM))
      for (let i = 0; i < posAttr.count; i++) {
        const xm = capData.stereoX[i]
        const ym = capData.stereoY[i]
        const u = (xm - meta.leftM) / (meta.rightM - meta.leftM)
        const v = (ym - meta.bottomM) / (meta.topM - meta.bottomM)
        const px = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))))
        const py = Math.min(h - 1, Math.max(0, Math.round((1 - v) * (h - 1))))
        const normH = pixels[(py * w + px) * 4] / 255
        const elevM = meta.minElevM + normH * spanM
        const disp = (elevM - meta.minElevM) * scaleScenePerM * capData.edgeFade[i] + 0.002 * capData.edgeFade[i]
        const p = stereographicToLocal(xm, ym, disp)
        posAttr.setXYZ(i, p.x, p.y, p.z)
      }
      posAttr.needsUpdate = true
      capData.geometry.computeVertexNormals()
      setHeightReady(true)
    }
    img.src = '/textures/lola_spole_height.png'

    return () => {
      cancelled = true
    }
  }, [capData])

  useEffect(() => () => albedoTex?.dispose(), [albedoTex])

  useEffect(() => {
    baseDistance.current = FOCUS_DISTANCE[focus]
  }, [focus])

  const ring85 = useMemo(() => latRingPoints(-85, 128, 0.045), [])
  const ring80 = useMemo(() => latRingPoints(-80, 144, 0.02), [])
  const primeMeridian = useMemo(() => meridianPoints(0, 0.045), [])

  const targetVec = useMemo(() => new Vector3(0, 0.1, 0), [])
  const lookOffset = useMemo(() => new Vector3(), [])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    if (moonRef.current) {
      moonRef.current.rotation.y = 0.22 + Math.sin(t * 0.14) * 0.12 + VIEW_TILT[selectedView]
    }
    if (earthOrbitRef.current) {
      earthOrbitRef.current.rotation.y = t * 0.055
    }
    if (controlsRef.current) {
      if (focus === 'earth') {
        targetVec.set(1.6, 1.4, -3.4)
      } else if (focus === 'sun') {
        targetVec.set(-2.6, 0.9, -1.2)
      } else if (focus === 'moon') {
        targetVec.set(0, 0.4, 0)
      } else {
        targetVec.set(0, 0.1, 0)
      }
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
      <ambientLight intensity={0.14} color="#8ba0b8" />
      {/* Low-grazing solar light across south polar rim */}
      <directionalLight position={[-14, 1.8, 4.5]} intensity={3.2} color="#fff7eb" />
      {/* Subtle cool Earthshine fill from prime-meridian hemisphere */}
      <directionalLight position={[5, 6, -9]} intensity={0.42} color="#6ea8e5" />

      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.045} color="#cbd5e1" sizeAttenuation transparent opacity={0.55} />
      </points>

      {/* Tilted Moon centered in viewport with true LOLA 80S-90S polar relief cap */}
      <group position={[0.45, -0.35, 0]} rotation={[1.08, 0.2, 0]} ref={moonRef}>
        <mesh>
          <sphereGeometry args={[SCENE_MOON_R, 64, 48]} />
          <meshStandardMaterial color="#2a2f38" roughness={0.96} metalness={0.02} />
        </mesh>

        <mesh geometry={capData.geometry}>
          <meshStandardMaterial
            map={albedoTex ?? undefined}
            color={albedoTex ? '#e5e7eb' : '#646d7a'}
            roughness={0.93}
            metalness={0.02}
            polygonOffset
            polygonOffsetFactor={-1}
          />
        </mesh>

        <Line points={ring85} color="#52525b" lineWidth={0.9} transparent opacity={heightReady ? 0.45 : 0.3} />
        <Line points={ring80} color="#3f3f46" lineWidth={0.8} transparent opacity={0.35} />
        <Line points={primeMeridian} color="#60a5fa" lineWidth={0.8} transparent opacity={0.4} />

        {POLAR_SITES.map(site => {
          const p = latLonToLocal(site.lat, site.lon, 0.085)
          return (
            <group key={site.id} position={[p.x, p.y, p.z]}>
              <mesh>
                <sphereGeometry args={[0.045, 16, 16]} />
                <meshBasicMaterial color={site.color} />
              </mesh>
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.068, 0.09, 24]} />
                <meshBasicMaterial color={site.color} transparent opacity={0.75} />
              </mesh>
            </group>
          )
        })}
      </group>

      {/* Distant sunlit Earth reference indicator in background sky */}
      <group ref={earthOrbitRef}>
        <group position={[3.8, 2.35, -7.2]}>
          <mesh>
            <sphereGeometry args={[0.32, 32, 32]} />
            <meshStandardMaterial color="#3b82f6" roughness={0.65} metalness={0.05} />
          </mesh>
        </group>
      </group>

      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.06}
        enablePan={false}
        minDistance={4.2}
        maxDistance={12.5}
      />
    </>
  )
}

export default function IntroScene({ focus, selectedView }: { focus: IntroFocus; selectedView: IntroView }) {
  return (
    <Canvas camera={{ position: [0.35, 0.55, 8.2], fov: 40, near: 0.1, far: 45 }} dpr={[1, 1.5]}>
      <LdaReliefGlobe focus={focus} selectedView={selectedView} />
    </Canvas>
  )
}
