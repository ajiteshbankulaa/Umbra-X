import { Canvas, useThree } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BufferGeometry, CanvasTexture, Float32BufferAttribute, DoubleSide, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { SiteData } from '../types/helios'
import type { Observer, Sky } from './model'
import { padPixel } from './data'
import { computeOverlayRgba, type TerrainOverlay } from './terrainOverlay'

export type { TerrainOverlay }

const rad=Math.PI/180
function ray(az:number, el:number, d:number) {
  return new Vector3(Math.sin(az*rad)*Math.cos(el*rad)*d,Math.sin(el*rad)*d,-Math.cos(az*rad)*Math.cos(el*rad)*d)
}

function SkyLabel({ text, color, size, position }: { text: string; color: string; size: number; position: [number, number, number] | Vector3 }) {
  // Canvas uses local system fonts. A network font must never hold the scene in Suspense.
  const label = useMemo(() => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const font = '700 34px system-ui, sans-serif'
    ctx.font = font
    canvas.width = Math.ceil(ctx.measureText(text).width) + 28
    canvas.height = 52
    ctx.font = font
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#080b12db'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = color
    ctx.fillText(text, 14, 26)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    return { texture, ratio: canvas.width / canvas.height }
  }, [text, color])
  useEffect(() => () => label?.texture.dispose(), [label])
  if (!label) return null
  return (
    <sprite position={position} scale={[size * label.ratio, size, 1]} renderOrder={6}>
      <spriteMaterial map={label.texture} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  )
}

function Scene({
  site,
  node,
  pad,
  sky,
  mode,
  look,
  overlay = 'relief',
  series,
  secondaryNode = null,
  padViability,
  padSolarPct,
  padEarthPct,
  slopeLimit = 5,
}: {
  site: SiteData | null
  node: number
  pad: Observer
  sky: Sky
  mode: 'orbit' | 'pad'
  look: 'sun' | 'earth' | 'north'
  overlay?: TerrainOverlay
  series?: Sky[]
  secondaryNode?: number | null
  padViability?: Uint8Array
  padSolarPct?: Uint8Array
  padEarthPct?: Uint8Array
  slopeLimit?: number
}) {
  const lng=site?pad.coordinates[1]:0
  const pixel = site ? padPixel(site, node) : 0
  const x = site ? (pixel % 256 - 127.5) * 20 : 0,
    z = site ? (Math.floor(pixel / 256) - 127.5) * 20 : 0
  const terrain = useMemo(() => {
    const mesh = new PlaneGeometry(5100, 5100, 255, 255)
    mesh.rotateX(-Math.PI / 2)
    const pos = mesh.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, site?.dem_elev[i] ?? 0)
    }
    mesh.computeVertexNormals()
    mesh.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.count * 3), 3))
    return mesh
  }, [site])
  useEffect(() => () => terrain.dispose(), [terrain])
  useEffect(() => {
    const pos = terrain.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const baseX = (i % 256 - 127.5) * 20
      const baseZ = (Math.floor(i / 256) - 127.5) * 20
      const dx = baseX - x
      const dz = baseZ - z
      const drop = (dx * dx + dz * dz) / (2 * 1737400)
      pos.setXYZ(i, dx, (site?.dem_elev[i] ?? 0) - pad.coordinates[2] - drop, dz)
    }
    pos.needsUpdate = true
  }, [terrain, site, x, z, pad.coordinates])
  useEffect(()=>{
    const colors = terrain.getAttribute('color') as Float32BufferAttribute
    const count = colors.count
    if (!site) {
      for (let i = 0; i < count; i++) colors.setXYZ(i, 0.39, 0.43, 0.47)
    } else {
      const rgba = computeOverlayRgba({
        site,
        overlay,
        sky,
        lngDeg: lng,
        padViability,
        padSolarPct,
        padEarthPct,
        slopeLimit,
        mode: 'vertex3d',
      })
      for (let i = 0; i < count; i++) {
        const p4 = i * 4
        colors.setXYZ(i, rgba[p4] / 255, rgba[p4 + 1] / 255, rgba[p4 + 2] / 255)
      }
    }
    colors.needsUpdate = true
  },[terrain, site, overlay, sky, lng, padViability, padSolarPct, padEarthPct, slopeLimit])
  const camera=useThree(s=>s.camera)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const eye=useMemo(()=>new Vector3(0,pad.mast+(site?0:1.5),0),[pad.mast,site])
  const sun=ray(sky.sun.az,sky.sun.el,1)
  const earth=ray(sky.earth.az,sky.earth.el,1)
  const orbitTarget=useMemo(()=>new Vector3(),[])
  const target=useMemo(()=>{
    if(mode==='orbit') return orbitTarget
    const body=look==='north'?{az:0,el:0}:sky[look]
    return ray(body.az,body.el,1000).add(eye)
  },[mode,eye,look,sky,orbitTarget])
  useEffect(()=>{
    camera.position.copy(mode==='orbit'?new Vector3(2550,1680,2850):eye)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    controlsRef.current?.update()
  },[camera,mode,eye,target])
  const skyline=useMemo(()=>Array.from({length:361},(_,i)=>ray(i,pad.horizon[i%360],7500).add(eye)),[pad,eye])
  const silhouette=useMemo(()=>{
    const vertices:number[]=[]
    for(let i=0;i<360;i++) {
      const a=skyline[i], b=skyline[i+1]
      const aLow=a.clone().setY(-5000), bLow=b.clone().setY(-5000)
      for(const v of [a,aLow,b,b,aLow,bLow]) vertices.push(v.x,v.y,v.z)
    }
    const geometry=new BufferGeometry()
    geometry.setAttribute('position',new Float32BufferAttribute(vertices,3))
    return geometry
  },[skyline])
  useEffect(()=>()=>silhouette.dispose(),[silhouette])
  const { sunTrack, earthTrack } = useMemo(() => {
    if (!series || series.length < 2) return { sunTrack: [] as Vector3[], earthTrack: [] as Vector3[] }
    const dist = mode === 'orbit' ? 2600 : 4000
    const sPts: Vector3[] = [], ePts: Vector3[] = []
    for (let i = 0; i < series.length; i += 6) {
      sPts.push(ray(series[i].sun.az, series[i].sun.el, dist).add(eye))
      ePts.push(ray(series[i].earth.az, series[i].earth.el, dist).add(eye))
    }
    const last = series[series.length - 1]
    sPts.push(ray(last.sun.az, last.sun.el, dist).add(eye))
    ePts.push(ray(last.earth.az, last.earth.el, dist).add(eye))
    return { sunTrack: sPts, earthTrack: ePts }
  }, [series, mode, eye])
  const secondaryPos = useMemo(() => {
    if (!site || secondaryNode == null || secondaryNode === node) return null
    const secPx = padPixel(site, secondaryNode)
    const dx = (secPx % 256 - 127.5) * 20 - x
    const dz = (Math.floor(secPx / 256) - 127.5) * 20 - z
    const drop = (dx * dx + dz * dz) / (2 * 1737400)
    const dy = site.dem_elev[secPx] - pad.coordinates[2] - drop
    return [dx, dy, dz] as [number, number, number]
  }, [site, secondaryNode, node, x, z, pad.coordinates])
  const stars = useMemo(() => {
    const count = 900
    const arr = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const u = Math.sin(i * 12.9898) * 43758.5453
      const v = Math.sin(i * 78.233) * 43758.5453
      const theta = (u - Math.floor(u)) * Math.PI * 2
      const phi = Math.acos(2 * (v - Math.floor(v)) - 1)
      const r = 14000
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      arr[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.9 + 200
      arr[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(arr, 3))
    return geo
  }, [])
  useEffect(() => () => stars.dispose(), [stars])

  return <>
    <color attach="background" args={['#04060a']}/>
    <points geometry={stars}>
      <pointsMaterial color="#dce6f5" size={1.75} transparent opacity={0.78} sizeAttenuation={false} depthWrite={false} />
    </points>
    <ambientLight intensity={overlay === 'relief' ? 0.14 : 0.75} color={overlay === 'relief' ? "#7e98b8" : "#e2e8f0"} />
    <directionalLight position={[-3000, 5000, 3000]} intensity={0.22} color="#6ea5db"/>
    <directionalLight
      position={sun.clone().multiplyScalar(9000)}
      intensity={sky.sun.el > -5 ? 3.1 : 0.12}
      color="#fff5e0"
      castShadow
      shadow-mapSize={[1024, 1024]}
      shadow-bias={-0.0004}
      shadow-camera-left={-4500}
      shadow-camera-right={4500}
      shadow-camera-top={4500}
      shadow-camera-bottom={-4500}
      shadow-camera-near={1000}
      shadow-camera-far={20000}
    />
    <group rotation={[0,lng*rad,0]}>
      <mesh geometry={terrain} castShadow receiveShadow><meshStandardMaterial vertexColors roughness={.95}/></mesh>
      {mode === 'orbit' && secondaryPos && (
        <group position={secondaryPos}>
          <mesh position={[0, 12, 0]}><cylinderGeometry args={[13, 20, 24, 12]}/><meshBasicMaterial color="#06b6d4"/></mesh>
          <SkyLabel position={[0, 65, 0]} size={76} color="#7fe3f5" text={`Other pad #${secondaryNode! + 1}`} />
        </group>
      )}
    </group>
    {mode==='orbit' && (
      <group>
        <mesh position={[0,12,0]}><cylinderGeometry args={[14,22,Math.max(24, pad.mast * 6),12]}/><meshBasicMaterial color="#ffc36d"/></mesh>
        <mesh position={[0,4,0]} rotation={[-Math.PI/2, 0, 0]}><ringGeometry args={[36, 48, 32]}/><meshBasicMaterial color="#ffc36d" transparent opacity={0.8}/></mesh>
        <SkyLabel position={[0, Math.max(84, pad.mast * 6 + 44), 0]} size={76} color="#ffc36d" text={`Pad #${node + 1} · ${pad.mast} m mast`} />
      </group>
    )}
    {mode==='orbit'&&<>
      <Line points={[[0,8,0],[0,8,-500]]} color="#e3e5e8" depthTest={false}/>
      <SkyLabel position={[0, 65, -500]} size={82} color="#e3e5e8" text="N · 500 m" />
    </>}
    {mode==='pad'&&<mesh geometry={silhouette}><meshBasicMaterial color="#141923" side={DoubleSide}/></mesh>}
    <Line points={skyline} color="#9fb2c9" lineWidth={1.1} transparent opacity={.72} depthTest={false}/>
    {[0, 90, 180, 270].map((az) => {
      const label = az === 0 ? 'N' : az === 90 ? 'E' : az === 180 ? 'S' : 'W'
      const p = ray(az, pad.horizon[az] + 2.5, mode === 'orbit' ? 3100 : 4200).add(eye)
      return (
        <SkyLabel key={az} position={p} size={mode === 'orbit' ? 92 : 106} color="#d2d7df" text={label} />
      )
    })}
    {sunTrack.length >= 2 && <Line points={sunTrack} color="#ffc36d" lineWidth={1.2} transparent opacity={.45} dashed dashSize={90} gapSize={60} depthTest={false}/>}
    {earthTrack.length >= 2 && <Line points={earthTrack} color="#8ec9ff" lineWidth={1.2} transparent opacity={.5} dashed dashSize={70} gapSize={50} depthTest={false}/>}
    {([{name:'Sun',v:sun,color:'#ffc36d',margin:sky.sunMargin},{name:'Earth',v:earth,color:'#70b8ff',margin:sky.earthMargin}]).map(body=>{
      const p=body.v.clone().multiplyScalar(mode==='orbit'?2600:4000).add(eye)
      const isSun = body.name === 'Sun'
      const radius = mode === 'orbit' ? (isSun ? 64 : 52) : (isSun ? 84 : 68)
      return <group key={body.name}>
        {mode==='orbit' && <Line points={[eye,p]} color={body.color} transparent opacity={.55} depthTest={false}/>}
        <group position={p}>
          <mesh renderOrder={5}>
            <sphereGeometry args={[radius, 24, 24]} />
            <meshBasicMaterial color={isSun ? '#ffe29a' : '#4a9eff'} transparent opacity={body.margin < 0 ? 0.65 : 1} depthTest={false} />
          </mesh>
          <mesh renderOrder={4}>
            <sphereGeometry args={[radius * 1.45, 24, 24]} />
            <meshBasicMaterial color={body.color} transparent opacity={body.margin < 0 ? 0.1 : 0.22} depthTest={false} />
          </mesh>
          <SkyLabel position={[0, radius * 2.2, 0]} size={165} color={body.color}
            text={body.name + (body.margin < 0 ? ' · below skyline' : '')} />
        </group>
      </group>
    })}
    <OrbitControls ref={controlsRef} target={target} enablePan={mode==='orbit'} enableZoom={mode==='orbit'}
      minDistance={mode==='pad'?1000:30} maxDistance={mode==='pad'?1000:22000}
      mouseButtons={undefined} enabled={mode==='orbit'}/>
    {mode==='pad' && <PadLook eye={eye} target={target}/>}
  </>
}

function PadLook({eye,target}:{eye:Vector3;target:Vector3}) {
  const {gl,camera}=useThree()
  useEffect(()=>{
    const canvas=gl.domElement
    let down=false, az=0, elevation=0
    const dir=target.clone().sub(eye).normalize()
    az=Math.atan2(dir.x,-dir.z)
    elevation=Math.asin(dir.y)
    const start=(event:PointerEvent)=>{down=true;canvas.setPointerCapture(event.pointerId)}
    const stop=()=>{down=false}
    const move=(event:PointerEvent)=>{
      if(!down)return
      az-=event.movementX*.003
      elevation=Math.max(-1.4,Math.min(1.4,elevation+event.movementY*.003))
      camera.lookAt(ray(az/rad,elevation/rad,1000).add(eye))
    }
    canvas.addEventListener('pointerdown',start)
    canvas.addEventListener('pointerup',stop)
    canvas.addEventListener('pointercancel',stop)
    canvas.addEventListener('pointermove',move)
    return ()=>{
      canvas.removeEventListener('pointerdown',start);canvas.removeEventListener('pointerup',stop)
      canvas.removeEventListener('pointercancel',stop);canvas.removeEventListener('pointermove',move)
    }
  },[gl,camera,eye,target])
  return null
}

function WebGLFallbackHorizon({ pad, sky, node }: { pad: Observer; sky: Sky; node: number }) {
  const w = 520, h = 220, padX = 28, padY = 20
  const plotW = w - padX * 2, plotH = h - padY * 2
  const elMin = -15, elMax = 35
  const xForAz = (az: number) => padX + (az / 360) * plotW
  const yForEl = (el: number) => padY + ((elMax - Math.max(elMin, Math.min(elMax, el))) / (elMax - elMin)) * plotH
  const horizonPts = Array.from({ length: 361 }, (_, az) => `${xForAz(az).toFixed(1)},${yForEl(pad.horizon[az % 360]).toFixed(1)}`).join(' ')
  const zeroY = yForEl(0)
  return (
    <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', padding: 12, background: '#080a0f', color: '#e3e5e8' }}>
      <div style={{ width: '100%', maxWidth: 560, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11, color: '#9fb2c9' }}>
          <span>2D POLAR HORIZON FALLBACK · PAD #{node + 1} ({pad.mast}m mast)</span>
          <span>WebGL unavailable</span>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="2D terrain skyline with modeled Sun and Earth positions" style={{ width: '100%', background: '#0e131c', border: '1px solid #262e3d' }}>
          <line x1={padX} y1={zeroY} x2={w - padX} y2={zeroY} stroke="#334155" strokeDasharray="3 3" />
          <polygon points={`${padX},${h - padY} ${horizonPts} ${w - padX},${h - padY}`} fill="#1a2230" stroke="#9fb2c9" strokeWidth={1.3} />
          <circle cx={xForAz(sky.sun.az)} cy={yForEl(sky.sun.el)} r={6} fill="#ffc36d" fillOpacity={sky.sunMargin < 0 ? 0.35 : 0.95} stroke="#ffc36d" />
          <text x={xForAz(sky.sun.az) + 9} y={yForEl(sky.sun.el) + 3} fill="#ffc36d" fontSize={10} fontFamily="monospace">Sun {sky.sun.el.toFixed(1)}°</text>
          <circle cx={xForAz(sky.earth.az)} cy={yForEl(sky.earth.el)} r={6} fill="#8ec9ff" fillOpacity={sky.earthMargin < 0 ? 0.35 : 0.95} stroke="#8ec9ff" />
          <text x={xForAz(sky.earth.az) + 9} y={yForEl(sky.earth.el) + 3} fill="#8ec9ff" fontSize={10} fontFamily="monospace">Earth {sky.earth.el.toFixed(1)}°</text>
          {[0, 90, 180, 270, 360].map(az => (
            <text key={az} x={xForAz(az)} y={h - 6} textAnchor="middle" fill="#8e949f" fontSize={9} fontFamily="monospace">
              {az === 0 || az === 360 ? 'N' : az === 90 ? 'E' : az === 180 ? 'S' : 'W'}
            </text>
          ))}
        </svg>
        <p style={{ margin: 0, fontSize: 11.5, color: '#9fb2c9', fontFamily: 'var(--font-mono)' }}>
          Sun az {sky.sun.az.toFixed(1)}°, el {sky.sun.el.toFixed(1)}° ({sky.sunMargin >= 0 ? 'visible' : 'blocked'}) · Earth az {sky.earth.az.toFixed(1)}°, el {sky.earth.el.toFixed(1)}° ({sky.earthMargin >= 0 ? 'visible' : 'blocked'})
        </p>
      </div>
    </div>
  )
}

class WebGLErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

function hasWebGLContext() {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export default function SkyScene(props: Parameters<typeof Scene>[0]) {
  const [glOk] = useState(hasWebGLContext)
  const fallback = <WebGLFallbackHorizon pad={props.pad} sky={props.sky} node={props.node} />
  if (!glOk) return fallback
  return (
    <WebGLErrorBoundary fallback={fallback}>
      <Canvas shadows dpr={[1, 1.5]} camera={{ fov: 54, near: 1, far: 40000 }}>
        <Scene {...props} />
      </Canvas>
    </WebGLErrorBoundary>
  )
}
