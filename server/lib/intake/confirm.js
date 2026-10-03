import { MOTOR } from '../config.js'
import { DOCUMENT_FIELDS } from './extract.js'

/**
 * Decide whether an uploaded document is actually the one asked for.
 *
 * Reading a document is not the same as accepting it. A claimant can
 * photograph the right thing badly, the wrong thing clearly, or the
 * right thing for a different vehicle — and all three come back from
 * extraction as "readable". Accepting any of them means an assessor
 * discovers the problem days later, which is exactly the round-trip
 * this product exists to remove.
 *
 * Four questions, in the order that matters:
 *
 *   1. Could it be read at all?
 *   2. Is it the type of document we asked for?
 *   3. Does it carry the fields that make it useful?
 *   4. Does it agree with what the claimant already told us?
 *
 * Returns a verdict the agent can act on and a sentence a claimant can
 * act on. The verdict is never "probably" — a document is accepted,
 * queried, or rejected.
 */

/** Words that suggest the model read a different kind of document. */
function looksLikeType(reported, expectedId) {
  if (!reported) return true // nothing claimed, fall through to field checks

  const said = reported.toLowerCase()
  const expected = {
    police_report: ['police', 'accident report', 'incident report'],
    damage_photos: ['photo', 'image', 'damage', 'vehicle'],
    drivers_licence: ['licence', 'license', 'permit', 'driver'],
    vehicle_papers: ['registration', 'particulars', 'vehicle', 'ownership', 'licence'],
    repair_estimate: ['estimate', 'quotation', 'quote', 'invoice', 'repair'],
  }[expectedId]

  return expected?.some((word) => said.includes(word)) ?? true
}

/** Normalise a plate for comparison: LSD-441-KJ and lsd441kj match. */
const normPlate = (p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The fields that make each document worth having.
 *
 * A police report without a reference number is a photograph of a form.
 * These are the ones whose absence means the document cannot do its job
 * — not everything we would like, only what is load-bearing.
 */
const ESSENTIAL = {
  police_report: ['date', 'reference_number'],
  damage_photos: ['visible_damage'],
  drivers_licence: ['name', 'licence_number'],
  vehicle_papers: ['plate'],
  repair_estimate: ['amount'],
}

export function confirmDocument(documentType, extracted, claim = {}) {
  const doc = MOTOR.requiredDocuments.find((d) => d.id === documentType)
  const label = (doc?.label ?? documentType.replace(/_/g, ' ')).toLowerCase()

  // 1. Readable at all?
  if (!extracted || extracted.readable === false) {
    return {
      verdict: 'rejected',
      reason: 'unreadable',
      summary: `The ${label} could not be read${extracted?.reason ? ` — ${extracted.reason}` : ''}.`,
      ask: `Ask them to take another photo with the whole document in frame and good light.`,
    }
  }

  const fields = extracted.fields ?? {}

  // 2. The right kind of document?
  if (!looksLikeType(extracted.documentType, documentType)) {
    return {
      verdict: 'rejected',
      reason: 'wrong_type',
      summary: `That looks like ${extracted.documentType}, not a ${label}.`,
      ask: `Tell them what arrived and ask for the ${label} instead.`,
    }
  }

  // 3. Does it carry what makes it useful?
  const essential = ESSENTIAL[documentType] ?? []
  const missing = essential.filter((f) => !(f in fields))

  if (missing.length > 0) {
    const readable = missing.map((f) => f.replace(/_/g, ' ')).join(' and ')
    const verb = missing.length === 1 ? 'is' : 'are'
    return {
      verdict: 'rejected',
      reason: 'incomplete',
      summary: `The ${label} was readable but the ${readable} ${verb} not visible.`,
      ask: `Ask them to send a photo that shows the whole document, including the ${readable}.`,
    }
  }

  // 4. Does it agree with what they told us?
  const onDoc = fields.plate
  if (onDoc && claim.plate && normPlate(onDoc) !== normPlate(claim.plate)) {
    return {
      verdict: 'queried',
      reason: 'plate_mismatch',
      summary: `The ${label} shows registration ${onDoc}, but they gave ${claim.plate}.`,
      ask: `Read both back to them and ask which vehicle the claim is for. Do not proceed until they say.`,
    }
  }

  const amountOnDoc = fields.amount
  if (amountOnDoc && claim.amount) {
    const onDocNum = Number(String(amountOnDoc).replace(/[^\d.]/g, ''))
    const claimed = Number(claim.amount)
    if (Number.isFinite(onDocNum) && onDocNum > 0 && Number.isFinite(claimed)) {
      const drift = Math.abs(onDocNum - claimed) / Math.max(onDocNum, claimed)
      if (drift > 0.05) {
        return {
          verdict: 'queried',
          reason: 'amount_mismatch',
          summary: `The ${label} shows ₦${onDocNum.toLocaleString('en-NG')}, but they said ₦${claimed.toLocaleString('en-NG')}.`,
          ask: `Read both figures back and ask which one is right.`,
        }
      }
    }
  }

  // Accepted. Give the agent something concrete to say back, so the
  // claimant hears that the document was actually looked at rather
  // than merely received.
  const confirmable = (DOCUMENT_FIELDS[documentType] ?? [])
    .filter((f) => f in fields)
    .slice(0, 3)
    .map((f) => `${f.replace(/_/g, ' ')} ${fields[f]}`)

  return {
    verdict: 'accepted',
    reason: null,
    summary: confirmable.length
      ? `The ${label} was read and checked: ${confirmable.join(', ')}.`
      : `The ${label} was read and checked.`,
    ask: null,
    confirmed: confirmable,
  }
}
