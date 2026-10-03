import 'dotenv/config'
import { generateClaims } from '../lib/generate.js'
import { scoreClaim, hasCredentials, scoringMode, activePricing } from '../lib/score.js'
import { route as decideRoute } from '../lib/rules.js'
import { saveClaim, db, stats } from '../lib/db.js'

/**
 * Seed the queue.
 *
 * Scores every generated claim once and stores the result, so the demo
 * reads from cache and never stalls on a live call or costs money per
 * refresh. New claims submitted through the API are still scored live.
 *
 *   npm run seed                 500 claims, scored by Claude
 *   npm run seed:stub            deterministic scoring, no API calls
 *   node scripts/seed.js -n 100  a smaller book
 */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const COUNT = Number(flag('-n', flag('--count', '500')))
const CONCURRENCY = Number(flag('-c', flag('--concurrency', '8')))
const STUB = args.includes('--stub')
const FRESH = !args.includes('--append')

const useProvider = !STUB && hasCredentials()

console.log(`\nSeeding ${COUNT} motor claims`)
console.log(`  scoring:     ${useProvider ? scoringMode() : 'deterministic rules'}`)
console.log(`  concurrency: ${useProvider ? CONCURRENCY : 'n/a'}`)
if (!useProvider && !STUB) {
  console.log('\n  No provider key is set, so scoring falls back to rules.')
  console.log('  Set DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY) in server/.env.\n')
}

if (FRESH) {
  db.exec('DELETE FROM audit; DELETE FROM claims;')
  console.log('  cleared existing claims\n')
}

const claims = generateClaims({ count: COUNT })

let done = 0
let failed = 0
let tokensIn = 0
let tokensOut = 0
let cacheRead = 0
const started = Date.now()

function progress() {
  const pct = Math.round((done / claims.length) * 100)
  const bar = '█'.repeat(Math.round(pct / 2.5)).padEnd(40, '░')
  const rate = done / ((Date.now() - started) / 1000)
  const eta = rate > 0 ? Math.round((claims.length - done) / rate) : 0
  process.stdout.write(
    `\r  ${bar} ${String(pct).padStart(3)}%  ${done}/${claims.length}` +
      (useProvider ? `  ~${eta}s left` : '') +
      (failed ? `  ${failed} fell back` : ''),
  )
}

async function processOne(claim) {
  const assessment = await scoreClaim(claim, { preferStub: STUB })
  if (assessment.error) failed++
  if (assessment.usage) {
    tokensIn += assessment.usage.input
    tokensOut += assessment.usage.output
    cacheRead += assessment.usage.cacheRead
  }

  const decision = decideRoute({
    amount: claim.amount,
    complexity: claim.scores.complexity,
    documentation: claim.scores.documentation,
    fraud: assessment.score,
  })

  saveClaim(claim, assessment, decision)
  done++
  progress()
}

/** Fixed-size worker pool — keeps requests in flight without a burst. */
async function run() {
  const queue = [...claims]
  const workers = Array.from({ length: useProvider ? CONCURRENCY : 1 }, async () => {
    while (queue.length) {
      const claim = queue.shift()
      if (claim) await processOne(claim)
    }
  })
  await Promise.all(workers)
}

await run()

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const s = stats()

console.log(`\n\nDone in ${elapsed}s\n`)
console.log(`  Fast-Track      ${String(s.fastTrack).padStart(4)}   ${String(s.fastTrackPct).padStart(3)}%`)
console.log(`  Standard        ${String(s.standard).padStart(4)}`)
console.log(`  Investigation   ${String(s.investigation).padStart(4)}   ${s.investigationPct}%`)

if (failed) {
  console.log(`\n  ${failed} claim(s) fell back to rules after a scoring error.`)
}

if (tokensIn) {
  // Cache reads bill at a fraction of the input rate but are counted
  // here at full price, so this is an upper bound.
  const p = activePricing() ?? { input: 0, output: 0 }
  const cost = (tokensIn / 1e6) * p.input + (tokensOut / 1e6) * p.output
  console.log(`\n  Tokens: ${tokensIn.toLocaleString()} in (${cacheRead.toLocaleString()} cached), ${tokensOut.toLocaleString()} out`)
  console.log(`  Cost:   ~$${cost.toFixed(2)}`)
}

console.log('\n  Start the API with: npm run dev\n')
process.exit(0)
