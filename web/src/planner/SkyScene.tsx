import { Canvas, useThree } from '@react-three/fiber'
import { Line, OrbitControls, Billboard, Text } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute, DoubleSide, PlaneGeometry, Vector3 } from 'three'
import type { SiteData } from '../types/helios'
import type { Observer, Sky } from './model'
import { padPixel } from './data'

export type TerrainOverlay = 'relief' | 'slope' | 'psr'

const rad=Math.PI/180
function ray(az:number, el:number, d:number) {
  return new Vector3(Math.sin(az*rad)*Math.cos(el*rad)*d,Math.sin(el*rad)*d,-Math.cos(az*rad)*Math.cos(el*rad)*d)
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
}) {
  const lng=site?pad.coordinates[1]:0
  const pixel=site?padPixel(site,node):0
  const x=site?(pixel%256-127.5)*20:0, z=site?(Math.floor(pixel/256)-127.5)*20:0
  const terrain=useMemo(()=>{
    const mesh=new PlaneGeometry(5100,5100,255,255)
    mesh.rotateX(-Math.PI/2)
    const pos=mesh.getAttribute('position')
    for(let i=0;i<pos.count;i++) {
      const dx=pos.getX(i)-x, dz=pos.getZ(i)-z
      const drop=(dx*dx+dz*dz)/(2*1737400)
      pos.setXYZ(i,dx,(site?.dem_elev[i]??0)-pad.coordinates[2]-drop,dz)
    }
    mesh.computeVertexNormals()
    mesh.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.count * 3), 3))
    return mesh
  },[site,x,z,pad.coordinates])
  useEffect(()=>()=>terrain.dispose(),[terrain])
  useEffect(()=>{
    const colors = terrain.getAttribute('color') as Float32BufferAttribute
    const count = colors.count
    let minE = Infinity, maxE = -Infinity
    if (site) {
      for (let i = 0; i < count; i++) {
        const e = site.dem_elev[i]
        if (e < minE) minE = e
        if (e > maxE) maxE = e
      }
    }
    const spanE = Math.max(1, maxE - minE)
    const c = new Color()
    const lowCol = new Color('#47505c'), highCol = new Color('#9ca7b5')
    const emerald = new Color('#10b981'), red = new Color('#ef4444'), violet = new Color('#a855f7')
    for (let i = 0; i < count; i++) {
      if (!site) {
        c.set('#646d79')
      } else {
        const t = (site.dem_elev[i] - minE) / spanE
        c.copy(lowCol).lerp(highCol, t)
        if (overlay === 'slope') {
          const sl = site.dem_slope[i]
          if (sl < 5) c.lerp(emerald, 0.52)
          else c.lerp(red, Math.min(0.75, 0.28 + sl / 42))
        } else if (overlay === 'psr' && site.psr_mask[i]) {
          c.lerp(violet, 0.8)
        }
      }
      colors.setXYZ(i, c.r, c.g, c.b)
    }
    colors.needsUpdate = true
  },[terrain, site, overlay])
  const camera=useThree(s=>s.camera)
  const eye=useMemo(()=>new Vector3(0,pad.mast+(site?0:1.5),0),[pad.mast,site])
  const sun=ray(sky.sun.az,sky.sun.el,1)
  const earth=ray(sky.earth.az,sky.earth.el,1)
  const target=useMemo(()=>{
    if(mode==='orbit') return new Vector3()
    const body=look==='north'?{az:0,el:0}:sky[look]
    return ray(body.az,body.el,1000).add(eye)
  },[mode,eye,look,sky])
  useEffect(()=>{
    camera.position.copy(mode==='orbit'?new Vector3(3400,2450,3800):eye)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
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
  return <>
    <color attach="background" args={['#0b1017']}/>
    <ambientLight intensity={.48}/>
    <directionalLight position={[-3000, 5000, 3000]} intensity={.26} color="#9ec9f3"/>
    <directionalLight
      position={sun.clone().multiplyScalar(9000)}
      intensity={sky.sun.el > -5 ? 2.15 : 0.15}
      color="#fff3d8"
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0005}
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
          <Billboard position={[0, 65, 0]}><Text fontSize={54} color="#7fe3f5" material-depthTest={false}>Alt pad #{secondaryNode! + 1}</Text></Billboard>
        </group>
      )}
    </group>
    {mode==='orbit' && <mesh position={[0,12,0]}><cylinderGeometry args={[13,20,24,12]}/><meshBasicMaterial color="#ffc36d"/></mesh>}
    {mode==='orbit'&&<>
      <Line points={[[0,8,0],[0,8,-500]]} color="#e3e5e8" depthTest={false}/>
      <Billboard position={[0,65,-500]}><Text fontSize={62} color="#e3e5e8" material-depthTest={false}>N · 500 m</Text></Billboard>
    </>}
    {mode==='pad'&&<mesh geometry={silhouette}><meshBasicMaterial color="#33383e" side={DoubleSide}/></mesh>}
    <Line points={skyline} color="#a0b1c5" lineWidth={1} transparent opacity={.65} depthTest={false}/>
    {sunTrack.length >= 2 && <Line points={sunTrack} color="#ffc36d" lineWidth={1.2} transparent opacity={.45} dashed dashSize={90} gapSize={60} depthTest={false}/>}
    {earthTrack.length >= 2 && <Line points={earthTrack} color="#8ec9ff" lineWidth={1.2} transparent opacity={.5} dashed dashSize={70} gapSize={50} depthTest={false}/>}
    {([{name:'Sun',v:sun,color:'#ffc36d',margin:sky.sunMargin},{name:'Earth',v:earth,color:'#8ec9ff',margin:sky.earthMargin}]).map(body=>{
      const p=body.v.clone().multiplyScalar(mode==='orbit'?2600:4000).add(eye)
      return <group key={body.name}>
        {mode==='orbit' && <Line points={[eye,p]} color={body.color} transparent opacity={.55} depthTest={false}/>}
        <Billboard position={p}>
          <mesh renderOrder={5}><ringGeometry args={[35,51,32]}/><meshBasicMaterial color={body.color} depthTest={false} transparent opacity={body.margin<0?.5:1}/></mesh>
          <Text position={[0,95,0]} fontSize={88} color={body.color} renderOrder={6} material-depthTest={false}>
            {body.name}{body.margin<0?' · below skyline':''}
          </Text>
        </Billboard>
      </group>
    })}
    <OrbitControls target={target} enablePan={mode==='orbit'} enableZoom={mode==='orbit'}
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

export default function SkyScene(props:Parameters<typeof Scene>[0]) {
  return <Canvas shadows camera={{fov:62,near:1,far:40000}} fallback={<p>WebGL unavailable. Use the horizon chart.</p>}>
    <Scene {...props}/>
  </Canvas>
}
