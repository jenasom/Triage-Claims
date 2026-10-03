import { useState } from 'react'
import { Chevron } from './Icons'
import { naira, ROUTE_LABEL } from '../lib/triage'
import ScoreCell from './ScoreCell'
import RoutePill from './RoutePill'
import ClaimDetail from './ClaimDetail'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'fast', label: 'Fast-Track' },
  { key: 'std', label: 'Standard' },
  { key: 'inv', label: 'Investigation' },
  // Cuts across the three routes: claims blocked on the customer.
  { key: 'awaiting', label: 'Awaiting claimant' },
]

function Th({ children, align = 'left', width }) {
  const a = { left: 'text-left', right: 'text-right', center: 'text-center' }[align]
  return (
    <th
      style={width ? { width } : undefined}
      className={`${a} whitespace-nowrap border-b border-line bg-card px-3.5 py-2.5 text-[11px] font-medium text-muted`}
    >
      {children}
    </th>
  )
}

/**
 * One claim.
 *
 * Five columns: what it is, who, how much, how risky, where it went.
 * Complexity and documentation scores are deliberately not here — they
 * matter because they drove the route, and the route is already shown.
 * Both are one click away in the expanded detail.
 */
function Row({ claim, open, onToggle, onOverride }) {
  return (
    <>
      <tr
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-label={`${claim.id}, ${claim.claimant}, routed to ${ROUTE_LABEL[claim.route]}`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={`cursor-pointer [&>td]:border-b [&>td]:border-linesoft [&>td]:px-3.5 [&>td]:py-3 [&>td]:align-middle ${
          open ? '[&>td]:bg-linesoft' : 'hover:[&>td]:bg-linesoft'
        }`}
      >
        <td>
          <Chevron size={14} className={`text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        </td>
        <td>
          <div className="whitespace-nowrap text-[13px] font-medium">{claim.claimant}</div>
          <div className="mt-0.5 whitespace-nowrap text-[11px] text-faint tabular-nums">
            {claim.id} · {claim.submittedAt}
          </div>
        </td>
        <td className="text-right">
          <span className="whitespace-nowrap text-[13px] font-semibold tabular-nums">{naira(claim.amount)}</span>
        </td>
        <td className="text-center">
          <ScoreCell value={claim.scores.fraud} label="Fraud risk" />
        </td>
        <td><RoutePill route={claim.route} /></td>
      </tr>

      {open && (
        <tr>
          <td colSpan={5} className="border-b border-line bg-linesoft p-0">
            <ClaimDetail claim={claim} onOverride={onOverride} />
          </td>
        </tr>
      )}
    </>
  )
}

function Message({ children }) {
  return (
    <tr>
      <td colSpan={5} className="px-3.5 py-12 text-center text-[13px] text-muted">
        {children}
      </td>
    </tr>
  )
}

export default function TriageTable({
  claims, filter, onFilter, status, total, onRefresh,
  page, onPage, pageSize,
}) {
  const [openId, setOpenId] = useState(null)

  // Changing the filter or page invalidates the open row. Done here
  // rather than in an effect so it happens with the event that caused
  // it, not on a second render pass.
  function changeFilter(next) {
    setOpenId(null)
    onFilter(next)
  }

  function changePage(next) {
    setOpenId(null)
    onPage(next)
  }

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, total)

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-[18px] py-3">
        <h2 className="m-0 mr-auto text-[15px] font-semibold tracking-[-.01em]">Claims</h2>
        <div className="flex gap-[5px] rounded-[9px] bg-linesoft p-[3px]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => changeFilter(f.key)}
              aria-pressed={filter === f.key}
              className={[
                'rounded-md px-2.5 py-[5px] text-xs transition-colors',
                filter === f.key
                  ? 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(20,16,15,.05)]'
                  : 'font-medium text-muted hover:text-ink',
              ].join(' ')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse">
          <thead>
            <tr>
              <Th width={26} />
              <Th>Claimant</Th>
              <Th align="right">Amount</Th>
              <Th align="center">Risk</Th>
              <Th>Route</Th>
            </tr>
          </thead>
          <tbody>
            {status === 'loading' && <Message>Loading claims…</Message>}
            {status === 'error' && <Message>Could not load the queue.</Message>}
            {status === 'ready' && claims.length === 0 && (
              <Message>No claims in this queue.</Message>
            )}
            {status === 'ready' &&
              claims.map((c) => (
                <Row
                  key={c.id}
                  claim={c}
                  open={openId === c.id}
                  onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                  onOverride={onRefresh}
                />
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-[18px] py-2.5 text-xs text-muted">
        <span>{total === 0 ? 'No claims' : `${from}–${to} of ${total}`}</span>
        <div className="flex gap-[5px]">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page === 0}
            onClick={() => changePage(Math.max(0, page - 1))}
            className="h-[27px] min-w-[27px] rounded-[7px] border border-line bg-card px-[7px] text-xs text-ink2 transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next page"
            disabled={page + 1 >= pages}
            onClick={() => changePage(Math.min(pages - 1, page + 1))}
            className="h-[27px] min-w-[27px] rounded-[7px] border border-line bg-card px-[7px] text-xs text-ink2 transition-colors hover:border-faint disabled:cursor-not-allowed disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>
    </section>
  )
}
