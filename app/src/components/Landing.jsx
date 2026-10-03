import { Grid, Search, Plus } from './Icons'
import ThemeToggle from './ThemeToggle'

/**
 * The front door.
 *
 * Clearing serves two people who want completely different things: a
 * claimant asking "what is happening with my claim?", and a supervisor
 * working a queue of five hundred. Neither should start inside the
 * other's tool, so the choice is made here rather than by burying one
 * behind a button in the other's header.
 */

function Door({ icon: Icon, title, detail, action, onClick, primary }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group flex w-full items-start gap-3.5 rounded-card border p-4 text-left transition-colors',
        primary
          ? 'border-accent bg-accentsoft hover:brightness-[0.98]'
          : 'border-line bg-card hover:border-faint',
      ].join(' ')}
    >
      <span
        className={[
          'grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg',
          primary ? 'bg-accentfill text-white' : 'bg-linesoft text-muted',
        ].join(' ')}
      >
        <Icon size={17} />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={[
            'block text-[13.5px] font-semibold',
            primary ? 'text-accentink' : 'text-ink',
          ].join(' ')}
        >
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] leading-[1.5] text-muted">{detail}</span>
        <span
          className={[
            'mt-2 inline-block text-[12px] font-medium',
            primary ? 'text-accentink' : 'text-ink2',
          ].join(' ')}
        >
          {action} &rarr;
        </span>
      </span>
    </button>
  )
}

export default function Landing({ onClaimant, onStaff, onNewClaim, theme, setTheme }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-rail px-4 py-3">
        <span className="grid h-[28px] w-[28px] place-items-center rounded-lg bg-accent font-display text-[14px] font-bold text-white">
          C
        </span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">Clearing</div>
          <div className="text-[11.5px] text-muted">Motor claims intake &amp; triage</div>
        </div>
        <span className="ml-auto">
          <ThemeToggle theme={theme} onChange={setTheme} />
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px]">
          <h1 className="m-0 font-display text-[21px] font-semibold tracking-[-.015em]">
            Where would you like to go?
          </h1>
          <p className="m-0 mt-1.5 text-[13px] leading-[1.55] text-muted">
            Claimants track and complete their own claim. Claims staff work the triage queue.
          </p>

          <div className="mt-6 flex flex-col gap-2.5">
            <Door
              primary
              icon={Plus}
              title="File a new claim"
              detail="Answer a few questions and upload your documents. Takes about five minutes."
              action="Start a claim"
              onClick={onNewClaim}
            />
            <Door
              icon={Search}
              title="Track my claim"
              detail="See where your claim has got to, and add anything still outstanding."
              action="Enter my reference"
              onClick={onClaimant}
            />
          </div>

          <div className="mt-7 border-t border-line pt-5">
            <Door
              icon={Grid}
              title="Claims staff"
              detail="Triage queue, fraud signals and the supervisor assistant."
              action="Open the dashboard"
              onClick={onStaff}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
