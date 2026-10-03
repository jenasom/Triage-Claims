import { useEffect, useRef, useState } from 'react'
import { askSupervisor } from '../../lib/api'
import { Warn, Search, Check, Chevron } from '../Icons'

/**
 * The claims desk assistant.
 *
 * A side panel on the dashboard. Answers questions across the whole
 * book and makes changes the supervisor asks for — every one recorded
 * and reversible.
 *
 * Tool calls render as visible lines, same as intake. A supervisor
 * needs to see that a reroute actually landed, not take the agent's
 * word for it.
 */

const SUGGESTIONS = [
  'Which garages come up most in the investigation queue?',
  'Show me claims over ₦2m that were fast-tracked',
  'How many claims has a reviewer rerouted?',
]

/** Tool call → what a supervisor should see. */
function traceLine(t) {
  const r = t.result ?? {}

  if (r.error) return { icon: Warn, text: r.error, bad: true }
  if (r.needsConfirmation) return { icon: Warn, text: 'Waiting for your confirmation', bad: false }

  switch (t.tool) {
    case 'search_claims':
      return { icon: Search, text: `Searched the book — ${r.total ?? 0} match` }
    case 'count_claims':
      return { icon: Search, text: `Grouped by ${t.args?.groupBy ?? 'route'}` }
    case 'get_claim':
      return { icon: Search, text: `Opened ${t.args?.claimId}` }
    case 'reroute_claim':
      return r.applied
        ? { icon: Check, text: `${r.claimId} moved to ${r.to}`, done: true }
        : null
    case 'edit_claim':
      return r.applied ? { icon: Check, text: `${r.claimId} — ${t.args?.field} updated`, done: true } : null
    case 'withdraw_claim':
      return r.applied ? { icon: Check, text: `${r.claimId} withdrawn`, done: true } : null
    case 'restore_claim':
      return r.applied ? { icon: Check, text: `${r.claimId} restored`, done: true } : null
    default:
      return null
  }
}

function Trace({ trace }) {
  const lines = (trace ?? []).map(traceLine).filter(Boolean)
  if (!lines.length) return null

  return (
    <ul className="my-1 flex list-none flex-col gap-1 p-0 pl-0.5">
      {lines.map((l, i) => {
        const Icon = l.icon
        return (
          <li
            key={i}
            className={`flex items-center gap-1.5 text-[11px] ${
              l.bad ? 'text-stdink' : l.done ? 'text-fastink' : 'text-faint'
            }`}
          >
            <Icon size={11} className="shrink-0" />
            <span>{l.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Dots() {
  return (
    <div className="flex items-center gap-2 pl-0.5">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="ai-dot h-[5px] w-[5px] rounded-full bg-accent"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
      <span className="text-[11px] text-faint">Working…</span>
    </div>
  )
}

export default function SupervisorPanel({ open, onClose, onChanged }) {
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const scroller = useRef(null)
  const input = useRef(null)

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus())
  }, [open])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  async function ask(text) {
    const question = (text ?? draft).trim()
    if (!question || busy) return

    setDraft('')
    setMessages((m) => [...m, { role: 'user', content: question }])
    setBusy(true)
    setError(null)

    try {
      const res = await askSupervisor(sessionId, question)
      setSessionId(res.sessionId)
      setMessages((m) => [...m, { role: 'assistant', content: res.reply, trace: res.trace }])
      // A reroute or withdrawal changes the queue behind the panel.
      if (res.changed) onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    /* `min-h-0` is what lets the message list actually scroll: without
       it a flex child defaults to min-height:auto and grows to fit its
       content instead of overflowing. */
    <aside className="flex h-full w-full min-h-0 shrink-0 flex-col border-l border-line bg-rail lg:w-[340px]">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="grid h-[24px] w-[24px] place-items-center rounded-md bg-accentsoft text-[11px] font-bold text-accentink">
          C
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold">Claims desk</div>
          <div className="text-[11px] text-muted">Ask about the book, or make a change</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          className="ml-auto grid h-[26px] w-[26px] place-items-center rounded-md text-faint transition-colors hover:bg-linesoft hover:text-ink2"
        >
          <Chevron size={14} />
        </button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !busy && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-[12px] leading-[1.5] text-muted">
              I can search the book, group and count it, and reroute, correct or
              withdraw a claim. Every change is recorded against your name and can
              be undone.
            </p>
            <div className="mt-1 flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-lg border border-line bg-card px-3 py-2 text-left text-[12px] text-ink2 transition-colors hover:border-faint"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {messages.map((m, i) => (
            <div key={i} className="flex flex-col gap-1">
              {m.role === 'user' ? (
                <div className="self-end rounded-xl rounded-br-sm bg-accentfill px-3 py-2 text-[12.5px] leading-[1.5] text-white">
                  {m.content}
                </div>
              ) : (
                <div className="whitespace-pre-wrap text-[12.5px] leading-[1.55] text-ink2">
                  {m.content}
                </div>
              )}
              {m.role === 'assistant' && <Trace trace={m.trace} />}
            </div>
          ))}

          {busy && <Dots />}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2 text-[12px] text-invink">
              <Warn size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          ask()
        }}
        className="shrink-0 border-t border-line px-4 py-3"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask()
              }
            }}
            disabled={busy}
            placeholder="Ask or instruct…"
            className="max-h-[100px] min-h-[36px] flex-1 resize-none rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="h-[36px] shrink-0 rounded-lg border border-accentfill bg-accentfill px-3 text-[12px] font-medium text-white transition-colors hover:not-disabled:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  )
}
