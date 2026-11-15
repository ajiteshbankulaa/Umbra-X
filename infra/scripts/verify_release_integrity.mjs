import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const RELEASE_DIR = resolve(ROOT, 'web/public/data/planner-release')
const WASM_PATH = resolve(ROOT, 'web/public/wasm/umbra_core.wasm')
const SITES = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']

async function sha256File(path) {
  const buf = await readFile(path)
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength }
}

async function main() {
  const siteRecords = {}
  const vectorHashes = new Set()

  for (const site of SITES) {
    const planner = JSON.parse(await readFile(resolve(RELEASE_DIR, site, 'planner.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(resolve(RELEASE_DIR, site, 'manifest.json'), 'utf8'))

    assert.equal(planner.schema, 1, `${site} schema != 1`)
    assert.equal(planner.count, 8641, `${site} ephemeris count != 8641`)
    assert.equal(planner.stepMinutes, 5, `${site} stepMinutes != 5`)
    assert.equal(planner.observers.length, 961, `${site} observers.length != 961`)
    vectorHashes.add(planner.vectorHash)

    const localBin = await sha256File(resolve(RELEASE_DIR, site, 'horizons.bin'))
    assert.equal(localBin.sha256, planner.localHash, `${site} localHash mismatch`)
    assert.equal(localBin.bytes, 961 * 5 * 360 * 4, `${site} horizons.bin size mismatch`)

    const regionalBins = {}
    for (const [role, hash] of Object.entries(planner.regional)) {
      if (!/^[a-f0-9]{64}$/.test(String(hash))) continue
      const info = await sha256File(resolve(RELEASE_DIR, 'planner', `${hash}.bin`))
      assert.equal(info.sha256, hash, `${site} regional ${role} hash mismatch`)
      regionalBins[role] = info
    }

    siteRecords[site] = {
      start: planner.start,
      vectorHash: planner.vectorHash,
      localHash: planner.localHash,
      terrainSource: planner.regional.source,
      mastHeightsM: manifest.mast_heights_m,
      regionalBins,
    }
  }

  // Cross-region compatibility invariant: all 3 polar regions must bind to the exact same DE440 vector binary
  assert.equal(vectorHashes.size, 1, `Mismatched DE440 vector hashes across sites: ${[...vectorHashes].join(', ')}`)
  const [sharedVectorHash] = [...vectorHashes]
  const vecInfo = await sha256File(resolve(RELEASE_DIR, 'planner', `${sharedVectorHash}.bin`))
  assert.equal(vecInfo.sha256, sharedVectorHash, 'Shared DE440 vector binary hash mismatch')

  const wasmInfo = await sha256File(WASM_PATH)
  const releaseFingerprint = createHash('sha256')
    .update(JSON.stringify({ sharedVectorHash, wasmSha256: wasmInfo.sha256, siteRecords }))
    .digest('hex')

  const output = {
    schemaVersion: 'phase5-release-manifest-v1',
    verifiedAt: new Date().toISOString(),
    releaseFingerprint,
    sharedEphemeris: { sha256: sharedVectorHash, bytes: vecInfo.bytes },
    wasmBinary: { path: 'web/public/wasm/umbra_core.wasm', ...wasmInfo },
    sites: siteRecords,
    rollbackProtocol: 'Restore previous signed web/dist + web/public/data/planner-release pointer and verify releaseFingerprint before DNS/bucket cutover.',
  }

  if (process.argv.includes('--write-manifest')) {
    const outPath = resolve(RELEASE_DIR, 'release-manifest.json')
    await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8')
  }
  console.log(JSON.stringify(output, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
