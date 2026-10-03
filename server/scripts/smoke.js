import 'dotenv/config'
import { scoreClaim, scoringMode } from '../lib/score.js'
import { generateClaims } from '../lib/generate.js'

/**
 * Two live scoring calls — one clean claim, one fraud-shaped.
 *
 * Run before a full seed to confirm credentials, request format and
 * response parsing all work, without spending 500 calls to find out.
 *
 *   npm run smoke
 */

console.log('provider:', scoringMode(), '\n')

const claims = generateClaims({ count: 500 })
const clean = claims.find(
  (c) => c.amount < 300_000 && c.policyAgeDays > 800 && !c.documentDateInconsistent,
)
const risky = claims.find((c) => c.documentDateInconsistent && c.policyAgeDays < 30)

for (const [label, claim] of [
  ['CLEAN', clean],
  ['FRAUD-SHAPED', risky],
]) {
  if (!claim) {
    console.log(`${label}: no matching claim in sample`)
    continue
  }

  const t0 = Date.now()
  const a = await scoreClaim(claim)
  const ms = Date.now() - t0

  console.log(`── ${label}  (${claim.id})`)
  console.log(
    `   ₦${claim.amount.toLocaleString('en-NG')} · policy ${claim.policyAgeDays}d · ${claim.priorClaims12m} claims/12m · docs ${claim.scores.documentation}%`,
  )
  console.log(`   score ${a.score}  confidence ${a.confidence}  ${ms}ms  via ${a.scoredBy}`)
  if (a.error) console.log(`   ERROR: ${a.error}`)
  console.log(`   signals: ${a.signals.join(', ') || 'none'}`)
  console.log(`   ${a.reasoning}`)
  if (a.usage) {
    console.log(
      `   tokens: ${a.usage.input} in (${a.usage.cacheRead} cached), ${a.usage.output} out`,
    )
  }
  console.log()
}
