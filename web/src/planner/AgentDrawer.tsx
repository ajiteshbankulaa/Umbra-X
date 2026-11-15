import type { RefObject } from 'react'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { AgentMarkdown } from './AgentMarkdown'
import type { ChatMessage } from './missionHelpers'

interface AgentDrawerProps {
  chatMessages: ChatMessage[]
  agentBusy: boolean
  chatInput: string
  setChatInput: (val: string) => void
  onSend: (query: string, displayLabel?: string) => Promise<void> | void
  threadRef: RefObject<HTMLDivElement | null>
}

export function AgentDrawer({
  chatMessages,
  agentBusy,
  chatInput,
  setChatInput,
  onSend,
  threadRef,
}: AgentDrawerProps) {
  return (
    <>
      <div className="agent-chat-thread" ref={threadRef}>
        {chatMessages.map(msg => (
          <div key={msg.id} className={msg.sender === 'user' ? 'agent-msg user' : 'agent-msg assistant'}>
            {msg.headline && <div className="agent-msg-headline">{msg.headline}</div>}
            {msg.sender === 'agent' ? (
              <AgentMarkdown text={msg.text} />
            ) : (
              <p className="agent-msg-text">{msg.text}</p>
            )}
            {msg.actionsApplied && msg.actionsApplied.length > 0 && (
              <div className="agent-actions-bar" aria-label="Workspace actions applied">
                {msg.actionsApplied.map(act => (
                  <span key={act} className="agent-action-chip">
                    {act}
                  </span>
                ))}
              </div>
            )}
            {msg.charts && msg.charts.map((chart, ci) => {
              const maxVal = Math.max(
                1,
                ...chart.series.flatMap(s => [Math.abs(s.baseline), Math.abs(s.alternative ?? 0), Math.abs(s.limit ?? 0)]),
              )
              return (
                <div key={`${msg.id}-chart-${ci}`} className="agent-chart-card">
                  <div className="agent-chart-head">
                    <strong>{chart.title}</strong>
                    {chart.subtitle && <span>{chart.subtitle}</span>}
                  </div>
                  <div className="agent-chart-bars">
                    {chart.series.map(s => (
                      <div key={s.label} className="agent-bar-group">
                        <div className="agent-bar-label">
                          <span>{s.label}</span>
                          <em>
                            {s.baseline} {chart.unit}
                            {s.alternative !== undefined ? ` vs ${s.alternative} ${chart.unit}` : ''}
                            {s.limit !== undefined ? ` (limit ${s.limit})` : ''}
                          </em>
                        </div>
                        <div className="agent-bar-track">
                          <div
                            className="agent-bar-fill baseline"
                            style={{ width: `${Math.min(100, (Math.abs(s.baseline) / maxVal) * 100)}%` }}
                          />
                          {s.limit !== undefined && (
                            <span
                              className="agent-bar-limit"
                              style={{ left: `${Math.min(99, (Math.abs(s.limit) / maxVal) * 100)}%` }}
                              title={`Limit: ${s.limit} ${chart.unit}`}
                            />
                          )}
                        </div>
                        {s.alternative !== undefined && (
                          <div className="agent-bar-track alt-track">
                            <div
                              className="agent-bar-fill alternative"
                              style={{ width: `${Math.min(100, (Math.abs(s.alternative) / maxVal) * 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="agent-chart-legend">
                    <span><i className="dot-base" /> Baseline</span>
                    {chart.series.some(s => s.alternative !== undefined) && <span><i className="dot-alt" /> Alternative</span>}
                    {chart.series.some(s => s.limit !== undefined) && <span><i className="dot-limit" /> Limit</span>}
                  </div>
                </div>
              )
            })}
            {msg.report && (msg.report.title || msg.report.summary) && (
              <div className="agent-report-card">
                {msg.report.title && <div className="agent-report-title">{msg.report.title}</div>}
                {msg.report.summary && <p className="agent-report-summary">{msg.report.summary}</p>}
                {Array.isArray(msg.report.recommendations) && msg.report.recommendations.length > 0 && (
                  <ul className="agent-report-recs">
                    {msg.report.recommendations.map((rec, ri) => (
                      <li key={ri}>{rec}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {((msg.facts && msg.facts.length > 0) || (msg.citations && msg.citations.length > 0)) && (
              <details className="agent-msg-details">
                <summary>Verified data &amp; sources</summary>
                {msg.facts && msg.facts.length > 0 && (
                  <table className="agent-facts-table">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Base</th>
                        <th>Alt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {msg.facts.map(f => (
                        <tr key={f.label}>
                          <td>{f.label}</td>
                          <td>{f.baseline}</td>
                          <td>{f.alternative}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="agent-citations">
                    {msg.citations.map(cit => (
                      <a key={cit.id} href={cit.url} target="_blank" rel="noreferrer">
                        {cit.title} <ArrowUpRight size={10} />
                      </a>
                    ))}
                  </div>
                )}
              </details>
            )}
          </div>
        ))}
        {agentBusy && (
          <div className="agent-msg assistant agent-thinking">
            <span className="thinking-dots"><i /><i /><i /></span>
            <span>Umbra Agent analyzing &amp; executing tools…</span>
          </div>
        )}
      </div>

      <div className="agent-composer">
        <div className="agent-suggestions" aria-label="Suggested prompts">
          {[
            { label: 'Compare Base vs Alt + chart', query: 'Compare baseline and alternative scenarios and generate a comparison chart and brief report.' },
            { label: 'Orbit 3D + illumination overlay', query: 'Switch to Orbit 3D view and turn on the illumination overlay.' },
            { label: 'Find safer pads across sites', query: 'Search across Shackleton, Mons Mouton, and Malapert for viable passing pads.' },
          ].map(item => (
            <button
              key={item.label}
              type="button"
              className="agent-suggestion-pill"
              disabled={agentBusy}
              onClick={() => void onSend(item.query, item.label)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <form
          className="agent-input-row"
          onSubmit={e => {
            e.preventDefault()
            void onSend(chatInput)
          }}
        >
          <input
            type="text"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            placeholder="Ask Umbra Agent, request a chart, or command 3D view…"
            aria-label="Ask Umbra Agent"
          />
          <button type="submit" disabled={agentBusy} aria-label="Send message">
            <ArrowRight size={14} />
          </button>
        </form>
      </div>
    </>
  )
}
