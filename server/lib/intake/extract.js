import OpenAI from 'openai'
import { MOTOR } from '../config.js'
import { isPdf, pdfToImage } from './pdf.js'

/**
 * Document extraction.
 *
 * Reads an uploaded document image and returns the fields it carries,
 * or says plainly that it could not be read. That second case matters
 * as much as the first: a claimant who photographed a police report in
 * poor light needs to be told to retake it, not to have blank fields
 * silently accepted.
 *
 * The model is asked to report only what it can actually see. Inventing
 * a plausible-looking reference number would be worse than returning
 * nothing, because a fabricated field passes validation and then feeds
 * a routing decision.
 */

const VISION_MODEL = process.env.DEEPSEEK_VISION_MODEL ?? 'deepseek-v4-flash-vision-exp'
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

/** Fields each document type should carry, used to prompt and to validate. */
export const DOCUMENT_FIELDS = {
  police_report: ['date', 'reference_number', 'station', 'plate', 'description'],
  damage_photos: ['visible_damage', 'plate'],
  drivers_licence: ['name', 'licence_number', 'expiry_date'],
  vehicle_papers: ['plate', 'owner_name', 'make', 'model', 'year'],
  repair_estimate: ['date', 'garage_name', 'amount', 'plate'],
}

const SYSTEM = `You read documents submitted with Nigerian motor insurance claims and report exactly what is on them.

Rules:

1. Report ONLY what you can actually see. If a field is not visible, illegible, or cut off, omit it — never guess. A fabricated reference number is worse than a missing one, because it passes validation and then feeds a claims decision.

2. If the image is too dark, too blurred, cropped, or otherwise unreadable, set readable to false and say briefly why in plain language a claimant can act on ("the photo is too dark to read the text", "the left half of the document is cut off").

3. Dates must be returned as YYYY-MM-DD. Nigerian documents commonly use DD/MM/YYYY — read them that way, not as US month-first.

4. Amounts are naira. Return digits only, no currency symbol or separators.

5. Registration plates: return exactly as printed, including hyphens.

6. Do not assess whether the claim is genuine, and do not comment on fraud. You are reading a document, not judging a claim.`

let client = null
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: BASE_URL })
  }
  return client
}

function instruction(docType) {
  const doc = MOTOR.requiredDocuments.find((d) => d.id === docType)
  const label = doc?.label ?? docType.replace(/_/g, ' ')
  const fields = DOCUMENT_FIELDS[docType] ?? []

  return `This should be a ${label.toLowerCase()} submitted with a motor claim.

Return a single JSON object and nothing else:

{
  "readable": true | false,
  "reason": "<if readable is false, why — one short sentence a claimant can act on>",
  "documentType": "<what this document actually appears to be>",
  "fields": {
${fields.map((f) => `    "${f}": <value, or omit if not visible>`).join(',\n')}
  },
  "missingFields": [<field names from the list above that should be present but are not visible>],
  "notes": "<anything a claims handler should know, or omit>"
}

If the document is not a ${label.toLowerCase()} at all, set documentType to what it actually is and list every expected field in missingFields.`
}

export const hasVisionCredentials = () => Boolean(process.env.DEEPSEEK_API_KEY)
export const visionModel = VISION_MODEL

/**
 * Extract one document.
 *
 * `image` is a data URI or a URL. Throws on transport or parse failure;
 * the caller decides whether that blocks intake or is reported to the
 * claimant as "we could not process this file, please try again".
 */
/**
 * How many times to ask before giving up.
 *
 * The vision model intermittently returns an empty response — measured
 * at roughly one call in four, with latency swinging between 5 and 25
 * seconds. That is tolerable for a seed run and not tolerable for a
 * claimant uploading a document, who would simply be told their photo
 * failed.
 *
 * Retrying is the right fix rather than a longer token budget: the
 * empty responses are not truncation (they come back with
 * finish_reason "stop" and unused budget), so more room does not help.
 */
const MAX_ATTEMPTS = 3

export async function extractDocument(docType, image) {
  let lastError

  // PDFs are common for repair estimates and emailed police reports,
  // but the vision model accepts only png/jpeg/webp/gif. Render the
  // first page and carry on as if a photo had been uploaded.
  if (isPdf(image)) {
    try {
      const rendered = await pdfToImage(image)
      image = rendered.dataUri
    } catch (err) {
      throw new Error(`Could not read the PDF — ${err.message}`)
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await getClient().chat.completions.create({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: instruction(docType) },
            ],
          },
        ],
      })

      const text = res.choices?.[0]?.message?.content
      if (!text) throw new Error('Vision model returned an empty response')

      const parsed = JSON.parse(text)

      return normalise(docType, parsed, {
        input: res.usage?.prompt_tokens ?? 0,
        output: res.usage?.completion_tokens ?? 0,
        attempts: attempt,
      })
    } catch (err) {
      lastError = err instanceof SyntaxError
        ? new Error('Vision model returned unparsable JSON')
        : err

      // A rejected request will be rejected again; only transient
      // failures are worth another attempt.
      if (err.status && err.status < 500 && err.status !== 429) throw lastError
    }
  }

  throw lastError
}

/**
 * Coerce whatever came back into the shape validate.js expects.
 *
 * A model can return valid JSON that is still wrong — a field that
 * should be a date holding free text, missingFields as a string. This
 * is the boundary where that stops being the rest of the system's
 * problem.
 */
export function normalise(docType, raw, usage = null) {
  const expected = DOCUMENT_FIELDS[docType] ?? []
  const readable = raw?.readable !== false

  const fields = {}
  if (raw?.fields && typeof raw.fields === 'object') {
    for (const [k, v] of Object.entries(raw.fields)) {
      if (v === null || v === undefined || String(v).trim() === '') continue
      fields[k] = typeof v === 'string' ? v.trim() : v
    }
  }

  // Trust the model's own list, but also derive one — a model that
  // omits a field without listing it should not silently pass.
  const claimed = Array.isArray(raw?.missingFields) ? raw.missingFields : []
  const derived = expected.filter((f) => !(f in fields))
  const missingFields = [...new Set([...claimed, ...derived])].filter((f) => expected.includes(f))

  return {
    readable,
    reason: readable ? undefined : String(raw?.reason ?? 'the document could not be read').trim(),
    documentType: raw?.documentType ? String(raw.documentType).trim() : docType,
    fields,
    missingFields,
    notes: raw?.notes ? String(raw.notes).trim() : undefined,
    extractedBy: `deepseek/${VISION_MODEL}`,
    usage,
  }
}
