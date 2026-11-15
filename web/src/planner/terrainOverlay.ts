import type { SiteData } from '../types/helios'
import type { Sky } from './model'

export type TerrainOverlay = 'relief' | 'viable' | 'slope' | 'psr' | 'illumination' | 'earth' | 'solar_hours'

const RAD = Math.PI / 180

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

function mixRgb(
  r: number,
  g: number,
  b: number,
  tr: number,
  tg: number,
  tb: number,
  w: number,
): [number, number, number] {
  const iw = 1 - w
  return [r * iw + tr * w, g * iw + tg * w, b * iw + tb * w]
}

export function computeOverlayRgba(opts: {
  site: SiteData
  overlay: TerrainOverlay
  sky?: Sky
  lngDeg?: number
  padViability?: Uint8Array
  padSolarPct?: Uint8Array
  padEarthPct?: Uint8Array
  mode: 'hillshade' | 'vertex3d'
}): Uint8ClampedArray {
  const { site, overlay, sky, lngDeg = 0, padViability, padSolarPct, padEarthPct, mode } = opts
  const count = 65536
  const out = new Uint8ClampedArray(count * 4)
  const elev = site.dem_elev
  const slope = site.dem_slope
  const psr = site.psr_mask
  const grid = site.manifest.analysis_grid
  const halfStep = grid.step_pixel / 2

  let minE = Infinity
  let maxE = -Infinity
  if (mode === 'vertex3d') {
    for (let i = 0; i < count; i++) {
      const e = elev[i]
      if (e < minE) minE = e
      if (e > maxE) maxE = e
    }
  }
  const spanE = Math.max(1, maxE - minE)

  let sx = 0
  let sy = 0
  let sz = 0
  let hLen = 1
  let stepX = 0
  let stepZ = 0
  let tanEl = 0
  if (overlay === 'illumination' && sky) {
    const azR = sky.sun.az * RAD
    const elR = sky.sun.el * RAD
    const sxW = Math.sin(azR) * Math.cos(elR)
    const syW = Math.sin(elR)
    const szW = -Math.cos(azR) * Math.cos(elR)
    const th = lngDeg * RAD
    const ct = Math.cos(th)
    const st = Math.sin(th)
    sx = sxW * ct - szW * st
    sy = syW
    sz = sxW * st + szW * ct
    hLen = Math.hypot(sx, sz) || 1
    stepX = sx / hLen
    stepZ = sz / hLen
    tanEl = sy / hLen
  }

  for (let i = 0; i < count; i++) {
    const py = i >> 8
    const px = i & 255
    let r = 100
    let g = 110
    let b = 122

    if (mode === 'hillshade') {
      const eL = elev[py * 256 + Math.max(0, px - 1)]
      const eR = elev[py * 256 + Math.min(255, px + 1)]
      const eU = elev[Math.max(0, py - 1) * 256 + px]
      const eD = elev[Math.min(255, py + 1) * 256 + px]
      const dx = (eR - eL) * 0.5
      const dy = (eD - eU) * 0.5
      const gray = Math.max(20, Math.min(245, 132 + (110 * (0.6 + dx / 70 + dy / 70)) / Math.hypot(1, dx / 40, dy / 40)))
      r = gray
      g = gray
      b = gray
    } else {
      const t = (elev[i] - minE) / spanE
      ;[r, g, b] = mixRgb(71, 80, 92, 156, 167, 181, t)
    }

    const inGridBox =
      py >= grid.start_pixel - halfStep &&
      py <= grid.start_pixel + (grid.rows - 1) * grid.step_pixel + halfStep &&
      px >= grid.start_pixel - halfStep &&
      px <= grid.start_pixel + (grid.cols - 1) * grid.step_pixel + halfStep
    const cellR = Math.round((py - grid.start_pixel) / grid.step_pixel)
    const cellC = Math.round((px - grid.start_pixel) / grid.step_pixel)
    const validCell = inGridBox && cellR >= 0 && cellR < grid.rows && cellC >= 0 && cellC < grid.cols
    const cellIdx = cellR * grid.cols + cellC

    if (overlay === 'viable' && padViability) {
      if (validCell) {
        const v = padViability[cellIdx]
        if (v === 2) [r, g, b] = mixRgb(r, g, b, 16, 185, 129, 0.6)
        else if (v === 1) [r, g, b] = mixRgb(r, g, b, 245, 158, 11, 0.56)
        else [r, g, b] = mixRgb(r, g, b, 239, 68, 68, 0.44)
      } else {
        r *= 0.72
        g *= 0.72
        b *= 0.72
      }
    } else if (overlay === 'slope') {
      const sl = slope[i]
      if (sl < 5) {
        [r, g, b] = mixRgb(r, g, b, 16, 185, 129, 0.5)
      } else {
        const w = Math.min(0.75, 0.26 + sl / 42)
        ;[r, g, b] = mixRgb(r, g, b, 239, 68, 68, w)
      }
    } else if (overlay === 'psr' && psr[i]) {
      [r, g, b] = mixRgb(r, g, b, 168, 85, 247, 0.78)
    } else if (overlay === 'illumination' && sky) {
      if (sky.sun.el <= -0.8) {
        [r, g, b] = mixRgb(r, g, b, 20, 30, 48, 0.78)
      } else {
        const e0 = elev[i]
        let shadowed = false
        for (let s = 1; s <= 24; s++) {
          const qx = Math.round(px + stepX * s)
          const qy = Math.round(py + stepZ * s)
          if (qx < 0 || qx >= 256 || qy < 0 || qy >= 256) break
          if ((elev[qy * 256 + qx] - e0) / (s * 20) > tanEl + 0.005) {
            shadowed = true
            break
          }
        }
        if (shadowed) {
          [r, g, b] = mixRgb(r, g, b, 17, 24, 39, 0.8)
        } else {
          const eL = elev[py * 256 + Math.max(0, px - 1)]
          const eR = elev[py * 256 + Math.min(255, px + 1)]
          const eU = elev[Math.max(0, py - 1) * 256 + px]
          const eD = elev[Math.min(255, py + 1) * 256 + px]
          const dhx = (eR - eL) / 40
          const dhz = (eD - eU) / 40
          const nm = Math.hypot(-dhx, 1, -dhz) || 1
          const cosInc = Math.max(0, (-dhx * sx + sy - dhz * sz) / nm)
          const lit = Math.min(1, 0.28 + cosInc * 1.45)
          ;[r, g, b] = mixRgb(r, g, b, 250, 204, 21, lit * 0.72)
        }
      }
    } else if (overlay === 'earth' && padEarthPct) {
      if (validCell) {
        const pct = padEarthPct[cellIdx] / 100
        if (pct >= 0.7) [r, g, b] = mixRgb(r, g, b, 56, 189, 248, 0.65)
        else if (pct >= 0.3) [r, g, b] = mixRgb(r, g, b, 245, 158, 11, 0.56)
        else [r, g, b] = mixRgb(r, g, b, 239, 68, 68, 0.48)
      } else {
        r *= 0.72
        g *= 0.72
        b *= 0.72
      }
    } else if (overlay === 'solar_hours' && padSolarPct) {
      if (validCell) {
        const pct = padSolarPct[cellIdx] / 100
        if (pct >= 0.75) [r, g, b] = mixRgb(r, g, b, 250, 204, 21, 0.68)
        else if (pct >= 0.45) [r, g, b] = mixRgb(r, g, b, 245, 158, 11, 0.58)
        else [r, g, b] = mixRgb(r, g, b, 51, 65, 85, 0.68)
      } else {
        r *= 0.72
        g *= 0.72
        b *= 0.72
      }
    }

    const p4 = i * 4
    out[p4] = clampByte(r)
    out[p4 + 1] = clampByte(g)
    out[p4 + 2] = clampByte(b)
    out[p4 + 3] = 255
  }

  return out
}
