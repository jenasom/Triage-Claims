import Anthropic from '@anthropic-ai/sdk'
import { SYSTEM, SCHEMA, userMessage, normaliseAssessment } from './prompt.js'

/**
 * Claude scoring.
 *
 * Uses structured outputs, so the response is validated against the
 * schema server-side rather than parsed hopefully. The system prompt
 * is cached — a seed run pays for it once rather than per claim.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5'

let client = null
function getClient() {
  if (!client) client = new Anthropic()
  return client
}

export const id = 'claude'
export const model = MODEL
export const hasCredentials = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

export async function score(claim) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage(claim) }],
  })

  if (res.stop_reason === 'refusal') {
    throw new Error(`Scoring refused: ${res.stop_details?.category ?? 'unknown'}`)
  }

  const block = res.content.find((b) => b.type === 'text')
  if (!block) throw new Error('Claude returned no text block')

  let parsed
  try {
    parsed = JSON.parse(block.text)
  } catch {
    throw new Error(`Claude returned unparsable JSON: ${block.text.slice(0, 120)}`)
  }

  const assessment = normaliseAssessment(parsed)

  return {
    ...assessment,
    scoredBy: `claude/${MODEL}`,
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  }
}

/** Per-MTok USD, for the seed script's cost estimate. */
export const pricing = { input: 5, output: 25 }
