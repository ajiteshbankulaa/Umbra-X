import { ArrowRight, Crosshair, RotateCcw } from 'lucide-react'

type GuidedCase = 'delay' | 'nearby'
interface Props {
  guided: GuidedCase | null
  ready: boolean
  onInspect: () => void
  onReplay: (variant: GuidedCase) => void
}

export function DecisionBrief({ guided, ready, onInspect, onReplay }: Props) {
  const nearby = guided === 'nearby'
  return (
    <section className="decision-brief" aria-labelledby="decision-brief-title">
      <div className="decision-brief-copy">
        <h1 id="decision-brief-title">{guided === 'delay' ? 'What changes if landing slips by 48 hours?' : nearby ? 'Does a nearby pad meet the geometry limits?' : 'Compare lunar landing plans'}</h1>
        {guided && (
          <p>{nearby
            ? 'Compare two pads 280 m apart at the same landing time.'
            : 'Compare two landing times on the same Shackleton Ridge pad.'}</p>
        )}
      </div>
      <div className="decision-brief-actions">
        {guided && (
          <button className="decision-btn-secondary" type="button" disabled={!ready} onClick={onInspect}>
            <Crosshair size={14} aria-hidden="true" /> Show Earth at the horizon
          </button>
        )}
        <button className="decision-btn-primary" type="button" onClick={() => onReplay(guided === 'delay' ? 'nearby' : 'delay')}>
          {guided === 'delay' ? <>Try nearby Pad #479 <ArrowRight size={15} aria-hidden="true" /></> : <><RotateCcw size={14} aria-hidden="true" /> Replay the 48-hour delay</>}
        </button>
      </div>
    </section>
  )
}
