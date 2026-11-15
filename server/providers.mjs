import { createHash } from 'node:crypto'

export class ResponseLruCache {
  constructor(maxEntries = 128) {
    this.maxEntries = maxEntries
    this.map = new Map()
    this.hits = 0
    this.misses = 0
  }

  static makeKey(question, context, solverVersion) {
    return createHash('sha256')
      .update(JSON.stringify({ q: String(question).trim().toLowerCase(), context, solverVersion }))
      .digest('hex')
  }

  get(key) {
    if (!this.map.has(key)) {
      this.misses++
      return null
    }
    this.hits++
    const val = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, val)
    return val
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses }
  }
}

export function createOpenAiCompatibleProvider(env = process.env, fetchImpl = fetch) {
  if (!env.UMBRA_MODEL_URL || !env.UMBRA_MODEL) return null
  const url = new URL(env.UMBRA_MODEL_URL)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Use HTTPS for hosted model endpoints (HTTP permitted only on loopback localhost/127.0.0.1).')
  }
  const fallbackList = String(env.UMBRA_MODEL_FALLBACKS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const modelsToTry = [...new Set([env.UMBRA_MODEL.trim(), ...fallbackList].filter(Boolean))]
  const inputUsdPerM = Number(env.UMBRA_COST_INPUT_PER_M ?? 0)
  const outputUsdPerM = Number(env.UMBRA_COST_OUTPUT_PER_M ?? 0)
  const maxRetries = Math.max(0, Math.min(3, Number(env.UMBRA_MODEL_RETRIES ?? 1)))

  return {
    name: local ? 'local-openai-compatible' : 'hosted-openai-compatible',
    model: env.UMBRA_MODEL,
    models: modelsToTry,
    isLocal: local,
    async complete(messages, tools, toolChoice, signal) {
      const modelErrors = []
      for (const modelId of modelsToTry) {
        let attempt = 0
        while (attempt <= maxRetries) {
          if (signal?.aborted) {
            throw signal.reason ?? new Error('Provider request aborted.')
          }
          try {
            const response = await fetchImpl(url, {
              method: 'POST',
              redirect: 'error',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'HTTP-Referer': env.UMBRA_OPENROUTER_REFERER ?? 'http://localhost:5173',
                'X-Title': env.UMBRA_OPENROUTER_TITLE ?? 'Umbra-X',
                ...(env.UMBRA_MODEL_KEY ? { Authorization: 'Bearer ' + env.UMBRA_MODEL_KEY } : {}),
              },
              body: JSON.stringify({
                model: modelId,
                temperature: 0,
                messages,
                tools,
                tool_choice: toolChoice,
              }),
            })
            if ([429, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
              const backoffMs = 150 * Math.pow(2, attempt)
              await new Promise(r => setTimeout(r, backoffMs))
              attempt++
              continue
            }
            if (!response.ok) {
              throw new Error(`${modelId} HTTP ${response.status}`)
            }
            const payload = await response.json()
            const message = payload.choices?.[0]?.message
            if (!message || typeof message !== 'object') {
              throw new Error(`${modelId} response missing choices[0].message.`)
            }
            const promptTokens = Number(payload.usage?.prompt_tokens ?? 0)
            const completionTokens = Number(payload.usage?.completion_tokens ?? 0)
            const estimatedCostUsd =
              (promptTokens * inputUsdPerM + completionTokens * outputUsdPerM) / 1_000_000
            return {
              message,
              modelUsed: modelId,
              usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
              estimatedCostUsd,
              retriesUsed: attempt,
            }
          } catch (err) {
            if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
              throw err
            }
            if (attempt < maxRetries) {
              attempt++
              continue
            }
            modelErrors.push(err?.message ?? `${modelId} failed`)
            break
          }
        }
      }
      throw new Error(modelErrors.join(' | ') || 'Provider call failed.')
    },
  }
}
