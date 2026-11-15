import { randomUUID } from 'node:crypto'

const DEFAULT_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 30000]

function labelKey(labels = {}) {
  const keys = Object.keys(labels).sort()
  return keys.map(k => `${k}=${String(labels[k])}`).join(',')
}

function formatLabels(labels = {}) {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ''
  const parts = keys.map(k => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${parts.join(',')}}`
}

export class MetricsRegistry {
  constructor() {
    this.counters = new Map()
    this.gauges = new Map()
    this.histograms = new Map()
  }

  _ensureCounter(name, help) {
    if (!this.counters.has(name)) this.counters.set(name, { help, values: new Map() })
    return this.counters.get(name)
  }

  _ensureGauge(name, help) {
    if (!this.gauges.has(name)) this.gauges.set(name, { help, values: new Map() })
    return this.gauges.get(name)
  }

  _ensureHistogram(name, help, buckets = DEFAULT_BUCKETS_MS) {
    if (!this.histograms.has(name)) this.histograms.set(name, { help, buckets, series: new Map() })
    return this.histograms.get(name)
  }

  incCounter(name, help, labels = {}, delta = 1) {
    const c = this._ensureCounter(name, help)
    const k = labelKey(labels)
    const cur = c.values.get(k) ?? { labels, value: 0 }
    cur.value += delta
    c.values.set(k, cur)
  }

  setGauge(name, help, labels = {}, value = 0) {
    const g = this._ensureGauge(name, help)
    const k = labelKey(labels)
    g.values.set(k, { labels, value })
  }

  observeHistogram(name, help, labels = {}, value = 0, buckets = DEFAULT_BUCKETS_MS) {
    if (!Number.isFinite(value)) return
    const h = this._ensureHistogram(name, help, buckets)
    const k = labelKey(labels)
    let s = h.series.get(k)
    if (!s) {
      s = { labels, counts: new Array(h.buckets.length).fill(0), sum: 0, count: 0 }
      h.series.set(k, s)
    }
    s.sum += value
    s.count += 1
    for (let i = 0; i < h.buckets.length; i++) {
      if (value <= h.buckets[i]) s.counts[i] += 1
    }
  }

  toPrometheusText() {
    const lines = []
    for (const [name, c] of this.counters) {
      lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`)
      for (const entry of c.values.values()) lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`)
    }
    for (const [name, g] of this.gauges) {
      lines.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`)
      for (const entry of g.values.values()) lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`)
    }
    for (const [name, h] of this.histograms) {
      lines.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`)
      for (const s of h.series.values()) {
        for (let i = 0; i < h.buckets.length; i++) {
          lines.push(`${name}_bucket${formatLabels({ ...s.labels, le: h.buckets[i] })} ${s.counts[i]}`)
        }
        lines.push(`${name}_bucket${formatLabels({ ...s.labels, le: '+Inf' })} ${s.count}`)
        lines.push(`${name}_sum${formatLabels(s.labels)} ${Number(s.sum.toFixed(4))}`)
        lines.push(`${name}_count${formatLabels(s.labels)} ${s.count}`)
      }
    }
    return lines.join('\n') + '\n'
  }
}

export function parseTraceparent(headerValue) {
  if (typeof headerValue !== 'string') return null
  const m = headerValue.trim().match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/i)
  if (!m) return null
  return { traceId: m[1].toLowerCase(), parentSpanId: m[2].toLowerCase(), flags: m[3].toLowerCase() }
}

export function newTraceId() {
  return randomUUID().replace(/-/g, '')
}

export function newSpanId() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

export class TraceRecorder {
  constructor(serviceName = 'umbra-api', maxSpans = 200) {
    this.serviceName = serviceName
    this.maxSpans = maxSpans
    this.spans = []
  }

  startSpan(name, { traceId, parentSpanId = null, attributes = {} } = {}) {
    const tId = traceId || newTraceId()
    const sId = newSpanId()
    const startUnixNano = BigInt(Date.now()) * 1_000_000n
    const t0 = performance.now()
    return {
      traceId: tId,
      spanId: sId,
      parentSpanId,
      traceparent: `00-${tId}-${sId}-01`,
      end: ({ status = 'OK', error = null, extraAttributes = {} } = {}) => {
        const elapsedMs = performance.now() - t0
        const endUnixNano = startUnixNano + BigInt(Math.round(elapsedMs * 1_000_000))
        const span = {
          resource: { serviceName: this.serviceName },
          traceId: tId,
          spanId: sId,
          parentSpanId,
          name,
          startTimeUnixNano: startUnixNano.toString(),
          endTimeUnixNano: endUnixNano.toString(),
          durationMs: Number(elapsedMs.toFixed(3)),
          status: { code: status, ...(error ? { message: redactString(String(error)) } : {}) },
          attributes: sanitizeAttributes({ ...attributes, ...extraAttributes }),
        }
        this.spans.push(span)
        if (this.spans.length > this.maxSpans) this.spans.shift()
        return span
      },
    }
  }

  recent(limit = 50) {
    return this.spans.slice(-limit)
  }
}

export function redactString(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(sk-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,})/g, '[REDACTED_KEY]')
    .replace(/([?&](?:api_key|key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
}

function sanitizeAttributes(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (/key|token|secret|password|auth/i.test(k)) continue
    out[k] = typeof v === 'string' ? redactString(v).slice(0, 240) : v
  }
  return out
}

export function createLogger({ service = 'umbra-api', silent = false } = {}) {
  const emit = (level, msg, meta = {}) => {
    if (silent) return
    const record = {
      timestamp: new Date().toISOString(),
      level,
      service,
      msg: redactString(msg),
      ...sanitizeAttributes(meta),
    }
    const line = JSON.stringify(record)
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  }
}
