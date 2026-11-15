import { Line, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferGeometry, Float32BufferAttribute, Group, IcosahedronGeometry, MathUtils, Mesh, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

export type IntroFocus = 'system' | 'moon' | 'earth' | 'sun'
export type IntroView = 'orbit' | 'pad' | 'polar' | 'chart'

const VIEW_TILT: Record<IntroView, number> = {
  orbit: 0.34,
  pad: 0.62,
  polar: 0.14,
  chart: 0.48,
}

const FOCUS_DISTANCE: Record<IntroFocus, number> = {
  system: 7.6,
  moon: 3.4,
  earth: 1.85,
  sun: 2.1,
}

function circlePoints(radius: number, segments = 96): [number, number, number][] {
  const pts: [number, number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push([Math.cos(a) * radius, 0, Math.sin(a) * radius])
  }
  return pts
}

function SculpturalCelestial({ focus, selectedView }: { focus: IntroFocus; selectedView: IntroView }) {
  const sculptureRef = useRef<Group>(null)
  const gyroRef = useRef<Group>(null)
  const moonRef = useRef<Mesh>(null)
  const earthGroupRef = useRef<Group>(null)
  const sunGroupRef = useRef<Group>(null)
  const particlesRef = useRef<Group>(null)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const transitionRef = useRef(0)

  const camera = useThree(s => s.camera)

  useEffect(() => {
    transitionRef.current = 1.2
  }, [focus])

  // Procedural cratered and ridged lunar topography on a matte-graphite sphere
  const moonGeo = useMemo(() => {
    const base = new IcosahedronGeometry(1.18, 16)
    const pos = base.getAttribute('position')
    const v = new Vector3()
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize()
      const maria = Math.sin(v.x * 2.4 + 0.6) * Math.cos(v.z * 2.1 - 0.4) * 0.045
      const ridges = Math.sin(v.x * 6.5 + v.y * 5.2) * Math.sin(v.z * 6.8 - v.y * 4.1) * 0.022
      const micro = Math.cos(v.x * 13.0 - v.z * 11.0 + v.y * 9.0) * 0.008
      const southCrater = Math.exp(-Math.pow(v.y + 0.96, 2) * 32) * -0.055
      const southRim = Math.exp(-Math.pow(v.y + 0.84, 2) * 58) * 0.038
      const radius = 1.18 + maria + ridges + micro + southCrater + southRim
      pos.setXYZ(i, v.x * radius, v.y * radius, v.z * radius)
    }
    base.computeVertexNormals()
    return base
  }, [])

  useEffect(() => {
    return () => {
      moonGeo.dispose()
    }
  }, [moonGeo])

  // Antigravity zero-G orbital dust & ephemeris node particles
  const particleGeo = useMemo(() => {
    const count = 900
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const golden = i * 2.399963229728653
      const disk = i % 3 !== 0
      if (disk) {
        const r = 2.05 + ((i * 73) % 340) / 100
        const y = Math.sin(i * 1.7) * 0.34
        positions[i * 3] = Math.cos(golden) * r
        positions[i * 3 + 1] = y
        positions[i * 3 + 2] = Math.sin(golden) * r
      } else {
        const phi = Math.acos(1 - (2 * ((i + 0.5) / count)))
        const r = 3.2 + ((i * 41) % 380) / 100
        positions[i * 3] = Math.sin(phi) * Math.cos(golden) * r
        positions[i * 3 + 1] = Math.cos(phi) * r * 0.8
        positions[i * 3 + 2] = Math.sin(phi) * Math.sin(golden) * r
      }
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    return geo
  }, [])

  useEffect(() => {
    return () => particleGeo.dispose()
  }, [particleGeo])

  const equatorRing = useMemo(() => circlePoints(1.22, 96), [])
  const meridianRing = useMemo(() => circlePoints(1.22, 96), [])
  const earthOrbitRing = useMemo(() => circlePoints(2.1, 112), [])
  const outerRing = useMemo(() => circlePoints(2.62, 128), [])
  const southPoleRing = useMemo(() => circlePoints(0.36, 64), [])
  const sunCoronaRing = useMemo(() => circlePoints(0.56, 64), [])

  const targetVec = useRef(new Vector3())
  const desiredCamOffset = useRef(new Vector3())
  const sunPos = useRef(new Vector3(2.05, 1.18, 1.45))
  const reduceMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    const reduced = reduceMotion.matches
    const t = reduced ? 0 : state.clock.elapsedTime
    const px = reduced ? 0 : state.pointer.x
    const py = reduced ? 0 : state.pointer.y

    if (moonRef.current && !reduced) {
      moonRef.current.rotation.y += dt * 0.08
    }

    if (sculptureRef.current) {
      const targetTiltX = py * 0.22 + (VIEW_TILT[selectedView] - 0.34) * 0.35
      const targetTiltY = px * 0.34
      sculptureRef.current.rotation.x = MathUtils.lerp(sculptureRef.current.rotation.x, targetTiltX, dt * 3.5)
      sculptureRef.current.rotation.y = MathUtils.lerp(sculptureRef.current.rotation.y, targetTiltY, dt * 3.5)
    }

    if (gyroRef.current) {
      gyroRef.current.rotation.z = MathUtils.lerp(gyroRef.current.rotation.z, VIEW_TILT[selectedView] + px * 0.14, dt * 3)
      gyroRef.current.rotation.x = MathUtils.lerp(gyroRef.current.rotation.x, 0.24 - py * 0.18, dt * 3)
    }

    if (earthGroupRef.current) {
      const angle = t * 0.18 + 2.35
      earthGroupRef.current.position.set(Math.cos(angle) * 2.1, Math.sin(angle * 0.7) * 0.2, Math.sin(angle) * 2.1)
      earthGroupRef.current.rotation.y = t * 0.35
    }

    if (sunGroupRef.current) {
      const sx = 2.05 + Math.cos(t * 0.1) * 0.12
      const sy = 1.18 + Math.sin(t * 0.14) * 0.12
      const sz = 1.45 + Math.sin(t * 0.1) * 0.12
      sunPos.current.set(sx, sy, sz)
      sunGroupRef.current.position.copy(sunPos.current)
      sunGroupRef.current.rotation.y = -t * 0.18
      sunGroupRef.current.rotation.z = t * 0.12
    }

    if (particlesRef.current) {
      particlesRef.current.rotation.y = t * 0.03 - px * 0.22
      particlesRef.current.rotation.x = py * 0.14
    }

    if (controlsRef.current) {
      if (focus === 'earth' && earthGroupRef.current) {
        earthGroupRef.current.getWorldPosition(targetVec.current)
      } else if (focus === 'sun' && sunGroupRef.current) {
        sunGroupRef.current.getWorldPosition(targetVec.current)
      } else {
        targetVec.current.set(0, 0, 0)
      }
      controlsRef.current.target.lerp(targetVec.current, dt * 4.5)

      if (transitionRef.current > 0) {
        transitionRef.current = Math.max(0, transitionRef.current - dt)
        if (focus === 'system') {
          desiredCamOffset.current.set(0.25, 1.25, FOCUS_DISTANCE.system)
        } else {
          desiredCamOffset.current
            .set(0.22, 0.32, 1)
            .normalize()
            .multiplyScalar(FOCUS_DISTANCE[focus])
            .add(controlsRef.current.target)
        }
        camera.position.lerp(desiredCamOffset.current, dt * 5.2)
      }
      controlsRef.current.update()
    }
  })

  return (
    <>
      <color attach="background" args={['#07080a']} />
      <ambientLight intensity={0.55} color="#c8d6e8" />
      <hemisphereLight args={['#dce8f7', '#12161f', 0.68]} />
      <directionalLight position={[5.2, 3.1, 4.8]} intensity={2.9} color="#fff3dc" />
      <directionalLight position={[-4.5, -1.5, 3.6]} intensity={0.85} color="#7ab3ef" />

      <group ref={particlesRef}>
        <points geometry={particleGeo}>
          <pointsMaterial color="#c8d4e3" size={0.028} transparent opacity={0.55} sizeAttenuation />
        </points>
      </group>

      <group ref={sculptureRef}>
        {/* Sculptural Topographic Moon */}
        <mesh ref={moonRef} geometry={moonGeo}>
          <meshStandardMaterial color="#6e7785" roughness={0.76} metalness={0.1} />
        </mesh>
        <Line points={equatorRing} color="#8eaecf" lineWidth={0.9} transparent opacity={0.22} />
        <group rotation={[Math.PI / 2, 0.35, 0]}>
          <Line points={meridianRing} color="#8eaecf" lineWidth={0.9} transparent opacity={0.22} />
        </group>

        {/* South Pole Landing Halo */}
        <group position={[0, -1.2, 0]}>
          <Line points={southPoleRing} color="#ffc36d" lineWidth={1.3} transparent opacity={0.85} />
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.14, 0.22, 32]} />
            <meshBasicMaterial color="#ffc36d" transparent opacity={0.45} side={2} />
          </mesh>
        </group>

        {/* Tilted Gyroscopic Orbital Rings & Orbiting Earth */}
        <group ref={gyroRef}>
          <Line points={earthOrbitRing} color="#5e90bd" lineWidth={1} transparent opacity={0.35} />
          <group rotation={[0.42, 0.3, -0.25]}>
            <Line points={outerRing} color="#6e7785" lineWidth={0.85} transparent opacity={0.22} dashed dashSize={0.22} gapSize={0.16} />
          </group>

          <group ref={earthGroupRef} position={[-1.48, 0, 1.48]}>
            <mesh>
              <sphereGeometry args={[0.31, 32, 32]} />
              <meshStandardMaterial color="#4e83b5" roughness={0.55} metalness={0.1} />
            </mesh>
            <mesh>
              <sphereGeometry args={[0.355, 32, 32]} />
              <meshBasicMaterial color="#8ec9ff" transparent opacity={0.18} />
            </mesh>
            <Line points={circlePoints(0.52, 48)} color="#8ec9ff" lineWidth={0.9} transparent opacity={0.45} />
          </group>
        </group>

        {/* Radiant Solar Body & Corona */}
        <group ref={sunGroupRef} position={[2.05, 1.18, 1.45]}>
          <pointLight intensity={14} distance={16} color="#ffd79a" />
          <mesh>
            <sphereGeometry args={[0.42, 32, 32]} />
            <meshBasicMaterial color="#ffd58f" />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.56, 32, 32]} />
            <meshBasicMaterial color="#ffc36d" transparent opacity={0.14} />
          </mesh>
          <Line points={sunCoronaRing} color="#ffc36d" lineWidth={1.1} transparent opacity={0.55} />
        </group>
      </group>

      <OrbitControls ref={controlsRef} enableZoom={false} enablePan={false} enableDamping dampingFactor={0.07} rotateSpeed={0.55} />
    </>
  )
}

export default function IntroScene({ focus, selectedView }: { focus: IntroFocus; selectedView: IntroView }) {
  return (
    <Canvas camera={{ position: [0.25, 1.25, 7.6], fov: 45, near: 0.1, far: 60 }} dpr={[1, 2]}>
      <SculpturalCelestial focus={focus} selectedView={selectedView} />
    </Canvas>
  )
}
