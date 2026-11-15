import { useEffect, useRef } from 'react'

interface Tri {
  x1: number
  y1: number
  x2: number
  y2: number
  x3: number
  y3: number
  cx: number
  cy: number
  heat: number
}

export function CursorTriangles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let tris: Tri[] = []
    let mouseX = -9999
    let mouseY = -9999
    let raf = 0

    const buildGrid = () => {
      width = canvas.width = window.innerWidth
      height = canvas.height = window.innerHeight
      tris = []

      const size = 56
      const h = size * 0.866
      const cols = Math.ceil(width / size) + 2
      const rows = Math.ceil(height / h) + 2

      // Jittered triangular lattice vertices
      const pts: { x: number; y: number }[][] = []
      for (let r = 0; r <= rows; r++) {
        const rowPts: { x: number; y: number }[] = []
        const offset = r % 2 === 1 ? size * 0.5 : 0
        for (let c = 0; c <= cols; c++) {
          const jx = (Math.sin(r * 19.3 + c * 7.1) * 0.5) * size * 0.28
          const jy = (Math.cos(r * 11.7 + c * 23.9) * 0.5) * h * 0.28
          rowPts.push({
            x: (c - 1) * size + offset + jx,
            y: (r - 1) * h + jy,
          })
        }
        pts.push(rowPts)
      }

      const pushTri = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
        tris.push({
          x1: a.x, y1: a.y,
          x2: b.x, y2: b.y,
          x3: c.x, y3: c.y,
          cx: (a.x + b.x + c.x) / 3,
          cy: (a.y + b.y + c.y) / 3,
          heat: 0,
        })
      }

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const p00 = pts[r][c]
          const p10 = pts[r][c + 1]
          const p01 = pts[r + 1][c]
          const p11 = pts[r + 1][c + 1]
          if (r % 2 === 0) {
            pushTri(p00, p10, p01)
            pushTri(p10, p11, p01)
          } else {
            pushTri(p00, p10, p11)
            pushTri(p00, p11, p01)
          }
        }
      }
    }

    const onMove = (e: PointerEvent) => {
      mouseX = e.clientX
      mouseY = e.clientY
    }

    const onLeave = () => {
      mouseX = -9999
      mouseY = -9999
    }

    const radius = 145
    const radiusSq = radius * radius

    const render = () => {
      ctx.clearRect(0, 0, width, height)

      for (let i = 0; i < tris.length; i++) {
        const t = tris[i]
        const dx = t.cx - mouseX
        const dy = t.cy - mouseY
        const dSq = dx * dx + dy * dy
        if (dSq < radiusSq) {
          const proximity = 1 - Math.sqrt(dSq) / radius
          const target = Math.pow(proximity, 1.5)
          if (target > t.heat) t.heat = target
        }

        if (t.heat > 0.008) {
          t.heat *= 0.935
          ctx.beginPath()
          ctx.moveTo(t.x1, t.y1)
          ctx.lineTo(t.x2, t.y2)
          ctx.lineTo(t.x3, t.y3)
          ctx.closePath()
          ctx.fillStyle = `rgba(168, 85, 247, ${t.heat * 0.22})`
          ctx.fill()
          ctx.strokeStyle = `rgba(192, 132, 252, ${t.heat * 0.55})`
          ctx.lineWidth = 0.85
          ctx.stroke()
        } else {
          t.heat = 0
        }
      }

      raf = requestAnimationFrame(render)
    }

    buildGrid()
    window.addEventListener('resize', buildGrid)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerleave', onLeave)
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', buildGrid)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 55,
      }}
    />
  )
}
