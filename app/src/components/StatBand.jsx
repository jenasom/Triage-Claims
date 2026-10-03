/**
 * Two figures, not four.
 *
 * A supervisor opening this screen needs to know how much the engine
 * cleared without them, and how much is waiting on them. Total volume
 * and average latency are vanity metrics — they live in reports.
 */
function Stat({ label, value, detail, tone = 'plain', loading }) {
  const valueTone = { good: 'text-fastink', warn: 'text-invink', plain: 'text-ink' }[tone]

  return (
    <div className="rounded-card border border-line bg-card px-5 py-4">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={`mt-2 font-display text-[30px] font-semibold leading-none tracking-[-.02em] tabular-nums ${valueTone}`}>
        {loading ? <span className="text-faint">—</span> : value}
      </div>
      <div className="mt-1.5 text-[12px] text-muted">{loading ? ' ' : detail}</div>
    </div>
  )
}

export default function StatBand({ stats }) {
  const loading = !stats

  return (
    <section className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
      <Stat
        label="Settled without review"
        value={`${stats?.fastTrackPct ?? 0}%`}
        detail={`${stats?.fastTrack ?? 0} of ${stats?.triaged ?? 0} claims fast-tracked`}
        tone="good"
        loading={loading}
      />
      <Stat
        label="Needs your attention"
        value={stats?.investigation ?? 0}
        detail="flagged for investigation"
        tone="warn"
        loading={loading}
      />
    </section>
  )
}
