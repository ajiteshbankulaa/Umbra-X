import { lazy, Suspense } from 'react'
import { ArrowRight } from 'lucide-react'
import type { IntroFocus } from './IntroScene'
import { VIEW_CARDS } from './missionHelpers'
import { LunarLocator } from './TelemetryCharts'
import { CursorTriangles } from './CursorTriangles'

const IntroScene = lazy(() => import('./IntroScene'))

type ViewId = 'orbit' | 'pad' | 'polar' | 'chart'

const VIEW_GUIDE: Record<ViewId, string> = {
  pad: 'Eye-level 3D view across crater rims toward the Sun and Earth.',
  orbit: 'Local 5.12 km relief with a horizon modeled up to 96 km.',
  polar: '360° azimuth dome plotting Sun and Earth horizon arcs.',
  chart: '2D horizon elevation profile chart of ridge obstacle angles.',
}

interface IntroOverlayProps {
  canRender3D: boolean
  view: ViewId
  setView: (view: ViewId) => void
  introFocus: IntroFocus
  onEnter: () => void
}

export function IntroOverlay({
  canRender3D,
  view,
  setView,
  introFocus,
  onEnter,
}: IntroOverlayProps) {
  return (
    <div className="mission">
      <div className="intro-shell">
        <section className="intro-content" aria-label="Welcome to Umbra-X">
          <CursorTriangles />
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
              <h1>Lunar South Pole Navigator</h1>
              <p className="intro-subtitle">Compare where and when to land. See how a two-day delay changes what a lunar lander can see from the same pad.</p>
            </div>

            <div className="intro-section">
              <div className="intro-section-head">
                <span className="intro-prompt">Starting view (optional)</span>
              </div>
              <div className="intro-view-strip" role="group" aria-label="Select your starting view">
                {VIEW_CARDS.map(card => (
                  <button
                    key={card.id}
                    type="button"
                    className="view-cell"
                    title={VIEW_GUIDE[card.id]}
                    aria-pressed={view === card.id}
                    disabled={(card.id === 'orbit' || card.id === 'pad') && !canRender3D}
                    onClick={() => setView(card.id)}
                  >
                    <strong>{card.title}</strong>
                  </button>
                ))}
              </div>
            </div>

            <div className="intro-actions">
              <button type="button" className="intro-enter-btn" onClick={onEnter}>
                Open landing comparison <ArrowRight size={14} />
              </button>
              <div className="intro-telemetry-meta">NASA lunar terrain · JPL Sun and Earth positions</div>
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
            <Suspense
              fallback={
                <div className="intro-fallback">
                  <div className="orbital-loader" aria-hidden="true">
                    <span className="orbital-ring" />
                    <span className="orbital-moon" />
                  </div>
                </div>
              }
            >
              <IntroScene focus={introFocus} selectedView={view} />
            </Suspense>
          ) : (
            <div className="intro-fallback">
              <LunarLocator coordinates={[-89.5, 0, 0]} />
            </div>
          )}
          <div className="intro-stage-hud" aria-hidden="true">
            <span className="intro-region-legend">
              <i style={{ background: '#10b981' }} /> Shackleton
              <i style={{ background: '#f59e0b' }} /> Malapert
              <i style={{ background: '#60a5fa' }} /> Mons Mouton
            </span>
            <span className="intro-hint">{canRender3D ? 'Illustrative globe · LOLA south-pole relief · Drag to orbit' : 'South-pole preview · 2D views available'}</span>
          </div>
        </section>
      </div>
    </div>
  )
}
