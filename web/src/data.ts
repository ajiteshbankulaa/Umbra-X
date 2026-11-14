import type { SiteData, SiteManifest } from './types/helios'

async function fetchFile(path: string) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`)
  return response
}

async function floats(path: string, count: number) {
  const data = new DataView(await (await fetchFile(path)).arrayBuffer())
  if (data.byteLength !== count * 4) throw new Error(`Unexpected binary length for ${path}.`)
  const result = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    result[i] = data.getFloat32(i * 4, true)
    if (!Number.isFinite(result[i])) throw new Error(`Invalid sample in ${path}.`)
  }
  return result
}

async function psrMask(path: string, count: number) {
  const mask = new Uint8Array(await (await fetchFile(path)).arrayBuffer())
  if (mask.length !== count || mask.some(value => value > 1)) {
    throw new Error(`Invalid PSR mask at ${path}.`)
  }
  return mask
}

export async function loadSite(id: string): Promise<SiteData> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('Enter a lowercase site ID.')
  const base = `${import.meta.env.BASE_URL}data/${id}`
  const manifest: SiteManifest = await (await fetchFile(`${base}/manifest.json`)).json()
  const ephem = manifest.ephemeris
  if (
    manifest.site_id !== id || manifest.dem_grid?.width !== 256 || manifest.dem_grid.height !== 256 ||
    manifest.analysis_grid?.rows !== 31 || manifest.analysis_grid.cols !== 31 ||
    manifest.analysis_grid.start_pixel !== 23 || manifest.analysis_grid.step_pixel !== 7 ||
    manifest.analysis_grid.spacing_m !== 140 ||
    manifest.mast_heights_m?.join(',') !== '1.5,3,5,10,20' || ephem?.num_steps !== 720 ||
    ephem.step_hours !== 1 || ![ephem.sun_az_deg, ephem.sun_el_deg, ephem.earth_az_deg, ephem.earth_el_deg]
      .every(series => Array.isArray(series) && series.length === 720 && series.every(Number.isFinite)) ||
    ephem.timestamps?.length !== 720
  ) throw new Error('The site manifest does not match the Umbra-X data contract.')

  const [dem_elev, dem_slope, dem_err, horizons, horizons_err, psr_mask] = await Promise.all([
    floats(`${base}/dem_elev.bin`, 256 * 256),
    floats(`${base}/dem_slope.bin`, 256 * 256),
    floats(`${base}/dem_err.bin`, 256 * 256),
    floats(`${base}/horizons.bin`, 31 * 31 * 5 * 360),
    floats(`${base}/horizons_err.bin`, 31 * 31 * 360),
    psrMask(`${base}/psr_mask.bin`, 256 * 256),
  ])
  return { manifest, dem_elev, dem_slope, dem_err, horizons, horizons_err, psr_mask }
}

export function candidatePixel(manifest: SiteManifest, row: number, column: number) {
  const { start_pixel, step_pixel } = manifest.analysis_grid
  return (start_pixel + row * step_pixel) * manifest.dem_grid.width + start_pixel + column * step_pixel
}
