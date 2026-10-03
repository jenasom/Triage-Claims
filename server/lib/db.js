import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * SQLite persistence.
 *
 * Two tables. `claims` holds the claim plus its scores and route.
 * `audit` records every decision and every human override, append-only
 * — an automated settlement decision has to be reconstructable after
 * the fact: which inputs, which scores, which rule, what time, who.
 */

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? join(here, '..', 'data', 'claims.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS claims (
    id                  TEXT PRIMARY KEY,
    claimant            TEXT NOT NULL,
    vehicle_make        TEXT NOT NULL,
    vehicle_model       TEXT NOT NULL,
    vehicle_year        INTEGER NOT NULL,
    plate               TEXT NOT NULL,
    insured_value       INTEGER NOT NULL,
    amount              INTEGER NOT NULL,
    incident_type       TEXT NOT NULL,
    submitted_at        TEXT NOT NULL,

    complexity          INTEGER NOT NULL,
    documentation       INTEGER NOT NULL,
    fraud               INTEGER NOT NULL,

    route               TEXT NOT NULL,
    route_rule          TEXT NOT NULL,
    reasoning           TEXT NOT NULL,
    confidence          TEXT NOT NULL,
    scored_by           TEXT NOT NULL,

    signals             TEXT NOT NULL,   -- JSON array of signal ids
    documents           TEXT NOT NULL,   -- JSON array of supplied doc ids
    missing_documents   TEXT NOT NULL,   -- JSON array of outstanding doc ids
    facts               TEXT NOT NULL,   -- JSON, the inputs scoring saw

    overridden_route    TEXT,
    overridden_by       TEXT,
    overridden_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_claims_route ON claims(route);
  CREATE INDEX IF NOT EXISTS idx_claims_submitted ON claims(submitted_at DESC);

  CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    at       TEXT NOT NULL,
    action   TEXT NOT NULL,
    actor    TEXT NOT NULL,
    detail   TEXT NOT NULL,
    FOREIGN KEY (claim_id) REFERENCES claims(id)
  );

  CREATE INDEX IF NOT EXISTS idx_audit_claim ON audit(claim_id, at DESC);
`)

/**
 * Withdrawal and field-edit support, added after the original schema.
 *
 * Applied separately so an existing database picks them up without a
 * migration step. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each is
 * attempted and the duplicate-column error swallowed.
 *
 * Nothing here destroys data: withdrawing sets a flag, and an edit
 * writes the previous value into the audit trail before overwriting.
 * An automated settlement decision has to stay reconstructable, and a
 * deleted row cannot be explained to a regulator.
 */
for (const column of [
  'withdrawn_at TEXT',
  'withdrawn_by TEXT',
  'withdrawn_reason TEXT',
  'edited_at TEXT',
  'edited_by TEXT',
  // A claim lodged before it was complete. Held unscored: `route` and
  // the score columns carry placeholders until the outstanding items
  // arrive and finaliseClaim() scores it for real.
  'provisional INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(`ALTER TABLE claims ADD COLUMN ${column}`)
  } catch {
    /* already present */
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_claims_withdrawn ON claims(withdrawn_at);
`)

const insertClaim = db.prepare(`
  INSERT OR REPLACE INTO claims (
    id, claimant, vehicle_make, vehicle_model, vehicle_year, plate,
    insured_value, amount, incident_type, submitted_at,
    complexity, documentation, fraud,
    route, route_rule, reasoning, confidence, scored_by,
    signals, documents, missing_documents, facts, provisional
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`)

const insertAudit = db.prepare(
  `INSERT INTO audit (claim_id, at, action, actor, detail) VALUES (?, ?, ?, ?, ?)`,
)

/**
 * Persist a claim and record what happened in the audit trail.
 *
 * `provisional` marks a claim lodged before it was complete. It is
 * stored with placeholder scores and held out of the triage queues
 * until finaliseClaim() scores it — a fraud score derived from
 * documents nobody has seen yet would be meaningless, and worse,
 * would read as an assessment of the claimant.
 */
export function saveClaim(claim, assessment, decision, { provisional = false } = {}) {
  const facts = { ...claim }
  delete facts.scores

  insertClaim.run(
    claim.id,
    claim.claimant,
    claim.vehicleMake,
    claim.vehicleModel,
    claim.vehicleYear,
    claim.plate,
    claim.insuredValue,
    claim.amount,
    claim.incidentType,
    claim.submittedAt,
    claim.scores.complexity,
    claim.scores.documentation,
    assessment.score,
    decision.route,
    decision.rule,
    assessment.reasoning,
    assessment.confidence,
    assessment.scoredBy,
    JSON.stringify(assessment.signals),
    JSON.stringify(claim.documents),
    JSON.stringify(claim.missingDocuments),
    JSON.stringify(facts),
    provisional ? 1 : 0,
  )

  if (provisional) {
    recordAudit(claim.id, 'lodged_provisionally', 'intake', {
      outstanding: claim.missingDocuments,
    })
    return
  }

  recordAudit(claim.id, 'triaged', assessment.scoredBy, {
    route: decision.route,
    rule: decision.rule,
    scores: { ...claim.scores, fraud: assessment.score },
    confidence: assessment.confidence,
  })
}

export function recordAudit(claimId, action, actor, detail) {
  insertAudit.run(claimId, new Date().toISOString(), action, actor, JSON.stringify(detail))
}

/** Row → API shape. The frontend consumes exactly this. */
function toApi(r) {
  const effectiveRoute = r.overridden_route ?? r.route
  const provisional = r.provisional === 1
  return {
    id: r.id,
    /**
     * Lodged but not yet assessed. The score and route columns hold
     * placeholders for these — surfaced as nulls below so no caller
     * mistakes an unscored claim for a low-risk one.
     */
    provisional,
    claimant: r.claimant,
    vehicle: `${r.vehicle_make} ${r.vehicle_model} ${r.vehicle_year} · ${r.plate}`,
    amount: r.amount,
    insuredValue: r.insured_value,
    incidentType: r.incident_type,
    submittedAt: r.submitted_at,
    scores: {
      complexity: r.complexity,
      documentation: r.documentation,
      // A provisional claim has not been scored for fraud at all.
      // Reporting 0 would read as "cleared"; null reads as "not yet".
      fraud: provisional ? null : r.fraud,
    },
    route: provisional ? null : effectiveRoute,
    routeRule: provisional ? null : r.route_rule,
    reasoning: provisional ? null : r.reasoning,
    confidence: provisional ? null : r.confidence,
    scoredBy: provisional ? null : r.scored_by,
    signals: provisional ? [] : JSON.parse(r.signals),
    documents: JSON.parse(r.documents),
    missingDocuments: JSON.parse(r.missing_documents),
    overridden: r.overridden_route
      ? { from: r.route, to: r.overridden_route, by: r.overridden_by, at: r.overridden_at }
      : null,
    withdrawn: r.withdrawn_at
      ? { at: r.withdrawn_at, by: r.withdrawn_by, reason: r.withdrawn_reason }
      : null,
    edited: r.edited_at ? { at: r.edited_at, by: r.edited_by } : null,
  }
}

export function listClaims({ route, limit = 50, offset = 0 } = {}) {
  // Withdrawn claims stay in the database but leave the queue.
  const clauses = ['withdrawn_at IS NULL']
  const filterArgs = []

  if (route === 'awaiting') {
    // Cuts across the three routes rather than being a fourth one:
    // these are the claims blocked on the customer. Provisional claims
    // belong here too — they are the purest case of it.
    clauses.push("(missing_documents != '[]' OR provisional = 1)")
  } else if (route === 'provisional') {
    clauses.push('provisional = 1')
  } else if (route && route !== 'all') {
    // A provisional claim has no route yet, so it cannot appear in one.
    clauses.push('provisional = 0')
    clauses.push('COALESCE(overridden_route, route) = ?')
    filterArgs.push(route)
  }

  const where = `WHERE ${clauses.join(' AND ')}`

  const rows = db
    .prepare(`SELECT * FROM claims ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`)
    .all(...filterArgs, limit, offset)

  const total = db.prepare(`SELECT COUNT(*) AS n FROM claims ${where}`).get(...filterArgs)

  return { claims: rows.map(toApi), total: total.n }
}

export function getClaim(id) {
  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id)
  return row ? toApi(row) : null
}

export function getAudit(claimId) {
  return db
    .prepare('SELECT at, action, actor, detail FROM audit WHERE claim_id = ? ORDER BY at ASC, id ASC')
    .all(claimId)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }))
}

/** Apply a human override and record who did it. */
export function overrideRoute(claimId, newRoute, actor, note) {
  const existing = db.prepare('SELECT route FROM claims WHERE id = ?').get(claimId)
  if (!existing) return null

  const at = new Date().toISOString()
  db.prepare(
    'UPDATE claims SET overridden_route = ?, overridden_by = ?, overridden_at = ? WHERE id = ?',
  ).run(newRoute, actor, at, claimId)

  recordAudit(claimId, 'route_overridden', actor, { from: existing.route, to: newRoute, note })
  return getClaim(claimId)
}

/** Queue counts and the figures the stat band shows. */
export function stats() {
  // Provisional claims are excluded: they carry a placeholder route and
  // counting them would inflate whichever queue the placeholder names.
  const byRoute = db
    .prepare('SELECT COALESCE(overridden_route, route) AS route, COUNT(*) AS n FROM claims WHERE withdrawn_at IS NULL AND provisional = 0 GROUP BY 1')
    .all()

  const counts = { fast: 0, std: 0, inv: 0 }
  for (const r of byRoute) counts[r.route] = r.n
  const triaged = counts.fast + counts.std + counts.inv

  const overrides = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE overridden_route IS NOT NULL AND withdrawn_at IS NULL').get()

  const provisional = db
    .prepare('SELECT COUNT(*) AS n FROM claims WHERE withdrawn_at IS NULL AND provisional = 1')
    .get()

  /**
   * Claims blocked on the customer rather than on us.
   *
   * Not a fourth queue — a claim can be in standard review *and*
   * missing a document — but it is the distinction a claims officer
   * most needs to see. These are the claims that generate the "any
   * update?" calls, and the only ones where chasing the customer is
   * the useful action.
   */
  const awaiting = db
    .prepare(
      `SELECT COUNT(*) AS n FROM claims
       WHERE withdrawn_at IS NULL AND (missing_documents != '[]' OR provisional = 1)`,
    )
    .get()

  return {
    triaged,
    fastTrack: counts.fast,
    standard: counts.std,
    investigation: counts.inv,
    awaitingClaimant: awaiting.n,
    provisional: provisional.n,
    overrides: overrides.n,
    fastTrackPct: triaged ? Math.round((counts.fast / triaged) * 100) : 0,
    investigationPct: triaged ? Number(((counts.inv / triaged) * 100).toFixed(1)) : 0,
    awaitingPct: triaged ? Math.round((awaiting.n / triaged) * 100) : 0,
  }
}

export function claimCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM claims').get().n
}

/* -----------------------------------------------------------------
   Supervisor operations, used by the dashboard agent.

   Every one is append-only: an edit records the previous value before
   overwriting, and a withdrawal sets a flag rather than deleting a row.
   The audit trail is the point of the system — a claim that vanishes
   cannot be explained, so nothing here removes one.
   ----------------------------------------------------------------- */

/** Fields a supervisor may correct, and how each is stored. */
export const EDITABLE_FIELDS = {
  amount: { column: 'amount', type: 'number', label: 'claim amount' },
  insuredValue: { column: 'insured_value', type: 'number', label: 'insured value' },
  claimant: { column: 'claimant', type: 'string', label: 'claimant name' },
  plate: { column: 'plate', type: 'string', label: 'registration' },
  incidentType: { column: 'incident_type', type: 'string', label: 'incident type' },
}

/**
 * Search the book.
 *
 * Filters are all optional and combine with AND. Withdrawn claims are
 * excluded unless asked for, so a supervisor's counts match what the
 * queue shows.
 */
export function searchClaims(f = {}) {
  const where = []
  const args = []

  if (!f.includeWithdrawn) where.push('withdrawn_at IS NULL')

  if (f.route && f.route !== 'all') {
    where.push('COALESCE(overridden_route, route) = ?')
    args.push(f.route)
  }
  if (f.minAmount != null) { where.push('amount >= ?'); args.push(f.minAmount) }
  if (f.maxAmount != null) { where.push('amount <= ?'); args.push(f.maxAmount) }
  if (f.minFraud != null) { where.push('fraud >= ?'); args.push(f.minFraud) }
  if (f.maxFraud != null) { where.push('fraud <= ?'); args.push(f.maxFraud) }
  if (f.claimant) { where.push('claimant LIKE ?'); args.push(`%${f.claimant}%`) }
  if (f.garage) { where.push("json_extract(facts, '$.garage') LIKE ?"); args.push(`%${f.garage}%`) }
  if (f.signal) { where.push('signals LIKE ?'); args.push(`%"${f.signal}"%`) }
  if (f.overriddenOnly) where.push('overridden_route IS NOT NULL')

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(f.limit ?? 20, 100)

  const rows = db
    .prepare(`SELECT * FROM claims ${clause} ORDER BY fraud DESC, amount DESC LIMIT ?`)
    .all(...args, limit)

  const total = db.prepare(`SELECT COUNT(*) AS n FROM claims ${clause}`).get(...args).n

  return { claims: rows.map(toApi), total, returned: rows.length }
}

/** Aggregate counts, for "how many..." questions. */
export function aggregate({ groupBy = 'route', includeWithdrawn = false } = {}) {
  const expr = {
    route: 'COALESCE(overridden_route, route)',
    garage: "json_extract(facts, '$.garage')",
    incidentType: 'incident_type',
    confidence: 'confidence',
    scoredBy: 'scored_by',
  }[groupBy]

  if (!expr) throw new Error(`Cannot group by ${groupBy}`)

  const clause = includeWithdrawn ? '' : 'WHERE withdrawn_at IS NULL'
  return db
    .prepare(
      `SELECT ${expr} AS key, COUNT(*) AS count,
              ROUND(AVG(amount)) AS avgAmount, ROUND(AVG(fraud)) AS avgFraud
       FROM claims ${clause} GROUP BY 1 ORDER BY count DESC LIMIT 25`,
    )
    .all()
}

/**
 * Correct a field.
 *
 * The previous value goes into the audit trail before the new one is
 * written, so the change is reconstructable. Returns the claim, or null
 * if it does not exist.
 */
export function editClaim(id, field, value, actor, note = '') {
  const spec = EDITABLE_FIELDS[field]
  if (!spec) throw new Error(`${field} is not editable`)

  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id)
  if (!row) return null

  const previous = row[spec.column]
  const next = spec.type === 'number' ? Number(value) : String(value)
  if (spec.type === 'number' && !Number.isFinite(next)) {
    throw new Error(`${spec.label} must be a number`)
  }

  const at = new Date().toISOString()
  db.prepare(
    `UPDATE claims SET ${spec.column} = ?, edited_at = ?, edited_by = ? WHERE id = ?`,
  ).run(next, at, actor, id)

  recordAudit(id, 'field_edited', actor, { field, label: spec.label, from: previous, to: next, note })
  return getClaim(id)
}

/** Take a claim out of the queue. Reversible; the row is untouched. */
export function withdrawClaim(id, actor, reason) {
  const row = db.prepare('SELECT withdrawn_at FROM claims WHERE id = ?').get(id)
  if (!row) return null
  if (row.withdrawn_at) return { alreadyWithdrawn: true, claim: getClaim(id) }

  const at = new Date().toISOString()
  db.prepare(
    'UPDATE claims SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ?',
  ).run(at, actor, reason, id)

  recordAudit(id, 'withdrawn', actor, { reason })
  return { alreadyWithdrawn: false, claim: getClaim(id) }
}

/**
 * The stored facts a provisional claim was lodged with.
 *
 * Returned so the caller can re-score it with the newly supplied
 * documents folded in, without this module needing to know anything
 * about scoring.
 */
export function provisionalFacts(id) {
  const row = db
    .prepare('SELECT facts, documents, missing_documents, provisional FROM claims WHERE id = ?')
    .get(id)
  if (!row || row.provisional !== 1) return null

  return {
    facts: JSON.parse(row.facts),
    documents: JSON.parse(row.documents),
    missingDocuments: JSON.parse(row.missing_documents),
  }
}

/**
 * Add a supplied document to a provisional claim.
 *
 * Only provisional claims: on a triaged claim a late document is
 * recorded in the audit trail but does not alter the record, so that a
 * claimant cannot move their own claim between queues by uploading.
 *
 * Returns the remaining outstanding document ids, or null if the claim
 * is not provisional.
 */
export function applyProvisionalDocument(id, documentType) {
  const row = db
    .prepare('SELECT documents, missing_documents, provisional FROM claims WHERE id = ?')
    .get(id)
  if (!row || row.provisional !== 1) return null

  const documents = JSON.parse(row.documents)
  const remaining = JSON.parse(row.missing_documents).filter((d) => d !== documentType)
  if (!documents.includes(documentType)) documents.push(documentType)

  db.prepare('UPDATE claims SET documents = ?, missing_documents = ? WHERE id = ?').run(
    JSON.stringify(documents),
    JSON.stringify(remaining),
    id,
  )

  return { documents, remaining }
}

/**
 * Score a provisional claim and release it into the queues.
 *
 * This is the other half of a provisional lodgement: the claim was
 * held deliberately unscored, and this is the single point where it
 * becomes a real triaged claim. The audit trail records it as its own
 * action rather than a plain `triaged`, so the two-stage history stays
 * legible — a claim that was lodged incomplete and finished later is a
 * different story from one submitted complete.
 */
export function finaliseClaim(id, claim, assessment, decision, actor = 'system') {
  const row = db.prepare('SELECT provisional FROM claims WHERE id = ?').get(id)
  if (!row) return null
  if (row.provisional !== 1) return { alreadyFinal: true, claim: getClaim(id) }

  db.prepare(
    `UPDATE claims SET
       provisional = 0,
       complexity = ?, documentation = ?, fraud = ?,
       route = ?, route_rule = ?, reasoning = ?, confidence = ?, scored_by = ?,
       signals = ?, documents = ?, missing_documents = ?, facts = ?
     WHERE id = ?`,
  ).run(
    claim.scores.complexity,
    claim.scores.documentation,
    assessment.score,
    decision.route,
    decision.rule,
    assessment.reasoning,
    assessment.confidence,
    assessment.scoredBy,
    JSON.stringify(assessment.signals),
    JSON.stringify(claim.documents),
    JSON.stringify(claim.missingDocuments),
    JSON.stringify((({ scores: _scores, ...rest }) => rest)(claim)),
    id,
  )

  recordAudit(id, 'completed', actor, {
    route: decision.route,
    rule: decision.rule,
    scores: { ...claim.scores, fraud: assessment.score },
    confidence: assessment.confidence,
  })

  return { alreadyFinal: false, claim: getClaim(id) }
}

/** Put a withdrawn claim back. */
export function restoreClaim(id, actor, note = '') {
  const row = db.prepare('SELECT withdrawn_at, withdrawn_reason FROM claims WHERE id = ?').get(id)
  if (!row) return null
  if (!row.withdrawn_at) return { wasActive: true, claim: getClaim(id) }

  db.prepare(
    'UPDATE claims SET withdrawn_at = NULL, withdrawn_by = NULL, withdrawn_reason = NULL WHERE id = ?',
  ).run(id)

  recordAudit(id, 'restored', actor, { previousReason: row.withdrawn_reason, note })
  return { wasActive: false, claim: getClaim(id) }
}
