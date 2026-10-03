import { useState } from 'react'
import { Warn, CheckCircle, Check, Plus } from './Icons'
import { ROUTE_ACTION, ROUTE_LABEL } from '../lib/triage'
import { overrideRoute } from '../lib/api'
import Button from './Button'

/** Who an override is attributed to. Real auth would supply this. */
const ACTOR = 'prince.essandoh'

function Signal({ level, text }) {
  const Icon = level === 'up' ? Warn : CheckCircle
  return (
    <div className="flex items-start gap-2 text-[12.5px] text-ink2">
      <Icon size={13} className={`mt-0.5 shrink-0 ${level === 'up' ? 'text-inv' : 'text-fast'}`} />
      <span>{text}</span>
    </div>
  )
}

function DocChip({ present, label }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-[7px] border px-2 py-1 text-[11.5px]',
        present ? 'border-line bg-card text-ink2' : 'border-dashed border-line bg-card text-faint',
      ].join(' ')}
    >
      {present ? <Check size={11} className="shrink-0 text-fast" /> : <Plus size={11} className="shrink-0" />}
      {label}
    </span>
  )
}

function Label({ children }) {
  return <div className="mb-2 text-[11px] font-medium text-faint">{children}</div>
}

const OTHER_ROUTES = (current) => ['fast', 'std', 'inv'].filter((r) => r !== current)

/**
 * The expanded row — where the detail the table omits actually lives.
 *
 * The reasoning is the product's real argument: not a score, but the
 * stated reason a claim went where it went, and a way to disagree.
 */
export default function ClaimDetail({ claim, onOverride }) {
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function applyOverride(route) {
    setBusy(true)
    setError(null)
    try {
      await overrideRoute(claim.id, route, ACTOR, 'Overridden from the triage queue')
      setChoosing(false)
      onOverride?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex flex-col gap-5 px-[18px] py-4 pl-[42px]"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <Label>Why this route</Label>
          <p className="m-0 max-w-[68ch] rounded-r-[9px] border-l-[3px] border-l-accent bg-card px-3.5 py-3 text-[13px] leading-[1.6] text-ink2">
            {claim.reasoning}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
            <span>Complexity {claim.scores.complexity}</span>
            <span>Documentation {claim.scores.documentation}%</span>
            <span>{claim.vehicle}</span>
          </div>
        </div>

        <div>
          <Label>Signals</Label>
          <div className="flex flex-col gap-1.5">
            {claim.signals.map((s, i) => (
              <Signal key={i} {...s} />
            ))}
          </div>

          {claim.documents.some((d) => !d.present) && (
            <>
              <div className="mt-4">
                <Label>Outstanding documents</Label>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {claim.documents
                  .filter((d) => !d.present)
                  .map((d, i) => (
                    <DocChip key={i} {...d} />
                  ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Nothing to act on until the claimant completes it: there is no
            route to override and no assessment to approve. */}
        {claim.provisional ? (
          <span className="text-[12.5px] text-muted">
            Lodged with items outstanding — waiting on the claimant. It will be assessed
            automatically once they are supplied.
          </span>
        ) : choosing ? (
          <>
            <span className="text-[12.5px] text-muted">Move to:</span>
            {OTHER_ROUTES(claim.route).map((r) => (
              <Button key={r} onClick={() => applyOverride(r)} disabled={busy}>
                {ROUTE_LABEL[r]}
              </Button>
            ))}
            <Button onClick={() => setChoosing(false)} disabled={busy}>Cancel</Button>
          </>
        ) : (
          <>
            <Button primary>{ROUTE_ACTION[claim.route]}</Button>
            <Button onClick={() => setChoosing(true)}>Override route</Button>
          </>
        )}
        {error && <span className="text-[12px] text-invink">{error}</span>}
      </div>
    </div>
  )
}
