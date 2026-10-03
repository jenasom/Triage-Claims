import { MOTOR } from '../data/motorConfig'

/**
 * API shape → view shape.
 *
 * The API returns signal and document ids; the UI shows labels. Kept
 * here rather than in components so a component never has to know
 * that `missing_ownership` means "Ownership documents absent".
 */

const SIGNAL_LABEL = Object.fromEntries(MOTOR.fraudSignals.map((s) => [s.id, s.label]))
const DOC_LABEL = Object.fromEntries(MOTOR.requiredDocuments.map((d) => [d.id, d.label]))

const label = (map, id) =>
  map[id] ?? id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** Relative submission time, e.g. "08:42 today". */
function when(iso) {
  const d = new Date(iso)
  const now = new Date()
  const hhmm = d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: false })
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${hhmm} today`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `${hhmm} yesterday`
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

/**
 * A claim as the table renders it.
 *
 * Signals arrive as ids with no severity, so severity is derived: a
 * claim that triggered signals has concerns to show; one that
 * triggered none gets the reassuring facts instead. This keeps the
 * detail panel populated either way.
 */
export function presentClaim(c) {
  const signals = c.signals.length
    ? c.signals.map((id) => ({ level: 'up', text: label(SIGNAL_LABEL, id) }))
    : [
        { level: 'ok', text: 'No fraud signals triggered' },
        { level: 'ok', text: `Documentation ${c.scores.documentation}% complete` },
      ]

  if (c.missingDocuments.length === 0) {
    signals.push({ level: 'ok', text: 'All required documents supplied' })
  }
  if (c.overridden) {
    signals.unshift({
      level: 'ok',
      text: `Route overridden by ${c.overridden.by}`,
    })
  }

  return {
    id: c.id,
    submittedAt: when(c.submittedAt),
    claimant: c.claimant,
    vehicle: c.vehicle,
    amount: c.amount,
    scores: c.scores,
    route: c.route,
    routeRule: c.routeRule,
    reasoning: c.reasoning,
    confidence: c.confidence,
    scoredBy: c.scoredBy,
    overridden: c.overridden,
    signals,
    documents: [
      ...c.documents.map((id) => ({ present: true, label: label(DOC_LABEL, id) })),
      ...c.missingDocuments.map((id) => ({ present: false, label: label(DOC_LABEL, id) })),
    ],
  }
}
