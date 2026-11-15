import { readdir, stat, readFile } from 'node:fs/promises'
import { resolve, relative, basename } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(process.argv[2] || 'web/dist')
const release = resolve(root, 'data/planner-release')
let files = 0
let bytes = 0

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in release: ${relative(root, path)}`)
    if (entry.isDirectory()) {
      if (['submission', 'recordings', 'presentations', 'node_modules', '.git', 'raw_cache'].includes(entry.name)) {
        throw new Error(`Private or development directory in release: ${entry.name}`)
      }
      await inspect(path)
      continue
    }
    const { size } = await stat(path)
    if (size > 25 * 1024 * 1024) throw new Error(`Pages asset exceeds 25 MiB: ${relative(root, path)}`)
    if (entry.name.startsWith('.env') || /\.(log|tfstate|tfplan)$/.test(entry.name)) {
      throw new Error(`Local state in release: ${relative(root, path)}`)
    }
    if (/^[a-f0-9]{64}\.bin$/.test(entry.name)) {
      const digest = createHash('sha256').update(await readFile(path)).digest('hex')
      if (`${digest}.bin` !== basename(path)) throw new Error(`Content hash mismatch: ${path}`)
    }
    files++
    bytes += size
  }
}

await readFile(resolve(root, 'index.html'))
await readFile(resolve(root, 'wasm/umbra_core.wasm'))
for (const site of ['shackleton-ridge', 'mons-mouton', 'malapert-massif']) {
  const manifest = JSON.parse(await readFile(resolve(release, site, 'planner.json'), 'utf8'))
  for (const hash of [manifest.vectorHash, manifest.regional?.regional]) {
    if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error(`Missing release hash for ${site}`)
    await stat(resolve(release, 'planner', `${hash}.bin`))
  }
}
await inspect(root)
if (files > 20000) throw new Error(`Pages file count exceeded: ${files}`)
console.log(JSON.stringify({ files, bytes, hosting: 'Cloudflare Pages', passed: true }))
