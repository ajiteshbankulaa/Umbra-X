import { loadSite, candidatePixel } from '../data'
import type { SiteData } from '../types/helios'
import type { Metadata, Observer, Scenario, Triple } from './model'

export const polarSites = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']

export const referenceSites: Record<
  string,
  { label: string; coordinates: Triple; agency: string; note: string }
> = {
  'apollo-11': {
    label: 'Apollo 11 (Mare Tranquillitatis · 0.67°N)',
    coordinates: [0.67416, 23.47314, 0],
    agency: 'NASA Apollo',
    note: 'Equatorial near-side level-horizon baseline',
  },
  'apollo-17': {
    label: 'Apollo 17 (Taurus-Littrow · 20.19°N)',
    coordinates: [20.1908, 30.7717, 0],
    agency: 'NASA Apollo',
    note: 'Mid-northern latitude reference',
  },
  'im-1-odysseus': {
    label: 'IM-1 Odysseus (Malapert-A · 80.13°S)',
    coordinates: [-80.13, 1.44, 0],
    agency: 'NASA CLPS / Intuitive Machines',
    note: 'First commercial south-polar region landing',
  },
  'chandrayaan-3': {
    label: 'Chandrayaan-3 (Shiv Shakti Pt · 69.37°S)',
    coordinates: [-69.373, 32.319, 0],
    agency: 'ISRO',
    note: 'Southern high-latitude landing site',
  },
  'change-6': {
    label: "Chang'e-6 (SPA Apollo Basin · 41.64°S)",
    coordinates: [-41.6385, -153.9852, 0],
    agency: 'CNSA',
    note: 'Far-side South Pole–Aitken Basin (Earth permanently below horizon)',
  },
  'slim-shioli': {
    label: 'JAXA SLIM (Shioli Crater · 13.32°S)',
    coordinates: [-13.316, 25.251, 0],
    agency: 'JAXA',
    note: 'Precision equatorial-southern landing site',
  },
  custom: {
    label: 'Custom Coordinates (Any Lat, Lon)',
    coordinates: [-89.45, -138.0, 0],
    agency: 'Custom',
    note: 'User-specified lunar coordinates (level horizon outside LOLA tiles)',
  },
}

export const names: Record<string, string> = {
  'shackleton-ridge': 'Shackleton Ridge',
  'mons-mouton': 'Mons Mouton',
  'malapert-massif': 'Malapert Massif',
  'apollo-11': 'Apollo 11',
  'apollo-17': 'Apollo 17',
  'im-1-odysseus': 'IM-1 Odysseus (Malapert-A)',
  'chandrayaan-3': 'Chandrayaan-3 (Shiv Shakti)',
  'change-6': "Chang'e-6 (Far Side SPA)",
  'slim-shioli': 'JAXA SLIM (Shioli)',
  custom: 'Custom Coordinates',
}
const base = import.meta.env.BASE_URL+'data/planner-release/'
const files = new Map<string, Promise<ArrayBuffer>>()
async function asset(path: string) {
  const existing = files.get(path)
  if (existing) return existing
  const pending=fetch(base+path).then(r=>{
    if (!r.ok) throw new Error('Planner data unavailable. Run the data compiler or check the release bundle.')
    return r.arrayBuffer()
  }).catch(e=>{files.delete(path);throw e})
  files.set(path,pending)
  return pending
}
async function binary(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid planner asset hash.')
  const buffer = await asset('planner/'+hash+'.bin')
  const digest = await crypto.subtle.digest('SHA-256',buffer)
  const actual = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')
  if (actual!==hash) throw new Error('Planner asset checksum mismatch.')
  return buffer
}
async function load(id: string) {
  if (!Object.hasOwn(names,id)) throw new Error('Unknown lunar site.')
  const isPolar=polarSites.includes(id), polar=isPolar?id:'shackleton-ridge'
  const meta=JSON.parse(new TextDecoder().decode(await asset(polar+'/planner.json'))) as Metadata
  if (meta.schema!==1 || meta.count!==8641 || meta.stepMinutes!==5 || !Number.isFinite(Date.parse(meta.start)) ||
      meta.observers.length!==961) throw new Error('Unsupported planner data contract.')
  const [site,vectorBuffer] = await Promise.all([isPolar?loadSite(polar,base):null,binary(meta.vectorHash)])
  const vectors = new Float64Array(vectorBuffer)
  if (vectors.length!==meta.count*12 || vectors.some(v=>!Number.isFinite(v))) throw new Error('Malformed ephemeris.')
  if (site) {
    const hash=await crypto.subtle.digest('SHA-256',site.horizons.buffer as ArrayBuffer)
    if (Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')!==meta.localHash) {
      throw new Error('The terrain and planner bundles are out of sync.')
    }
  }
  const regional=site && meta.regional
  const [horizon,distance,coverage,reference] = regional ? await Promise.all([
    binary(regional.regional).then(b=>new Float32Array(b)),binary(regional.distance).then(b=>new Float32Array(b)),
    binary(regional.coverage).then(b=>new Uint8Array(b)),binary(regional.sensitivity).then(b=>new Float32Array(b)),
  ]) : [site?.horizons,null,null,site?.horizons]
  if (site && (horizon?.length!==961*5*360 || reference?.length!==horizon.length ||
      (regional && (distance?.length!==horizon.length || coverage?.length!==961*360)))) throw new Error('Malformed horizons.')
  return {site,meta,vectors,horizon,distance,coverage,reference}
}
const datasets = new Map<string, ReturnType<typeof load>>()
export function dataset(id: string) {
  const previous = datasets.get(id)
  if (previous) return previous
  const pending = load(id).catch(e=>{datasets.delete(id);throw e})
  datasets.set(id,pending)
  return pending
}
export function observer(data: Awaited<ReturnType<typeof load>>, s: Scenario): Observer {
  if (!data.site) {
    const coordinates: Triple = s.site==='custom'
      ? [s.customLat ?? -89.45, s.customLon ?? -138.0, 0]
      : (referenceSites[s.site]?.coordinates ?? [.67416, 23.47314, 0])
    const mast = s.site==='apollo-11' ? 0 : ([1.5,3,5,10,20][s.mast] ?? 1.5)
    return { coordinates, horizon:new Float32Array(360), reference:new Float32Array(360),
      horizonError:new Float32Array(360), distance:new Float32Array(360),
      coverage:new Uint8Array(360).fill(1), mast, slope:null, psr:0 }
  }
  const offset=(s.node*5+s.mast)*360
  const px=padPixel(data.site,s.node)
  return {coordinates:data.meta.observers[s.node],horizon:data.horizon!.slice(offset,offset+360),
    reference:data.reference!.slice(offset,offset+360),
    horizonError:data.site.horizons_err.slice(s.node*360,(s.node+1)*360),
    distance:data.distance?.slice(offset,offset+360)??new Float32Array(360),
    coverage:data.coverage?.slice(s.node*360,(s.node+1)*360)??new Uint8Array(360),
    mast:data.site.manifest.mast_heights_m[s.mast],slope:data.site.dem_slope[px],
    psr:data.site.psr_mask[px]}
}
export function padPixel(site: SiteData,node: number) {
  return candidatePixel(site.manifest,Math.floor(node/31),node%31)
}
export async function findNearestPolarPad(lat: number, lon: number) {
  const rad = Math.PI/180
  let best = Infinity, bestSite = polarSites[0], bestNode = 0
  await Promise.all(polarSites.map(async site => {
    const meta = JSON.parse(new TextDecoder().decode(await asset(site+'/planner.json'))) as Metadata
    meta.observers.forEach(([a,b], i) => {
      const d = Math.sin((lat-a)*rad/2)**2 + Math.cos(lat*rad)*Math.cos(a*rad)*Math.sin((lon-b)*rad/2)**2
      if (d < best) { best = d; bestSite = site; bestNode = i }
    })
  }))
  const distanceM = 2*1737400*Math.asin(Math.sqrt(Math.min(1, best)))
  return { site: bestSite, node: bestNode, distanceM, insideTile: distanceM <= 2500 }
}
