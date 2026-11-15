import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(webRoot, '..')
const liveScript = resolve(repoRoot, 'pipeline/live_terrain.py')
const tifPath = resolve(repoRoot, 'pipeline/cache/LDEM_80S_80MPP_ADJ.TIF')
const terrainServiceUrl = (process.env.UMBRA_TERRAIN_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '')

function resolvePythonBin(): string | null {
  const candidates = [
    process.env.UMBRA_PYTHON_BIN,
    resolve(repoRoot, '.venv/Scripts/python.exe'),
    resolve(repoRoot, '.venv/bin/python'),
    process.platform === 'win32' ? 'python' : 'python3',
  ].filter((v): v is string => Boolean(v))
  for (const cand of candidates) {
    if (!cand.includes('/') && !cand.includes('\\')) return cand
    if (existsSync(cand)) return cand
  }
  return null
}

function livePolarHorizonMiddleware(): Plugin {
  const attach = (middlewares: { use: (path: string, handler: (req: any, res: any) => void) => void }) => {
    const handler = async (req: any, res: any) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const lat = Number(url.searchParams.get('lat'))
      const lon = Number(url.searchParams.get('lon'))
      const mast = Number(url.searchParams.get('mast') ?? '5')
      if (!Number.isFinite(lat) || lat < -90 || lat > -80 || !Number.isFinite(lon) || lon < -180 || lon > 360 || !Number.isFinite(mast) || mast < 0 || mast > 50) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ supported: false, error: 'Coordinate outside supported LDEM_80S range (-90 to -80 deg).' }))
        return
      }
      try {
        const upstream = await fetch(`${terrainServiceUrl}/api/polar-horizon${url.search}`, { signal: AbortSignal.timeout(60000) })
        if (upstream.ok) {
          res.statusCode = upstream.status
          res.setHeader('Content-Type', 'application/json')
          res.end(await upstream.text())
          return
        }
      } catch {
        // Fallback to on-demand Python subprocess if persistent terrain daemon is not running
      }
      const pyBin = resolvePythonBin()
      if (!pyBin || !existsSync(liveScript) || !existsSync(tifPath)) {
        res.statusCode = 501
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ supported: false, error: 'Live LOLA DEM service not provisioned on this static host.' }))
        return
      }
      execFile(pyBin, [liveScript, '--lat', String(lat), '--lon', String(lon), '--mast', String(mast)], { cwd: repoRoot, timeout: 60000 }, (err, stdout, stderr) => {
        res.setHeader('Content-Type', 'application/json')
        if (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ supported: false, error: stderr || err.message }))
          return
        }
        res.statusCode = 200
        res.end(stdout)
      })
    }
    middlewares.use('/api/polar-horizon', handler)
    middlewares.use('/api/horizon', handler)
  }
  return {
    name: 'umbra-live-polar-horizon',
    configureServer(server) {
      attach(server.middlewares)
    },
    configurePreviewServer(server) {
      attach(server.middlewares)
    },
  }
}

export default defineConfig({
  plugins: [react(), livePolarHorizonMiddleware()],
  server: {
    proxy: {
      '/api/study': 'http://127.0.0.1:8787',
      '/api/research': 'http://127.0.0.1:8787',
      '/api/telemetry': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/readyz': 'http://127.0.0.1:8787',
      '/metrics': 'http://127.0.0.1:8787',
    },
  },
  preview: {
    proxy: {
      '/api/study': 'http://127.0.0.1:8787',
      '/api/research': 'http://127.0.0.1:8787',
      '/api/telemetry': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/readyz': 'http://127.0.0.1:8787',
      '/metrics': 'http://127.0.0.1:8787',
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three'
          if (id.includes('node_modules/@react-three')) return 'r3f'
          if (id.includes('node_modules/react')) return 'react'
        },
      },
    },
  },
})
