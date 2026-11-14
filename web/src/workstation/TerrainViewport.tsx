import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import { BufferAttribute, CanvasTexture, Color, PlaneGeometry, SRGBColorSpace, Vector3, type Group } from 'three'
import { candidatePixel } from '../data'
import type { GridWindow, LightToIceNetwork, PlasmaRisk, ShadowSurfingPath } from '../engine/heliosEngine'
import type { SiteData } from '../types/helios'

export type Mode = 'static' | 'grid' | 'rover'
export type Overlay = 'slope' | 'complement' | 'psr' | 'plasma'
export const palette = { gold: '#e8c477', emerald: '#10b981', cyan: '#06b6d4', violet: '#a855f7', amber: '#f59e0b', red: '#ef4444' }
const RAD = Math.PI / 180

export function TerrainViewport({ site, window, plasma, network, route, mode, overlay, hour, mast, selected, onSelect }:
  { site: SiteData; window: GridWindow; plasma: PlasmaRisk; network: LightToIceNetwork | null;
    route: ShadowSurfingPath | null; mode: Mode; overlay: Overlay; hour: number; mast: number;
    selected: number; onSelect: (node: number) => void }) {
  const { rows, cols, start_pixel, step_pixel } = site.manifest.analysis_grid
  const width = site.manifest.dem_grid.width
  const scale = site.manifest.dem_grid.pixel_size_m / 1000
  const center = site.dem_elev[128 * width + 128]
  const position = (px: number, height = 0): [number, number, number] => [
    (px % width - (width - 1) / 2) * scale, (site.dem_elev[px] - center) / 1000 + height,
    (Math.floor(px / width) - (width - 1) / 2) * scale,
  ]
  const nodePosition = (node: number, height = 0) =>
    position(candidatePixel(site.manifest, Math.floor(node / cols), node % cols), height)
  const geometry = useMemo(() => {
    const mesh = new PlaneGeometry((width - 1) * scale, (width - 1) * scale, width - 1, width - 1)
    mesh.rotateX(-Math.PI / 2)
    const vertices = mesh.getAttribute('position')
    for (let i = 0; i < vertices.count; i++) vertices.setY(i, (site.dem_elev[i] - center) / 1000)
    mesh.computeVertexNormals()
    mesh.setAttribute('color', new BufferAttribute(new Float32Array(vertices.count * 3), 3))
    return mesh
  }, [site, width, scale, center])
  useEffect(() => () => geometry.dispose(), [geometry])

  const complement = useMemo(() => {
    const scores = new Float32Array(window.nodeCount)
    const a = network?.primary ?? selected
    let hours = 0
    for (let t = 0; t < 360; t++) {
      const base = t * window.nodeCount
      if (window.solarFraction[base + a] >= 0.1) continue
      hours++
      for (let i = 0; i < scores.length; i++) scores[i] += +(window.solarFraction[base + i] >= 0.1)
    }
    if (hours) for (let i = 0; i < scores.length; i++) scores[i] /= hours
    return scores
  }, [window, network, selected])

  const layerHour = overlay === 'plasma' ? hour : 0
  useEffect(() => {
    const colors = geometry.getAttribute('color') as BufferAttribute
    const neutral = new Color('#6c7483'), color = new Color()
    const green = new Color(palette.emerald), red = new Color(palette.red)
    const violet = new Color(palette.violet), amber = new Color(palette.amber), cyan = new Color(palette.cyan)
    const start = start_pixel, end = start + step_pixel * (rows - 1)
    for (let r = 0; r < width; r++) for (let c = 0; c < width; c++) {
      const pixel = r * width + c
      const inside = r >= start && c >= start && r <= end && c <= end
      const node = inside ? Math.round((r - start) / step_pixel) * cols + Math.round((c - start) / step_pixel) : -1
      color.copy(neutral)
      if (overlay === 'slope') color.lerp(site.dem_slope[pixel] < 5 ? green : red,
        site.dem_slope[pixel] < 5 ? .42 : Math.min(.64, site.dem_slope[pixel] / 48))
      if (overlay === 'psr' && site.psr_mask[pixel]) color.lerp(violet, node >= 0 && window.coldTrap[node] ? .9 : .65)
      if (overlay === 'complement' && node >= 0) color.lerp(cyan, complement[node] * .85)
      if (overlay === 'plasma' && node >= 0) color.lerp(amber, Math.min(1, plasma.electricFieldVm[layerHour * window.nodeCount + node] / 32))
      colors.setXYZ(pixel, color.r, color.g, color.b)
    }
    colors.needsUpdate = true
  }, [geometry, overlay, layerHour, site, window, plasma, complement, rows, cols, start_pixel, step_pixel, width])

  const ephem = site.manifest.ephemeris
  const time = window.launchDelayHours + hour
  const az = (ephem.sun_az_deg[time] + site.manifest.center_lon) * RAD
  const el = ephem.sun_el_deg[time] * RAD
  const sun: [number, number, number] = [12 * Math.sin(az) * Math.cos(el), 12 * Math.sin(el), -12 * Math.cos(az) * Math.cos(el)]
  const a = network?.primary ?? selected
  const b = mode === 'grid' ? network?.twin : null
  const c = mode === 'grid' ? network?.iceTarget : null
  const aPosition = nodePosition(a)
  const routePoints = useMemo(() => route ? Array.from(route.path, node => nodePosition(node, .027)) : [],
    [route, site])
  const ring = Array.from({ length: 65 }, (_, index): [number, number, number] => {
    const angle = index * Math.PI / 32
    return [aPosition[0] + .10 * Math.cos(angle), aPosition[1] + .02, aPosition[2] + .10 * Math.sin(angle)]
  })
  return <Canvas shadows dpr={[1, 1.5]} camera={{ position: [3.6, 2.5, 4.3], fov: 48, near: .02, far: 65 }}
    fallback={<p className="state-message">WebGL is unavailable. Use the horizon plot and site comparison.</p>}>
    <color attach="background" args={['#080b12']} />
    <ambientLight intensity={.32} />
    <directionalLight position={[1, 4, -2]} intensity={.62} color="#aac0e8" />
    <directionalLight position={sun} intensity={ephem.sun_el_deg[time] > -5 ? 2.1 : 0}
      color="#fff2d5" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-.00025}
      shadow-camera-left={-4.7} shadow-camera-right={4.7} shadow-camera-top={4.7} shadow-camera-bottom={-4.7} />
    <mesh geometry={geometry} castShadow receiveShadow onClick={event => {
      const col = Math.round(((event.point.x / scale) + (width - 1) / 2 - start_pixel) / step_pixel)
      const row = Math.round(((event.point.z / scale) + (width - 1) / 2 - start_pixel) / step_pixel)
      if (row >= 0 && row < rows && col >= 0 && col < cols) onSelect(row * cols + col)
    }}>
      <meshStandardMaterial vertexColors roughness={.94} />
    </mesh>
    <gridHelper args={[7.7, 15, '#27384a', '#172333']} position={[0, -.78, 0]} />
    <Station at={aPosition} name="A · Landing pad" color={palette.gold} height={mast} />
    <Line points={ring} color={palette.gold} lineWidth={1} transparent opacity={.65} />
    {b != null && <>
      <Station at={nodePosition(b)} name="B · Rim twin" color={palette.cyan} height={mast} />
      <PulseLink from={nodePosition(a, mast / 1000 + .04)} to={nodePosition(b, mast / 1000 + .04)} color={palette.cyan} />
    </>}
    {c != null && <>
      <Station at={nodePosition(c)} name="C · PSR target" color={palette.violet} height={1.5} />
      {network?.beamSources.map(node => <PulseLink key={node} from={nodePosition(node, mast / 1000 + .04)}
        to={nodePosition(c, .025)} color={palette.violet}
        active={window.solarFraction[hour * window.nodeCount + node] >= .1} />)}
      {!!network?.passiveRadiosityWm2[hour] && <mesh position={nodePosition(c, .015)} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[.07, .105, 24]} /><meshBasicMaterial color={palette.violet} transparent opacity={.48} />
      </mesh>}
      {!!network?.passiveRadiosityWm2[hour] && network?.reflectionFacets
        .filter(facet => window.solarFraction[hour * window.nodeCount + facet.node] > 0)
        .sort((left, right) => right.factor - left.factor).slice(0, 3).map(({ node }) =>
          <Line key={node} points={[nodePosition(node, .004), nodePosition(c, .004)]}
            color={palette.violet} transparent opacity={.30} dashed dashSize={.025} gapSize={.018} lineWidth={1} />)}
    </>}
    {mode === 'rover' && route && <>
      {route.distanceM > 0 && <Line points={routePoints} color={palette.gold} lineWidth={2.5} />}
      <Rover at={routePoints[hour]} />
    </>}
    <OrbitControls enableDamping minDistance={.7} maxDistance={12} maxPolarAngle={Math.PI / 2.05} />
  </Canvas>
}

function Station({ at, name, color, height }: { at: [number, number, number]; name: string; color: string; height: number }) {
  const post = .04 + height / 1000
  return <group position={at}>
    <mesh position={[0, .013, 0]}><cylinderGeometry args={[.026, .032, .026, 8]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={.25} /></mesh>
    <mesh position={[0, .022 + post / 2, 0]}><cylinderGeometry args={[.004, .005, post, 8]} /><meshBasicMaterial color={color} /></mesh>
    <MapLabel text={name} color={color} height={.09 + post} />
  </group>
}

function PulseLink({ from, to, color, active = true }: { from: [number, number, number]; to: [number, number, number]; color: string; active?: boolean }) {
  const dot = useRef<Group>(null)
  const start = new Vector3(...from), end = new Vector3(...to)
  useFrame(({ clock }) => {
    if (dot.current && active) dot.current.position.copy(start).lerp(end, (clock.elapsedTime * .7) % 1)
  })
  return <>
    <Line points={[from, to]} color={color} transparent opacity={active ? .85 : .22} lineWidth={active ? 2 : 1} />
    {active && <group ref={dot}><mesh><sphereGeometry args={[.013, 10, 8]} /><meshBasicMaterial color={color} /></mesh></group>}
  </>
}

function Rover({ at }: { at: [number, number, number] }) {
  const group = useRef<Group>(null)
  const target = new Vector3(...at)
  useFrame((_, dt) => group.current?.position.lerp(target, 1 - Math.exp(-12 * dt)))
  return <group ref={group} position={at}>
    <mesh position={[0, .025, 0]}><boxGeometry args={[.08, .035, .11]} /><meshStandardMaterial color={palette.gold} /></mesh>
    {[[-.045, -.035], [-.045, .035], [.045, -.035], [.045, .035]].map(([x, z], i) =>
      <mesh key={i} position={[x, .017, z]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[.017, .017, .015, 10]} /><meshStandardMaterial color="#333c48" />
      </mesh>)}
    <MapLabel text="ROVER" color={palette.gold} height={.105} />
  </group>
}

function MapLabel({ text, color, height }: { text: string; color: string; height: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 44
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#080e19'
    ctx.fillRect(0, 0, 256, 44)
    ctx.strokeStyle = '#4c627b'
    ctx.strokeRect(1, 1, 254, 42)
    ctx.fillStyle = color
    ctx.font = '20px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 128, 22)
    const result = new CanvasTexture(canvas)
    result.colorSpace = SRGBColorSpace
    return result
  }, [text, color])
  useEffect(() => () => texture.dispose(), [texture])
  return <sprite position={[0, height, 0]} scale={[.54, .093, 1]} renderOrder={3}>
    <spriteMaterial map={texture} depthTest={false} />
  </sprite>
}
