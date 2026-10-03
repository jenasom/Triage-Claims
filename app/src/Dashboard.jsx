import { useCallback, useEffect, useState } from 'react'
import { Rail, Nav } from './components/Sidebar'
import StatBand from './components/StatBand'
import TriageTable from './components/TriageTable'
import Button from './components/Button'
import { Plus, Search } from './components/Icons'
import { fetchClaims, fetchStats } from './lib/api'
import { presentClaim } from './lib/present'
import ThemeToggle from './components/ThemeToggle'
import SupervisorPanel from './components/supervisor/SupervisorPanel'
import StaffIntakeForm from './components/staff/StaffIntakeForm'

const PAGE_SIZE = 50

function Banner({ children }) {
  return (
    <div className="rounded-card border border-line bg-card px-4 py-3 text-[13px] text-muted">
      {children}
    </div>
  )
}

export default function Dashboard({ onExit, theme, setTheme }) {
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [deskOpen, setDeskOpen] = useState(false)
  const [taking, setTaking] = useState(false)

  const [claims, setClaims] = useState([])
  const [stats, setStats] = useState(null)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)

  const load = useCallback(async (route, pageIndex) => {
    try {
      const [claimsRes, statsRes] = await Promise.all([
        fetchClaims({ route, limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE }),
        fetchStats(),
      ])
      setClaims(claimsRes.claims.map(presentClaim))
      setStats({ ...statsRes, filteredTotal: claimsRes.total })
      setStatus('ready')
      setError(null)
    } catch (err) {
      setError(err.message)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    load(filter, page)
  }, [filter, page, load])

  const refresh = () => load(filter, page)

  // A new filter always returns to the first page of that queue.
  function changeFilter(next) {
    setFilter(next)
    setPage(0)
  }

  return (
    /* Pinned to the viewport rather than min-h-screen: the assistant
       panel scrolls internally, which it cannot do if the shell is free
       to grow taller than the window. */
    <div className="flex h-screen overflow-hidden">
      <Rail />
      <Nav stats={stats} filter={filter} onFilter={changeFilter} />

      {/* Below lg the assistant takes the whole width, so the queue
          steps aside rather than being squeezed into a sliver. */}
      <main
        className={[
          'min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-14 pt-6 lg:px-8',
          deskOpen ? 'hidden lg:flex' : 'flex',
        ].join(' ')}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[22px] font-semibold tracking-[-.015em]">
              Triage queue
            </h1>
            <p className="m-0 mt-0.5 text-[12px] text-muted">Clearing · Claims staff</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDeskOpen((o) => !o)}
              aria-pressed={deskOpen}
              className={[
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-[7px] text-[12.5px] font-medium transition-colors',
                deskOpen
                  ? 'border-accent bg-accentsoft text-accentink'
                  : 'border-line bg-card text-ink2 hover:border-faint',
              ].join(' ')}
            >
              <Search size={14} />
              Ask
            </button>
            <button
              type="button"
              onClick={onExit}
              className="rounded-lg border border-line bg-card px-3 py-[7px] text-[12.5px] font-medium text-ink2 transition-colors hover:border-faint"
            >
              Switch view
            </button>
            <ThemeToggle theme={theme} onChange={setTheme} />
            {/* First notice of loss taken by staff — a form, not the
                claimant's intake conversation. */}
            <Button primary icon={Plus} onClick={() => setTaking(true)}>Take a claim</Button>
          </div>
        </div>

        {status === 'error' && (
          <Banner>
            Could not reach the triage API — {error}. Start it with{' '}
            <code className="rounded bg-linesoft px-1.5 py-0.5 font-mono text-[12px]">
              cd server &amp;&amp; npm run dev
            </code>
            .
          </Banner>
        )}

        {stats?.scoring === 'rules-fallback' && (
          <Banner>
            Fraud scoring is running on deterministic rules — set{' '}
            <code className="rounded bg-linesoft px-1.5 py-0.5 font-mono text-[12px]">
              DEEPSEEK_API_KEY
            </code>{' '}
            in <code className="rounded bg-linesoft px-1.5 py-0.5 font-mono text-[12px]">server/.env</code>{' '}
            and reseed for written assessments.
          </Banner>
        )}

        {taking ? (
          /* Replaces the queue rather than opening over it: taking a
             claim from a caller needs the officer's whole attention,
             and a 500-row table behind a modal is a distraction. */
          <StaffIntakeForm onClose={() => setTaking(false)} onTaken={refresh} />
        ) : (
          <>
            <StatBand stats={stats} />
            <TriageTable
              claims={claims}
              filter={filter}
              onFilter={changeFilter}
              page={page}
              onPage={setPage}
              pageSize={PAGE_SIZE}
              status={status}
              total={stats?.filteredTotal ?? 0}
              onRefresh={refresh}
            />
          </>
        )}
      </main>

      {/* The assistant can reroute or withdraw a claim, so a change
          there has to refresh the queue behind it. */}
      <SupervisorPanel
        open={deskOpen}
        onClose={() => setDeskOpen(false)}
        onChanged={refresh}
      />
    </div>
  )
}
