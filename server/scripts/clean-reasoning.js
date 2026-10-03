import 'dotenv/config'
import { db } from '../lib/db.js'
import { plainLanguage } from '../lib/providers/prompt.js'

/**
 * Rewrite stored reasoning through the plain-language filter.
 *
 * Free and instant — no re-scoring, only the text a supervisor reads.
 * Run after changing the filter, or to clean a book seeded before it
 * existed.
 *
 *   npm run clean:reasoning
 */

const rows = db.prepare('SELECT id, reasoning FROM claims').all()
const update = db.prepare('UPDATE claims SET reasoning = ? WHERE id = ?')

let changed = 0
for (const r of rows) {
  const cleaned = plainLanguage(r.reasoning)
  if (cleaned !== r.reasoning) {
    update.run(cleaned, r.id)
    changed++
  }
}

console.log(`\nChecked ${rows.length} claims — rewrote ${changed}\n`)

if (changed) {
  const sample = db
    .prepare('SELECT id, reasoning FROM claims WHERE id = ?')
    .get(rows.find((r) => plainLanguage(r.reasoning) !== r.reasoning)?.id)
  if (sample) {
    console.log(`  ${sample.id}`)
    console.log(`  ${sample.reasoning.slice(0, 160)}…\n`)
  }
}

process.exit(0)
