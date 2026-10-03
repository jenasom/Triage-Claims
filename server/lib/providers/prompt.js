import { MOTOR } from '../config.js'

/**
 * The scoring prompt and its output contract, shared by every provider.
 *
 * Kept here so Claude and DeepSeek are given exactly the same
 * instructions and judged on the same terms — if their scores differ,
 * that is the models differing, not the prompts.
 */

export const SIGNAL_IDS = MOTOR.fraudSignals.map((s) => s.id)

export const SYSTEM = `You are a fraud analyst for a Nigerian motor insurance claims team. You assess claims at intake and produce a risk score with the reasoning behind it.

The signals you may cite, and their relative weight in this book of business:
${MOTOR.fraudSignals.map((s) => `- ${s.id}: ${s.label} (weight ${s.weight})`).join('\n')}

Scoring bands. These are calibrated to the routing thresholds below — a score of 54 and a score of 56 send the claim to different queues, so place the score deliberately rather than reaching for a round number:

- **0-19** — nothing of concern. Clean policy history, proportionate estimate, consistent paperwork.
- **20-39** — one mild irregularity, or several facts that are individually unremarkable. Normal review.
- **40-54** — real concerns, but each has an ordinary explanation and they do not corroborate each other.
- **55-100** — enough corroborating signals that a specialist should look before assessment work begins.

The 55 boundary is the one that matters. Three or more signals that point the same way — a policy days old, an estimate near the insured value, and a garage that recurs across flagged claims — belong at 55 or above even when no single one is damning. Corroboration is the point: two unrelated oddities are not the same as three that tell one story.

## Where the claim will go

Your score is one of three inputs to a routing rule you do not control. The rule, so your reasoning matches the outcome the supervisor sees:

- **Investigation** — any claim scoring ${MOTOR.routing.investigationFraudScore} or above, whatever else is true.
- **Fast-track** — under ₦${MOTOR.routing.fastTrackCeiling.toLocaleString('en-NG')}, every document present, fraud below ${MOTOR.routing.fastTrackMaxFraud}, and low complexity. All four, or it does not qualify.
- **Standard review** — everything else.

Do NOT state which route the claim will take — you are not given the complexity score, so you cannot compute it. Describe what the evidence shows. If the claim is clean but the amount is above the fast-track ceiling or a document is outstanding, note that plainly ("the amount alone puts this above the fast-track ceiling") without naming the destination queue.

Rules you must follow:

1. Score ONLY on the claim facts supplied. You must NOT consider, infer from, or mention: ${MOTOR.prohibitedFactors.join(', ')}. Nigerian names carry ethnic and religious information — ignore it entirely. A claim from Adaeze Okonkwo and an identical claim from Yusuf Ibrahim must receive the same score.

2. Cite concrete figures. "Policy was 11 days old at the time of loss" is useful; "the policy is new" is not.

3. Missing documentation is not by itself fraud. A claimant who has not uploaded a police report yet is incomplete, not suspicious. Say so.

4. Do not invent facts. If something looks odd but you cannot tell from what was supplied, say what additional information would settle it.

5. Write for a supervisor who will act on this in under thirty seconds. Plain English, no hedging, no preamble.

## Writing the reasoning

You are writing for a claims supervisor deciding what to do with this claim, not producing a log entry. Structure it as three moves:

**What stands out.** Lead with the single most consequential fact, in plain language. "The policy was eleven days old when the accident happened" — not "new_policy triggered".

**Why that matters here.** Connect it to the claim. A new policy is not itself suspicious; a new policy plus an estimate at 71% of insured value plus a garage that appears on four other flagged claims is a pattern. Say what the combination means.

**What a reviewer should do.** Close with the practical consequence: what to check, what to request, or that nothing needs checking.

**Never write a signal id or a weight in the reasoning.** The ids exist so the system can group claims; they mean nothing to a supervisor. Every one has a plain-English form — use it:

${MOTOR.fraudSignals.map((s) => `- not "${s.id}" → "${s.label.toLowerCase()}"`).join('\n')}

The reasoning must read as though written by a person who has never seen the code. If an underscore appears in it, you have made a mistake.

When nothing is wrong, say so with the evidence and stop — three clean sentences, not a padded list. "Four-year-old policy, no prior claims, the estimate is 2% of insured value, and every document is present and consistent. Nothing here needs a second look."

**Never conclude that a claim is fraudulent.** Not "this is fraudulent", not "a coordinated scheme", not "clearly staged". You have read a summary of a claim; you have not investigated it, spoken to anyone, or seen the vehicle. A fraud unit reaches that conclusion, and a written accusation that turns out to be wrong is a problem for the insurer and for the claimant.

Describe the evidence and what it warrants:

- Right: "These facts corroborate each other and warrant specialist review before assessment."
- Right: "The combination of a new policy and an estimate at the full insured value is worth checking before anything is paid."
- Wrong: "This is a fraudulent claim."
- Wrong: "These signals point to a coordinated fraudulent scheme."

The strongest thing you may write is that the evidence warrants investigation.`

/**
 * JSON Schema for the assessment. Claude uses this via its structured
 * output helper; DeepSeek gets it rendered into the prompt, since JSON
 * mode guarantees valid JSON but not a particular shape.
 */
export const SCHEMA = {
  type: 'object',
  properties: {
    score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Fraud risk from 0 (no concern) to 100 (near-certain fraud)',
    },
    reasoning: {
      type: 'string',
      description:
        'Three to five sentences: what stands out, why it matters for this claim, and what a reviewer should do. Plain language — never signal ids or weights. Cite concrete figures.',
    },
    triggered_signals: {
      type: 'array',
      items: { type: 'string', enum: SIGNAL_IDS },
      description: 'Signal ids that actually fired. Empty if none did.',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Confidence in this assessment given the information supplied',
    },
  },
  required: ['score', 'reasoning', 'triggered_signals', 'confidence'],
  additionalProperties: false,
}

/** Appended for providers whose JSON mode does not enforce a shape. */
export const FORMAT_INSTRUCTION = `Respond with a single JSON object and nothing else:

{
  "score": <integer 0-100>,
  "reasoning": "<3-5 sentences: what stands out, why it matters here, what the reviewer should do. Plain language, concrete figures, no signal ids or weights.>",
  "triggered_signals": [<zero or more of: ${SIGNAL_IDS.map((s) => `"${s}"`).join(', ')}>],
  "confidence": "low" | "medium" | "high"
}`

/** One claim rendered as the facts a scorer is allowed to see. */
export function claimFacts(c) {
  const lines = [
    `Claim amount: ₦${c.amount.toLocaleString('en-NG')}`,
    `Vehicle: ${c.vehicleMake} ${c.vehicleModel} ${c.vehicleYear}`,
    `Insured value: ₦${c.insuredValue.toLocaleString('en-NG')}`,
    `Estimate as share of insured value: ${Math.round((c.amount / c.insuredValue) * 100)}%`,
    `Policy age at loss: ${c.policyAgeDays} days`,
    `Prior claims on this policy: ${c.priorClaims}`,
    `Prior claims in the last 12 months: ${c.priorClaims12m}`,
    `Incident type: ${c.incidentType}`,
    `Incident reported at: ${c.incidentHour}:00`,
    `Days between incident and report: ${c.reportDelayDays}`,
    `Documents supplied: ${c.documents.length ? c.documents.join(', ') : 'none'}`,
    `Documents outstanding: ${c.missingDocuments.length ? c.missingDocuments.join(', ') : 'none'}`,
    `Repair garage: ${c.garage}`,
    `Claims involving this garage flagged this quarter: ${c.garageFlaggedCount}`,
    `Loss location matches policy address: ${c.addressMatches ? 'yes' : 'no'}`,
    `Third party involved: ${c.thirdPartyInvolved ? 'yes' : 'no'}`,
    `Injury reported: ${c.injuryReported ? 'yes' : 'no'}`,
  ]
  if (c.documentDateInconsistent) {
    lines.push(
      'NOTE: document dates are internally inconsistent (a supplied document is dated before the stated incident date)',
    )
  }
  return lines.join('\n')
}

export const userMessage = (claim) => `Assess this motor claim.\n\n${claimFacts(claim)}`

/**
 * Validate and normalise whatever a provider returned.
 *
 * A model can return a valid-JSON object that is still wrong — a score
 * of 150, a signal id that does not exist, a missing field. Coercing
 * here means the rest of the system can trust the shape, and a
 * malformed response falls back to rules rather than corrupting a
 * routing decision.
 */
export function normaliseAssessment(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Assessment was not an object')
  }

  const score = Number(raw.score)
  if (!Number.isFinite(score)) throw new Error('Assessment score was not a number')

  const reasoning = plainLanguage(
    typeof raw.reasoning === 'string' ? raw.reasoning.trim() : '',
  )
  if (!reasoning) throw new Error('Assessment carried no reasoning')

  const signals = Array.isArray(raw.triggered_signals)
    ? raw.triggered_signals.filter((s) => SIGNAL_IDS.includes(s))
    : []

  const confidence = ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'medium'

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasoning,
    signals,
    confidence,
  }
}

/**
 * Strip internal vocabulary out of reasoning text.
 *
 * The prompt forbids signal ids, and mostly they stay out — but the id
 * list has to appear in the prompt for `triggered_signals`, and a model
 * given a word will occasionally use it. Around 7% of a 500-claim book
 * leaked one: low enough to look like an oversight, high enough that a
 * supervisor would hit it.
 *
 * Two rounds of prompting did not fix it; a substitution does. Ids
 * become the plain-language label a person would use, and any trailing
 * `(weight 14)` is dropped.
 */
const REPLACEMENTS = MOTOR.fraudSignals.map((s) => ({
  // `\b` is useless here — underscore is a word character, so
  // `\bnew_policy\b` never matches at the underscore. Anchor on what can
  // actually sit beside an id: string edges, whitespace, quotes, or
  // punctuation. The leading group is preserved via $1.
  pattern: new RegExp(
    '(^|[\\s(\\[`\'"])' + s.id + '(?=$|[\\s).,;:\\]`\'"])',
    'gi',
  ),
  label: s.label.toLowerCase(),
}))

export function plainLanguage(text) {
  if (!text) return text

  let out = text
  for (const { pattern, label } of REPLACEMENTS) {
    out = out.replace(pattern, (_m, lead) => `${lead}${label}`)
  }

  // Weight annotations. Two shapes occur: a whole parenthetical
  // "(weight 22)", and a trailing clause inside one the substitution
  // above already partly rewrote — "(policy age…, weight 22)".
  out = out
    .replace(/[,;]?\s*weight\s*\d+/gi, '')
    .replace(/\s*\(\s*\d+\s*\)/g, '')

  // Tidy what the substitutions may have left: empty parens, doubled
  // spaces, a space before punctuation.
  return out
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}
