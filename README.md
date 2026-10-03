# Clearing

AI claims intake and triage for motor insurance.

Two halves of one pipeline.

**Intake** (`/#/claim`) — an agent talks the customer through their claim:
reads uploaded documents, finds what is missing or contradictory, asks for
it in plain language, and submits only when the claim is actually complete.

**Status** (`/#/status`) — the claimant checks where their claim stands,
supplies anything outstanding, and asks the assistant questions about it.
That last part is what removes the status phone call.

**Triage** (`/`) — every submitted claim is scored and routed to
**Fast-Track**, **Standard Review**, or **Investigation**, with a written
justification a supervisor can act on or override.

Built for the Heirs Insurance hackathon. Clearing is the entry, not a
Heirs product — the palette borrows their brand colours because the
submission is aimed at them.

## The intake agent

A tool-use loop, not a form. The agent has four tools — `record_details`,
`read_document`, `check_claim`, `submit_claim` — and decides which to call.

The important constraint: **the agent cannot decide a claim is complete.**
`submit_claim` runs validation and refuses while blocking issues remain,
returning the issues instead. Rules stay authoritative; the agent handles
only the conversation. Asked to "just submit it, I'll send documents
later", it declines and offers to take them one at a time.

This beats a fixed form in the ordinary case too. Given *"Adaeze Okonkwo,
plate LSD-441-KJ, Toyota Corolla 2018, accident 2026-08-28, rear bumper hit
at a junction, quoted 184000 naira"*, it extracts eight fields in one call.
A form would have asked eight questions.

Cross-validation is deterministic and runs before any model call
(`lib/intake/validate.js`): a police report showing a different plate than
the claimant gave, a document dated before the incident it describes, a
repair estimate that disagrees with the amount claimed. Each becomes a
specific question — *"Your police report shows AKD-778-FF but you said
LSD-441-KJ. Which is correct?"* — rather than a generic error.

## Running it

Two processes. Backend first:

```bash
cd server
npm install
cp .env.example .env        # add your DEEPSEEK_API_KEY
npm run seed                # ~500 claims, scored once and cached
npm run dev                 # http://127.0.0.1:8000
```

Then the frontend:

```bash
cd app
npm install
npm run dev                 # http://localhost:5173
```

Vite proxies `/api` to the backend, so both run same-origin in development.

**Without a provider key** the system still runs end to end — fraud scoring
falls back to deterministic rules, and the UI shows a banner saying so.
`npm run seed:stub` forces that path explicitly.

### Switching provider

Fraud scoring runs on DeepSeek by default and Claude optionally, chosen by
`SCORING_PROVIDER` in `server/.env`:

```bash
SCORING_PROVIDER=deepseek     # default
DEEPSEEK_API_KEY=sk-...

# or
SCORING_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

If the named provider has no key, any other configured provider is used
instead, so setting just one key works without touching `SCORING_PROVIDER`.
Both are given the identical prompt from `lib/providers/prompt.js`, so a
difference in output is the models differing, not the instructions —
seed with one, then the other, and compare the reasoning side by side.

`GET /health` and `GET /api/stats` report which is active, and each claim
stores the exact model that scored it in `scoredBy`.

## Layout

```
server/
  index.js              Fastify app
  routes/claims.js      GET /api/claims, POST /api/claims, override, audit
  lib/
    config.js           claim-type config: checklist, thresholds, signals
    rules.js            complexity, documentation, routing — deterministic
    score.js            provider selection + rules fallback
    providers/
      prompt.js         shared prompt, schema, response validation
      deepseek.js       DeepSeek adapter (OpenAI-compatible)
      claude.js         Claude adapter (structured outputs)
    generate.js         synthetic claim generator
    db.js               SQLite (node:sqlite), claims + audit trail
    intake/
      agent.js          tool-use loop, conversation state
      tools.js          the four tools the agent can call
      validate.js       deterministic checks — runs before any model call
      extract.js        vision document reading
  routes/intake.js      start / message / upload / session
  scripts/               seed, smoke, reroute

app/src/
  lib/
    api.js              fetch wrappers
    present.js          API shape → view shape
    triage.js           shared routing rules and formatting
  data/motorConfig.js   frontend mirror of the claim-type config
  Dashboard.jsx         reviewer view
  components/
    intake/             IntakeChat, DocumentRail, ToolTrace
    ...                 Sidebar, StatBand, TriageTable, ClaimDetail,
                        ScoreCell, RoutePill, Button, Icons
```

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/claims?route=&limit=&offset=` | The queue, filtered and paged |
| `GET` | `/api/claims/:id` | One claim |
| `GET` | `/api/claims/:id/audit` | Full decision history |
| `POST` | `/api/claims` | Submit and score a new claim |
| `POST` | `/api/claims/:id/override` | Reroute, with attribution |
| `GET` | `/api/stats` | Queue counts |
| `GET` | `/api/config` | Thresholds and prohibited factors |
| `GET` | `/health` | Liveness, claim count, scoring mode |
| `POST` | `/api/intake/start` | Begin a claim conversation |
| `POST` | `/api/intake/message` | One customer turn |
| `POST` | `/api/intake/upload` | Upload a document for reading |
| `GET` | `/api/intake/:sessionId` | Session state, for reconnecting |
| `GET` | `/api/intake-config` | Which models intake uses |
| `POST` | `/api/status/lookup` | Find a claim by reference + surname |
| `GET` | `/api/status/:token` | Refresh the claimant view |
| `POST` | `/api/status/upload` | Supply an outstanding document |
| `POST` | `/api/status/:token/ask` | Ask the assistant about the claim |

### Scripts

| Command | Purpose |
|---|---|
| `npm run smoke` | Two live scoring calls — run before a full seed |
| `npm run seed` | Generate, score and store ~500 claims |
| `npm run seed:stub` | Same, using deterministic rules (no API calls) |
| `npm run reroute` | Recompute routing after a threshold change, free |

## Design decisions worth knowing

**Only fraud scoring uses a model.** Complexity, documentation completeness
and the routing decision are deterministic rules in `lib/rules.js` — fast,
free, reproducible, and explainable in a regulatory review. Judgment is
needed in exactly one place, so that is the only place an LLM is used.

**Routing rules are data.** Every threshold lives in `lib/config.js`, and
`GET /api/config` serves them, so the fast-track ceiling and the
investigation cut-off are tunable and externally inspectable rather than
buried in code.

**Every decision records the rule that produced it.** `route()` returns the
route *and* the rule string. Both go into the audit trail alongside the
scores and the actor. For an automated settlement decision, "the model said
so" is not an acceptable answer to a regulator.

**The claimant never sees the fraud score.** `lib/status.js` builds a
separate claimant-facing view with scores, signals, reasoning and route
rules stripped, and the claim assistant is given only that view — it
cannot leak what it was never handed. A claim scoring 55 reads as "under
review — some claims need additional checks," not "flagged for fraud." A
score is a reason to look closer, not a finding.

**The claim assistant has no write path.** Not a guarded one, not a
confirmed one. Its three tools are read-only and scoped to one claim, so
a claimant asking questions cannot move their own claim between queues.

**Awaiting claimant is a queue, not a route.** A claim can be in standard
review *and* missing a document. The dashboard surfaces it as a filter
across all three routes because it is the distinction a claims officer
needs most: 34% of the seeded book is blocked on the customer, and those
are the claims that generate the status calls.

**Overrides are first-class.** A supervisor can reroute any claim from the
queue; the original decision and the override are both preserved, with who
and when.

**The fraud prompt states what it may not consider.** `prohibitedFactors`
— name, ethnicity, religion, gender, age — is passed to the model as an
explicit prohibition and served from `/api/config`. Nigerian names carry
ethnic and religious information, so the generator deliberately draws from
a broad spread of naming traditions: swap a name, the score must not move.

**One claim type, built to extend.** Only motor is populated. Adding health
or travel means adding a sibling config — the engine and the UI do not
change. Better evidenced by one complete type than three partial ones.

**Thresholds were tuned against a scored book, not guessed.** The
investigation cut-off started at 65; reviewing 500 scored claims showed
several carrying three or more corroborating signals clustering at 60-62
and falling just short of referral, so it moved to 55. `npm run reroute`
recomputes routing from stored scores and writes every change to the audit
trail, so a threshold change is as traceable as a human override.

## Design

**The palette borrows Heirs Insurance Group's, with one deliberate divergence.**
Brand red is `#FE0000`, taken from the logo wordmark and the site's CTA
buttons; neutrals carry a warm grey bias picked up from the logo's globe.
The Investigation route is a deeper crimson (`#B3181F`) rather than brand
red — if both were the same colour the highest-risk claims would stop
standing out, which is the entire job of the route colours.

Filled buttons use `#D40000`, not `#FE0000`: white on pure brand red
measures 4.03:1, under the WCAG AA threshold. That is a property of
saturated red rather than of this palette, and it is why most brands
darken red for button fills. Brand red is kept at full strength for the
logo mark, focus rings and borders, where it sits against light grounds.
All 22 text/background pairings clear AA in both themes.

**Three-state theme control** — Light, Dark, System — in the header.
System is an explicit option rather than the absence of one, and it
tracks the OS live via a `matchMedia` listener. An inline script in
`index.html` applies the saved theme before first paint, so dark-mode
users never see a white flash.

**Submitting a claim shows the pipeline, not a spinner.** The four
stages in the loader are the real ones the server runs, in order: two
deterministic rule passes, the model call, then routing. Only the model
call takes meaningful time, so the rule stages tick through and the
fraud stage holds — an honest picture of where the two seconds go. A
900ms floor stops a fast response flashing the loader and vanishing.

## Cost and latency

Seeding scores each claim once and caches the result, so the demo reads
from SQLite and never stalls or costs money on refresh. New claims
submitted through `POST /api/claims` are scored live — roughly 3 seconds.

The system prompt is identical across claims, so both providers cache it —
Claude via `cache_control: ephemeral`, DeepSeek via automatic context
caching. The seed script prints token counts, cache hits, and an estimated
cost at the active provider's own rates.

Rough cost for a 500-claim seed: **~$0.16 on deepseek-chat**, **~$1–2 on
claude-opus-5**.

At real volume you would train a gradient-boosted tabular model for
high-frequency scoring and reserve LLM reasoning for the ambiguous middle
band, where the written justification earns its cost.

Intake costs more per claim than triage: document reading runs ~19s and a
few cents per document, against ~2s and a fraction of a cent for scoring.
Five documents is the bulk of a claim's cost.

## What this does not do

- **Documents are checked, not verified.** The system confirms a document
  is legible, is the type claimed, and agrees with the rest of the claim.
  It does **not** establish authenticity — that needs police and vehicle
  registry integration the insurer would have to provide. Worth saying plainly:
  a well-made forgery passes.
- **No trained fraud model.** There is no labelled historical claims data,
  so an LLM reasons over named signals instead. This is the honest state of
  a hackathon prototype, not a limitation to hide.
- **No authentication.** The override actor is hardcoded, and any visitor
  can open the reviewer dashboard.
- **Intake sessions live in memory.** A server restart loses conversations
  in progress. Only submitted claims reach the database.
- **Uploaded images are not retained.** They are held for the session and
  discarded; only the extracted fields persist.
- **Triage latency is not measured.** Live scoring takes ~2s per claim, but
  the system does not record or display it.
- **Claim-type config is duplicated** between `server/lib/config.js` and
  `app/src/data/motorConfig.js`. Fine for two consumers; promote to a shared
  package before a third.

## Next

1. Persist intake sessions so a dropped connection can resume.
2. Retain uploaded documents against the claim record for the assessor.
3. Registry integration, to move from checking documents to verifying them.
4. Measure and record actual triage latency.
