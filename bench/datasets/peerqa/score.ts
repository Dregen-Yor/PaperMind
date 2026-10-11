import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { answerSha256, importPeerQaScores } from '../../src/metrics/peerqaQuality'
import { readBenchResult } from '../../src/scoring/qArtifacts'

const options = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i]
  const value = process.argv[i + 1]
  if (!['--result', '--scores', '--out'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) {
    throw new Error('Usage: npm run bench:peerqa:score -- --result result.json --scores scores.json --out scored.json')
  }
  options.set(flag, value)
}
if (!['--result', '--scores', '--out'].every(flag => options.has(flag))) throw new Error('--result, --scores and --out are required')
const [source, scores] = await Promise.all([
  readFile(options.get('--result')!, 'utf8'),
  readFile(options.get('--scores')!, 'utf8'),
])
const result = importPeerQaScores(readBenchResult(JSON.parse(source)), JSON.parse(scores), answerSha256(source))
const out = options.get('--out')!
await mkdir(dirname(out), { recursive: true })
// Create-only prevents overwriting either the source or a previously reviewed scored artifact.
await writeFile(out, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
process.stdout.write(`PeerQA model scores written: ${out}\n`)
