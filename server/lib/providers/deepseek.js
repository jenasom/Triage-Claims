import OpenAI from 'openai'
import { SYSTEM, FORMAT_INSTRUCTION, userMessage, normaliseAssessment } from './prompt.js'

/**
 * DeepSeek scoring, via their OpenAI-compatible endpoint.
 *
 * DeepSeek's JSON mode guarantees syntactically valid JSON but not a
 * particular shape, so the schema goes into the prompt and the result
 * is validated in normaliseAssessment. That validation is what makes a
 * wrong-shaped response fall back to rules instead of writing a bad
 * score into a routing decision.
 */

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

let client = null
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: BASE_URL,
    })
  }
  return client
}

export const id = 'deepseek'
export const model = MODEL
export const hasCredentials = () => Boolean(process.env.DEEPSEEK_API_KEY)

export async function score(claim) {
  const res = await getClient().chat.completions.create({
    model: MODEL,
    // Low but not zero: deterministic enough to be reproducible,
    // without collapsing into a single canned phrasing.
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${FORMAT_INSTRUCTION}` },
      { role: 'user', content: userMessage(claim) },
    ],
  })

  const text = res.choices?.[0]?.message?.content
  if (!text) throw new Error('DeepSeek returned an empty response')

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`DeepSeek returned unparsable JSON: ${text.slice(0, 120)}`)
  }

  const assessment = normaliseAssessment(parsed)

  return {
    ...assessment,
    scoredBy: `deepseek/${MODEL}`,
    usage: {
      input: res.usage?.prompt_tokens ?? 0,
      output: res.usage?.completion_tokens ?? 0,
      // DeepSeek reports context-cache hits under this field.
      cacheRead: res.usage?.prompt_cache_hit_tokens ?? 0,
    },
  }
}

/** Per-MTok USD, for the seed script's cost estimate. */
export const pricing = { input: 0.27, output: 1.1 }
