import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Mountain } from 'lucide-react'
import { PlaneGeometry } from 'three'
import { loadSite } from './data'
import type { SiteData } from './types/helios'
import './style.css'

function Terrain({ data }: { data: SiteData }) {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(5.1, 5.1, 255, 255)
    plane.rotateX(-Math.PI / 2)
    const vertices = plane.getAttribute('position')
    const center = data.dem_elev[128 * 256 + 128]
    for (let i = 0; i < vertices.count; i++) {
      vertices.setY(i, (data.dem_elev[i] - center) / 1000)
    }
    plane.computeVertexNormals()
    return plane
  }, [data])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh geometry={geometry}><meshStandardMaterial color="#bab5aa" side={2} /></mesh>
}

function SiteWorkspace({ data }: { data: SiteData }) {
  const [delay, setDelay] = useState(0)
  const [mast, setMast] = useState(0)
  const { manifest } = data
  const ephem = manifest.ephemeris
  const node = 15 * 31 + 15
  const start = delay * 24
  function visibleHours(azimuth: number[], elevation: number[]) {
    let visible = 0
    for (let i = start; i < start + 360; i++) {
      const az = ((azimuth[i] % 360) + 360) % 360
      const bin = Math.floor(az)
      const offset = (node * 5 + mast) * 360
      const a = data.horizons[offset + bin]
      const b = data.horizons[offset + (bin + 1) % 360]
      if (elevation[i] > a + (b - a) * (az - bin)) visible++
    }
    return visible
  }
  return (
    <section className="workspace">
      <div className="terrain" aria-label="Interactive lunar elevation mesh">
        <Canvas camera={{ position: [4, 4, 5], fov: 45 }} fallback={<p>WebGL is unavailable.</p>}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[-3, 2, -1]} intensity={2} />
          <Terrain data={data} />
          <OrbitControls />
        </Canvas>
      </div>
      <aside className="inspector">
        <h2>{manifest.name}</h2>
        <p>{manifest.subtitle}</p>
        <label htmlFor="delay">Launch delay ({delay} d)</label>
        <input id="delay" type="range" min={0} max={15} value={delay} onChange={e => setDelay(e.target.valueAsNumber)} />
        <label htmlFor="mast">Mast height</label>
        <select id="mast" value={mast} onChange={e => setMast(Number(e.target.value))}>
          {manifest.mast_heights_m.map((height, i) => <option value={i} key={height}>{height} m</option>)}
        </select>
        <h3>Center candidate · 15-day window</h3>
        <p className="date">{ephem.timestamps[start]}</p>
        <dl>
          <div><dt>Sun above terrain</dt><dd>{visibleHours(ephem.sun_az_deg, ephem.sun_el_deg)} / 360 h</dd></div>
          <div><dt>Earth above terrain</dt><dd>{visibleHours(ephem.earth_az_deg, ephem.earth_el_deg)} / 360 h</dd></div>
          <div><dt>Terrain slope</dt><dd>{data.dem_slope[128 * 256 + 128].toFixed(1)}°</dd></div>
        </dl>
      </aside>
    </section>
  )
}

function App() {
  const [id, setId] = useState(new URLSearchParams(location.search).get('site') ?? '')
  const [data, setData] = useState<SiteData>()
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  async function openSite() {
    setLoading(true)
    setStatus('Loading site…')
    try {
      setData(await loadSite(id.trim()))
      setStatus('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not load site.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <main className="mx-auto max-w-7xl px-5">
      <header><Mountain size={22} aria-hidden="true" /><h1>Umbra-X</h1><span>Lunar Site Navigator</span></header>
      <form onSubmit={e => { e.preventDefault(); void openSite() }}>
        <label htmlFor="site">Site ID</label>
        <input id="site" value={id} onChange={e => setId(e.target.value)} placeholder="Enter a compiled site ID" required />
        <button disabled={loading}>Open site</button>
      </form>
      {status && <p role="status">{status}</p>}
      {data ? <SiteWorkspace data={data} key={data.manifest.site_id} /> :
        <p>Compile a LOLA site bundle to <code>web/public/data/</code> to inspect its terrain and visibility windows.</p>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
