import { useRef, useState } from 'react'
import { askAboutClaim } from '../../lib/api'
import { Warn } from '../Icons'

/**
 * "What's happening with my claim?"
 *
 * The question a claims officer answers fifty times a day. The
 * assistant answers it from the claim's actual state, with read-only
 * tools — it can describe the claim and nothing else.
 *
 * The suggested questions are the ones people actually ask, phrased
 * the way they actually ask them.
 */

const SUGGESTIONS = [
  "What's happening with my claim?",
  'Do I need to do anything?',
  'Why is it taking so long?',
]

export default function AskPanel({ token }) {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const scroller = useRef(null)

  async function send(question) {
    const text = (question ?? draft).trim()
    if (!text || busy || !token) return

    setDraft('')
    setMessages((m) => [...m, { role: 'user', content: text }])
    setBusy(true)
    setError(null)

    try {
      const res = await askAboutClaim(token, text)
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }])
      requestAnimationFrame(() => {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-card border border-line bg-card p-4">
      <h2 className="m-0 text-[13px] font-semibold">Ask about your claim</h2>
      <p className="m-0 mt-1 text-[12px] leading-[1.5] text-muted">
        No need to call — ask anything and get an answer from your claim's
        current state.
      </p>

      {messages.length > 0 && (
        <div ref={scroller} className="mt-3 max-h-[280px] overflow-y-auto">
          <div className="flex flex-col gap-2.5">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div
                  key={i}
                  className="self-end rounded-xl rounded-br-sm bg-accentfill px-3 py-2 text-[12.5px] leading-[1.5] text-white"
                >
                  {m.content}
                </div>
              ) : (
                <div
                  key={i}
                  className="whitespace-pre-wrap rounded-xl rounded-bl-sm bg-linesoft px-3 py-2 text-[12.5px] leading-[1.55] text-ink2"
                >
                  {m.content}
                </div>
              ),
            )}

            {busy && (
              <div className="flex items-center gap-2 pl-1">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="ai-dot h-[5px] w-[5px] rounded-full bg-accent"
                      style={{ animationDelay: `${i * 0.16}s` }}
                    />
                  ))}
                </span>
                <span className="text-[11px] text-faint">Checking your claim…</span>
              </div>
            )}
          </div>
        </div>
      )}

      {messages.length === 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              disabled={busy}
              className="rounded-lg border border-line bg-card px-3 py-2 text-left text-[12.5px] text-ink2 transition-colors hover:not-disabled:border-faint disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2 text-[12px] text-invink">
          <Warn size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
        className="mt-3 flex items-end gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          placeholder="Ask a question…"
          className="h-[36px] min-w-0 flex-1 rounded-lg border border-line bg-card px-3 text-[12.5px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="h-[36px] shrink-0 rounded-lg border border-accentfill bg-accentfill px-3 text-[12px] font-medium text-white transition-colors hover:not-disabled:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Ask
        </button>
      </form>
    </div>
  )
}
