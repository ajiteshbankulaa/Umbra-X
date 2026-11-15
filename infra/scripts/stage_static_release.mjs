import { copyFile, cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const source = resolve(process.argv[2] || 'web/dist')
if (!process.argv[3]) throw new Error('Usage: node infra/scripts/stage_static_release.mjs web/dist <new-output-directory>')
const destination = resolve(process.argv[3])
if (destination === source || destination.startsWith(source + sep)) {
  throw new Error('The staging directory must be outside the build directory.')
}

const sites = ['shackleton-ridge', 'mons-mouton', 'malapert-massif']
const localFiles = ['dem_elev.bin', 'dem_err.bin', 'dem_slope.bin', 'horizons_err.bin', 'horizons.bin', 'manifest.json', 'planner.json', 'psr_mask.bin']
const inputData = join(source, 'data', 'planner-release')
const outputData = join(destination, 'data', 'planner-release')
const referenced = new Set()
for (const site of sites) {
  const metadata = JSON.parse(await readFile(join(inputData, site, 'planner.json'), 'utf8'))
  for (const digest of [metadata.vectorHash, ...['regional', 'distance', 'coverage', 'sensitivity'].map(key => metadata.regional?.[key])]) {
    if (!/^[0-9a-f]{64}$/.test(digest ?? '')) throw new Error(`Invalid data digest: ${site}`)
    referenced.add(digest)
  }
}

// Do not overwrite an existing staging tree. Copy the app and only the pinned terrain release.
await mkdir(destination)
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.name === 'data') continue
  await cp(join(source, entry.name), join(destination, entry.name), { recursive: true, errorOnExist: true, force: false })
}
await mkdir(join(outputData, 'planner'), { recursive: true })
for (const site of sites) {
  await mkdir(join(outputData, site))
  await Promise.all(localFiles.map(file => copyFile(join(inputData, site, file), join(outputData, site, file))))
}
await Promise.all([...referenced].map(digest =>
  copyFile(join(inputData, 'planner', digest + '.bin'), join(outputData, 'planner', digest + '.bin')),
))
console.log(`Staged ${sites.length} site bundles and ${referenced.size} pinned binaries in ${destination}`)
