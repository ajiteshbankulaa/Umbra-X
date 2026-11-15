import { timingSafeEqual } from 'node:crypto'

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isLoopbackHost(host = '127.0.0.1') {
  const h = String(host).trim().toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

export function assertSafeBindConfig(host, apiToken) {
  if (isLoopbackHost(host)) return
  const tok = String(apiToken ?? '').trim()
  if (tok.length < 24 || /^(changeme|secret|token|default|umbra-dev)/i.test(tok)) {
    throw new Error(
      `Refusing to bind server to non-loopback host "${host}" without a strong UMBRA_API_TOKEN (>= 24 chars).`,
    )
  }
}

export function constantTimeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function checkBearerAuth(req, expectedToken) {
  if (!expectedToken) return { ok: true, mode: 'loopback-trusted' }
  const raw = req.headers.authorization ?? ''
  const match = String(raw).match(/^Bearer\s+(.+)$/i)
  if (!match) return { ok: false, reason: 'missing_bearer_token' }
  if (!constantTimeTokenEqual(match[1].trim(), expectedToken)) {
    return { ok: false, reason: 'invalid_bearer_token' }
  }
  return { ok: true, mode: 'bearer-verified' }
}

export class IpRateLimiter {
  constructor({ windowMs = 60_000, maxRequests = 60 } = {}) {
    this.windowMs = windowMs
    this.maxRequests = maxRequests
    this.buckets = new Map()
  }

  allow(ip = 'unknown', cost = 1, now = Date.now()) {
    const key = String(ip)
    let entry = this.buckets.get(key)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs }
      this.buckets.set(key, entry)
    }
    if (entry.count + cost > this.maxRequests) {
      return {
        allowed: false,
        remaining: Math.max(0, this.maxRequests - entry.count),
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      }
    }
    entry.count += cost
    if (this.buckets.size > 4096) {
      for (const [k, v] of this.buckets) {
        if (now >= v.resetAt) this.buckets.delete(k)
      }
    }
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - entry.count),
      retryAfterSec: 0,
    }
  }
}

export function hasForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasForbiddenKeys)
  for (const k of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_JSON_KEYS.has(k)) return true
    if (hasForbiddenKeys(value[k])) return true
  }
  return false
}

export async function readSafeJsonBody(req, maxBytes = 16384) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const err = new Error(`Request exceeds ${maxBytes} bytes.`)
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) {
    const err = new Error('Empty JSON request body.')
    err.statusCode = 400
    throw err
  }
  const parsed = JSON.parse(raw)
  if (hasForbiddenKeys(parsed)) {
    const err = new Error('Rejected forbidden object key in request payload.')
    err.statusCode = 400
    throw err
  }
  return parsed
}

export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
}
