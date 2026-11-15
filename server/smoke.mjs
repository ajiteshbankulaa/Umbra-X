import assert from 'node:assert/strict'

const api = process.env.UMBRA_SMOKE_URL ?? 'http://127.0.0.1:8787/api/study'
const signal = AbortSignal.timeout(30_000)
async function request(path, body) {
  const response = await fetch(api + path, {
    signal,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`)
  return response.json()
}
const site = 'shackleton-ridge'
const coverage = await request('/coverage')
assert.equal(coverage.sites.length, 3)
const input = { plan: { kind: 'compare', days: 15, scenarios: [
  { site, node: 480, start: 0, mast: 2 },
  { site, node: 180, start: 48, mast: 2 },
] } }
let job = await request('/runs', input)
while (job.state === 'queued' || job.state === 'running') {
  await new Promise(resolve => setTimeout(resolve, 250))
  job = await request('/runs/' + job.id)
}
assert.equal(job.state, 'completed', job.error)
const hours = job.result.comparisons.map(row => row.earthObstructionHours)
assert.ok(Math.abs(hours[0] - 103.6666667) < 1e-6)
assert.equal(hours[1], 0)
const repeated = await request('/runs', input)
assert.equal(repeated.id, job.id)
assert.equal(repeated.reused, true)
console.log(`Saved run ${job.id} reproduced ${hours[0].toFixed(1)} to ${hours[1]} Earth obstruction hours. Duplicate reused.`)
