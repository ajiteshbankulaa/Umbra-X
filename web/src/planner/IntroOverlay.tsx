import { lazy, Suspense, useCallback, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { CursorTriangles } from './CursorTriangles'
import type { IntroFocus } from './IntroScene'
import { LunarLocator } from './TelemetryCharts'

const IntroScene = lazy(() => import('./IntroScene'))

interface IntroOverlayProps {
  canRender3D: boolean
  introFocus: IntroFocus
  onEnter: () => void
}

export function IntroOverlay({
  canRender3D,
  introFocus,
  onEnter,
}: IntroOverlayProps) {
  const [sceneReady, setSceneReady] = useState(false)
  const handleReady = useCallback(() => setSceneReady(true), [])

  return (
    <div className="mission">
      <CursorTriangles />
      <div className="intro-shell">
        <section className="intro-content" aria-label="Welcome to Umbra-X">
          <div className="intro-topbar">
            <div className="intro-brand">
              <span className="brand-mark" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M9.5 3a4.6 4.6 0 0 0 0 9 4.5 4.5 0 1 1 0-9Z" fill="currentColor" opacity="0.85" />
                  <line x1="1" y1="12.5" x2="15" y2="12.5" stroke="#00d4aa" strokeWidth="1.4" />
                </svg>
              </span>
              <strong>Umbra-X</strong>
            </div>
            <a
              href="https://github.com/ajiteshbankulaa/Umbra-X"
              target="_blank"
              rel="noreferrer"
              className="intro-github-link"
              aria-label="Umbra-X GitHub repository"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
              GitHub
            </a>
          </div>

          <div className="intro-main">
            <div className="intro-greeting">
              <h1>Lunar Navigator</h1>
              <p className="intro-subtitle">Compare sunlight, Earth visibility &amp; landing-pad recovery.</p>
            </div>

            <div className="intro-actions">
              <button type="button" className="intro-enter-btn" onClick={onEnter}>
                Enter Navigator <ArrowRight size={14} />
              </button>
            </div>
          </div>

          <div />
        </section>

        <section className="intro-stage" aria-label="Interactive 3D Moon">
          <img
            src={import.meta.env.BASE_URL + 'textures/lola_spole_preview.png'}
            alt="LRO LOLA Lunar South Pole preview"
            className="intro-preview-img"
            aria-hidden="true"
          />
          {canRender3D ? (
            <Suspense fallback={null}>
              <IntroScene focus={introFocus} selectedView="orbit" onReady={handleReady} />
            </Suspense>
          ) : (
            <div className="intro-fallback">
              <LunarLocator coordinates={[-89.5, 0, 0]} />
            </div>
          )}
          {canRender3D && (
            <div
              className={sceneReady ? 'intro-stage-loader is-ready' : 'intro-stage-loader'}
              role="status"
              aria-live="polite"
              aria-hidden={sceneReady}
            >
              <span className="intro-loading-badge">
                <span className="intro-loading-spinner" aria-hidden="true" />
                Loading 3D lunar globe…
              </span>
            </div>
          )}
          <div className="intro-stage-hud" aria-hidden="true">
            <span className="intro-region-legend">
              <i style={{ background: '#10b981' }} /> Shackleton
              <i style={{ background: '#f59e0b' }} /> Malapert
              <i style={{ background: '#60a5fa' }} /> Mons Mouton
            </span>
            <span className="intro-hint">Drag to orbit · Scroll to zoom</span>
          </div>
        </section>
      </div>
    </div>
  )
}
