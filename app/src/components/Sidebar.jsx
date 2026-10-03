import { Grid, List, Shield, Check, Clock, Search, UpDown, Gear } from './Icons'

function RailButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        'grid h-[34px] w-[34px] place-items-center rounded-lg transition-colors',
        active ? 'bg-accentsoft text-accentink' : 'text-faint hover:bg-linesoft hover:text-ink2',
      ].join(' ')}
    >
      <Icon size={17} />
    </button>
  )
}

/** Narrow icon rail — always visible, even on small screens. */
export function Rail() {
  return (
    <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-rail py-3.5">
      <div className="mb-3.5 grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent font-display text-[15px] font-bold text-white">
        C
      </div>
      <RailButton icon={Grid} label="Triage" active />
      <RailButton icon={List} label="Claims" />
      <RailButton icon={Shield} label="Fraud signals" />
      <div className="flex-1" />
      <RailButton icon={Gear} label="Settings" />
    </aside>
  )
}

function NavItem({ icon: Icon, children, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2.5 rounded-[9px] px-2 py-[7px] text-left text-[13px] transition-colors',
        active ? 'bg-accentsoft font-semibold text-accentink' : 'text-ink2 hover:bg-linesoft',
      ].join(' ')}
    >
      <Icon size={15} className="shrink-0 opacity-85" />
      {children}
      {count != null && (
        <span
          className={[
            'ml-auto text-[11px] font-semibold tabular-nums',
            active ? 'text-accentink' : 'text-muted',
          ].join(' ')}
        >
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * Navigation, trimmed to what a supervisor actually uses.
 *
 * The queues double as filters — clicking one filters the table below,
 * so the nav is not decorative.
 */
export function Nav({ stats, filter, onFilter }) {
  return (
    <nav className="hidden w-[204px] shrink-0 flex-col gap-0.5 border-r border-line bg-rail px-3 py-3.5 md:flex">
      <button
        type="button"
        className="mb-5 flex items-center gap-2.5 rounded-[9px] border border-line bg-card p-2 text-left transition-colors hover:border-faint"
      >
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-accentsoft text-[12px] font-semibold text-accentink">
          PE
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold">Prince Essandoh</span>
          <span className="block truncate text-[11px] text-muted">Claims Supervisor</span>
        </span>
        <UpDown size={13} className="shrink-0 text-faint" />
      </button>

      <NavItem icon={Grid} active={filter === 'all'} onClick={() => onFilter('all')}>
        All claims
      </NavItem>
      {/* Lodged but not yet assessed — blocked on the claimant rather
          than on us, and invisible in the three route queues because a
          provisional claim has no route yet. */}
      {stats?.provisional > 0 && (
        <NavItem
          icon={Clock}
          count={stats.provisional}
          active={filter === 'provisional'}
          onClick={() => onFilter('provisional')}
        >
          Incomplete
        </NavItem>
      )}
      <NavItem
        icon={Check}
        count={stats?.fastTrack}
        active={filter === 'fast'}
        onClick={() => onFilter('fast')}
      >
        Fast-Track
      </NavItem>
      <NavItem
        icon={Clock}
        count={stats?.standard}
        active={filter === 'std'}
        onClick={() => onFilter('std')}
      >
        Standard
      </NavItem>
      <NavItem
        icon={Search}
        count={stats?.investigation}
        active={filter === 'inv'}
        onClick={() => onFilter('inv')}
      >
        Investigation
      </NavItem>
    </nav>
  )
}
