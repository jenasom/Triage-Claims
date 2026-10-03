import { Check, Search, Doc, Warn } from '../Icons'

/**
 * What the agent did, shown to the customer.
 *
 * The agent's tool calls are rendered rather than hidden. A customer
 * waiting twenty seconds for a document to be read should see that
 * something is happening and what it is; and for a judge watching a
 * demo, this is the difference between "a chatbot" and "an agent doing
 * work you can inspect".
 *
 * Phrased in the customer's terms — "Read your police report", not
 * "read_document(police_report)".
 */

const LABELS = {
  record_details: (t) => {
    const n = Object.keys(t.args ?? {}).length
    return { icon: Check, text: `Saved ${n} detail${n === 1 ? '' : 's'}` }
  },
  read_document: (t) => {
    const type = (t.args?.documentType ?? 'document').replace(/_/g, ' ')
    if (t.result?.error) return { icon: Warn, text: `Could not process your ${type}`, bad: true }
    if (t.result?.readable === false) {
      return { icon: Warn, text: `Your ${type} could not be read`, bad: true }
    }
    const n = Object.keys(t.result?.fields ?? {}).length
    return { icon: Doc, text: `Read your ${type} — found ${n} field${n === 1 ? '' : 's'}` }
  },
  check_claim: (t) => {
    const n = t.result?.blocking?.length ?? 0
    return {
      icon: Search,
      text: n === 0 ? 'Checked your claim — nothing outstanding' : `Checked your claim — ${n} item${n === 1 ? '' : 's'} outstanding`,
    }
  },
  submit_claim: (t) =>
    t.result?.submitted
      ? { icon: Check, text: `Submitted as ${t.result.claimId}` }
      : { icon: Warn, text: 'Could not submit yet', bad: true },
}

export default function ToolTrace({ trace }) {
  if (!trace?.length) return null

  const lines = trace
    .map((t) => LABELS[t.tool]?.(t))
    .filter(Boolean)

  if (!lines.length) return null

  return (
    <ul className="my-1 flex list-none flex-col gap-1 p-0 pl-1">
      {lines.map((l, i) => {
        const Icon = l.icon
        return (
          <li
            key={i}
            className={`flex items-center gap-2 text-[11.5px] ${l.bad ? 'text-stdink' : 'text-faint'}`}
          >
            <Icon size={12} className="shrink-0" />
            <span>{l.text}</span>
          </li>
        )
      })}
    </ul>
  )
}
