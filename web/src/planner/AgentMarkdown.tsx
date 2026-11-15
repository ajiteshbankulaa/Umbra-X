import type { ReactNode } from 'react'

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenRe = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={`i-${key++}`}>{token.slice(1, -1)}</em>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={`c-${key++}`} className="agent-md-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
      if (linkMatch) {
        nodes.push(
          <a key={`l-${key++}`} href={linkMatch[2]} target="_blank" rel="noreferrer" className="agent-md-link">
            {linkMatch[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    }
    lastIndex = tokenRe.lastIndex
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

function normalizeMarkdownLines(raw: string): string[] {
  // Expand inline bullets emitted on a single line (e.g. "I can help you: - **Analyze** ... - **Search** ...")
  const expanded = raw
    .replace(/:\s+-\s+(?=\*\*|[A-Z])/g, ':\n- ')
    .replace(/\s+-\s+(?=\*\*[A-Za-z0-9])/g, '\n- ')
    .replace(/:\s+(\d+)\.\s+(?=\*\*|[A-Z])/g, ':\n$1. ')
    .replace(/\s+(\d+)\.\s+(?=\*\*[A-Za-z0-9])/g, '\n$1. ')
  return expanded.replace(/\r\n/g, '\n').split('\n')
}

export function AgentMarkdown({ text }: { text: string }) {
  const lines = normalizeMarkdownLines(text ?? '')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i].trimEnd()
    const trimmed = line.trim()
    if (!trimmed) {
      i++
      continue
    }

    // Markdown table block
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const splitRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map(cell => cell.trim())
      const headers = splitRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push(
        <div key={`tbl-${key++}`} className="agent-md-table-wrap">
          <table className="agent-md-table">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi}>{renderInlineMarkdown(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci}>{renderInlineMarkdown(r[ci] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    // Headings (#, ##, ###)
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const content = renderInlineMarkdown(headingMatch[2])
      blocks.push(
        level <= 2 ? (
          <h4 key={`h-${key++}`} className="agent-md-h">
            {content}
          </h4>
        ) : (
          <h5 key={`h-${key++}`} className="agent-md-h sub">
            {content}
          </h5>
        ),
      )
      i++
      continue
    }

    // Unordered list (- or *)
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="agent-md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // Ordered list (1. 2. ...)
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="agent-md-list ordered">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Paragraph (coalesce contiguous plain text lines)
    const paraLines: string[] = [trimmed]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith('|')
    ) {
      paraLines.push(lines[i].trim())
      i++
    }
    blocks.push(
      <p key={`p-${key++}`} className="agent-msg-text">
        {renderInlineMarkdown(paraLines.join(' '))}
      </p>,
    )
  }

  return <div className="agent-md">{blocks}</div>
}
