export interface ApolloBaseline {
  name: 'Apollo 11 (Mare Tranquillitatis)'
  lat: 0.674
  lon: 23.473
  earth_el_deg: 66.2
}

export interface NssdcaReference {
  apollo_baseline: ApolloBaseline
  clps_missions: string[]
}

export interface DemGrid {
  width: 256
  height: 256
  pixel_size_m: 20
}

export interface AnalysisGrid {
  rows: 31
  cols: 31
  spacing_m: 140
  start_pixel: 23
  step_pixel: 7
}

export interface SiteEphemeris {
  start_utc: string
  step_hours: 1
  num_steps: 720
  timestamps: string[]
  sun_az_deg: number[]
  sun_el_deg: number[]
  earth_az_deg: number[]
  earth_el_deg: number[]
}

export interface SiteManifest {
  site_id: string
  name: string
  subtitle: string
  mission_agency: string
  nssdca_reference: NssdcaReference
  citations: string[]
  center_lat: number
  center_lon: number
  moon_trek_url: string
  proj_crs: '+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs'
  dem_grid: DemGrid
  analysis_grid: AnalysisGrid
  mast_heights_m: [1.5, 3, 5, 10, 20]
  ephemeris: SiteEphemeris
}

export interface SiteData {
  manifest: SiteManifest
  dem_elev: Float32Array
  dem_slope: Float32Array
  dem_err: Float32Array
  horizons: Float32Array
  horizons_err: Float32Array
  psr_mask: Uint8Array
}
