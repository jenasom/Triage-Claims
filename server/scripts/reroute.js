import 'dotenv/config'
import { db, recordAudit, stats } from '../lib/db.js'
import { route as decideRoute } from '../lib/rules.js'
import { MOTOR } from '../lib/config.js'

/**
 * Recompute routing for every stored claim.
 *
 * Run after changing a threshold in config.js. Scores are unchanged —
 * only the routing decision is re-derived, so this costs nothing and
 * takes a second.
 *
 * Every change is written to the audit trail as a `rerouted` entry, so
 * a claim that moves queues because a threshold moved is as traceable
 * as one a supervisor moved by hand.
 *
 *   npm run reroute
 */

const rows = db.prepare('SELECT id, amount, complexity, documentation, fraud, route, route_rule FROM claims').all()
const update = db.prepare('UPDATE claims SET route = ?, route_rule = ? WHERE id = ?')

let changed = 0
const moves = {}

for (const r of rows) {
  const d = decideRoute({
    amount: r.amount,
    complexity: r.complexity,
    documentation: r.documentation,
    fraud: r.fraud,
  })

  if (d.route === r.route && d.rule === r.route_rule) continue

  update.run(d.route, d.rule, r.id)

  if (d.route !== r.route) {
    changed++
    const key = `${r.route} → ${d.route}`
    moves[key] = (moves[key] ?? 0) + 1
    recordAudit(r.id, 'rerouted', 'threshold-change', {
      from: r.route,
      to: d.route,
      rule: d.rule,
      thresholds: MOTOR.routing,
    })
  }
}

const s = stats()

console.log(`\nRe-routed ${rows.length} claims — ${changed} changed queue\n`)
for (const [move, n] of Object.entries(moves)) {
  console.log(`  ${move.padEnd(14)} ${n}`)
}
console.log(`\n  Fast-Track      ${String(s.fastTrack).padStart(4)}   ${s.fastTrackPct}%`)
console.log(`  Standard        ${String(s.standard).padStart(4)}`)
console.log(`  Investigation   ${String(s.investigation).padStart(4)}   ${s.investigationPct}%\n`)

process.exit(0)
