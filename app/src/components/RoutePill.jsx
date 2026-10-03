import { ROUTE_LABEL } from '../lib/triage'

const TONE = {
  fast: 'bg-fastbg text-fastink',
  std:  'bg-stdbg text-stdink',
  inv:  'bg-invbg text-invink',
}
const DOT = {
  fast: 'bg-fast',
  std:  'bg-std',
  inv:  'bg-inv',
}

export default function RoutePill({ route }) {
  /**
   * A provisional claim has no route yet — it is lodged and waiting on
   * the claimant. Shown as its own neutral state rather than borrowing
   * a queue colour it does not belong to.
   */
  if (!route) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-line px-2.5 py-1 text-[11.5px] font-semibold text-faint">
        <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-faint" />
        Incomplete
      </span>
    )
  }

  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${TONE[route]}`}>
      <span className={`h-[5px] w-[5px] shrink-0 rounded-full ${DOT[route]}`} />
      {ROUTE_LABEL[route]}
    </span>
  )
}
