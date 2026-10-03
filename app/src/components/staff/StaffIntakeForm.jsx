import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchStaffIntakeConfig, submitStaffClaim } from '../../lib/api'
import { naira } from '../../lib/triage'
import { Check, Warn, Plus } from '../Icons'
import RoutePill from '../RoutePill'

/**
 * First notice of loss, taken by a claims officer.
 *
 * A deliberate contrast with the claimant's intake chat. Someone with a
 * caller on the line is transcribing, not conversing: they need every
 * field visible at once, tab order that follows the questions they are
 * asking, and no assistant deciding what to ask next. The conversation
 * is happening on the phone.
 *
 * Validation is still the server's. This form can no more submit an
 * inconsistent claim than the agent can — it posts, and renders what
 * comes back against the fields concerned.
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

const EMPTY = {
  takenBy: '',
  claimant: '',
  plate: '',
  incidentDate: '',
  incidentType: '',
  incidentDescription: '',
  amount: '',
  vehicleMake: '',
  vehicleModel: '',
  vehicleYear: '',
  insuredValue: '',
  policyAgeDays: '',
  garage: '',
  thirdPartyInvolved: false,
  injuryReported: false,
}

function toDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Could not read that file'))
    r.readAsDataURL(file)
  })
}

/** Map a server field path onto the form control that owns it. */
function ownerField(path) {
  const [head] = String(path).split('.')
  return head
}

function Field({ label, hint, error, children, wide }) {
  return (
    <label className={['flex flex-col gap-1.5', wide ? 'sm:col-span-2' : ''].join(' ')}>
      <span className="text-[12px] font-medium text-ink2">{label}</span>
      {children}
      {error ? (
        <span className="text-[11px] text-invink">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-faint">{hint}</span>
      ) : null}
    </label>
  )
}

const inputClass = (invalid) =>
  [
    'w-full rounded-lg border bg-card px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:outline-none',
    invalid ? 'border-inv focus:border-inv' : 'border-line focus:border-accent',
  ].join(' ')

/** One document attached at the counter. */
function Attachment({ doc, file, onPick, onRemove, busy }) {
  const picker = useRef(null)

  const pick = (e) => {
    const f = e.target.files?.[0]
    if (f) onPick(doc.id, f)
    e.target.value = ''
  }

  return (
    <li className="flex items-center gap-2.5 rounded-[9px] border border-line bg-card px-3 py-2">
      <input
        ref={picker}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={pick}
      />
      {file ? (
        <Check size={14} className="shrink-0 text-fast" />
      ) : (
        <Plus size={14} className="shrink-0 text-faint" />
      )}

      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-ink2">{doc.label}</span>
        {file && <span className="block truncate text-[11px] text-faint">{file.name}</span>}
      </span>

      {file ? (
        <button
          type="button"
          onClick={() => onRemove(doc.id)}
          disabled={busy}
          className="shrink-0 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:opacity-50"
        >
          Remove
        </button>
      ) : (
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={busy}
          className="shrink-0 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:opacity-50"
        >
          Attach
        </button>
      )}
    </li>
  )
}

/** Shown once the claim is taken. */
function Taken({ result, onAnother, onClose }) {
  const { claim, outstanding, rejectedDocuments } = result

  return (
    <div className="rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="m-0 text-[14px] font-semibold">
          {claim.provisional ? 'Claim lodged' : 'Claim taken'}
        </h3>
        <span className="ml-auto">
          <RoutePill route={claim.route} />
        </span>
      </div>

      <div className="mt-3 rounded-lg bg-linesoft px-3 py-2.5">
        <div className="text-[11px] text-faint">Reference — read this to the caller</div>
        <div className="font-display text-[19px] font-semibold tabular-nums tracking-[-.01em]">
          {claim.id}
        </div>
        <div className="mt-0.5 text-[11.5px] text-muted">
          {claim.claimant} · {naira(claim.amount)}
        </div>
      </div>

      <p className="m-0 mt-3 text-[12.5px] leading-[1.55] text-muted">
        {claim.provisional
          ? 'The claim is saved but not yet assessed. Tell the caller what is still outstanding and that they can supply it themselves from the claim page using this reference and their surname.'
          : 'The claim has been assessed and routed. The caller can follow it with this reference and their surname.'}
      </p>

      {outstanding.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-line px-3 py-2.5">
          <div className="text-[11px] font-medium text-ink2">Still outstanding</div>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {outstanding.map((id) => (
              <li key={id} className="text-[11.5px] text-muted">
                {id.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejectedDocuments.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-stdbg px-3 py-2.5 text-[12px] text-stdink">
          <Warn size={13} className="mt-0.5 shrink-0" />
          <span>
            Not accepted:{' '}
            {rejectedDocuments.map((r) => `${r.documentType.replace(/_/g, ' ')} (${r.reason})`).join('; ')}
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onAnother}
          className="rounded-lg border border-accentfill bg-accentfill px-3 py-[7px] text-[12.5px] font-medium text-white transition-colors hover:brightness-95"
        >
          Take another claim
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-line bg-card px-3 py-[7px] text-[12.5px] font-medium text-ink2 transition-colors hover:border-faint"
        >
          Back to queue
        </button>
      </div>
    </div>
  )
}

export default function StaffIntakeForm({ onClose, onTaken }) {
  const [config, setConfig] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [files, setFiles] = useState({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState(null)
  const [canLodge, setCanLodge] = useState(false)

  useEffect(() => {
    fetchStaffIntakeConfig()
      .then(setConfig)
      .catch(() => setError('Could not load the claim form. Is the API running?'))
  }, [])

  const set = (k) => (e) => {
    const v =
      e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [k]: v }))
    // Clearing as they type: an error about a field they are currently
    // fixing is noise.
    setFieldErrors((prev) => (prev[k] ? { ...prev, [k]: undefined } : prev))
  }

  function attach(id, file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is larger than 5MB. Use a smaller photo.')
      return
    }
    setError(null)
    setFiles((f) => ({ ...f, [id]: file }))
  }

  function detach(id) {
    setFiles((f) => {
      const next = { ...f }
      delete next[id]
      return next
    })
  }

  const send = useCallback(
    async (provisional) => {
      setBusy(true)
      setError(null)
      setFieldErrors({})
      setCanLodge(false)

      try {
        const attachments = await Promise.all(
          Object.entries(files).map(async ([documentType, file]) => ({
            documentType,
            filename: file.name,
            dataUri: await toDataUri(file),
          })),
        )

        const num = (v) => (String(v).trim() === '' ? undefined : Number(v))
        const str = (v) => (String(v).trim() === '' ? undefined : String(v).trim())

        const res = await submitStaffClaim({
          takenBy: form.takenBy.trim(),
          claimant: form.claimant.trim(),
          plate: form.plate.trim().toUpperCase(),
          incidentDate: form.incidentDate,
          incidentDescription: form.incidentDescription.trim(),
          amount: num(form.amount) ?? 0,

          incidentType: str(form.incidentType),
          vehicleMake: str(form.vehicleMake),
          vehicleModel: str(form.vehicleModel),
          vehicleYear: num(form.vehicleYear),
          insuredValue: num(form.insuredValue),
          policyAgeDays: num(form.policyAgeDays),
          garage: str(form.garage),
          thirdPartyInvolved: form.thirdPartyInvolved,
          injuryReported: form.injuryReported,

          attachments,
          provisional,
        })

        setResult(res)
        onTaken?.()
      } catch (err) {
        setError(err.message)
        setCanLodge(err.canLodgeProvisionally)

        const marks = {}
        for (const [path, message] of Object.entries(err.fields ?? {})) {
          marks[ownerField(path)] = message
        }
        for (const g of err.gaps ?? []) {
          marks[ownerField(g.field)] ??= g.problem
        }
        for (const c of err.contradictions ?? []) {
          marks[ownerField(c.field)] ??= c.problem
        }
        setFieldErrors(marks)
      } finally {
        setBusy(false)
      }
    },
    [form, files, onTaken],
  )

  function reset() {
    // The officer's own name survives — they are taking a shift of
    // calls, not one.
    setForm({ ...EMPTY, takenBy: form.takenBy })
    setFiles({})
    setResult(null)
    setError(null)
    setFieldErrors({})
    setCanLodge(false)
  }

  if (result) {
    return (
      <div className="mx-auto w-full max-w-[640px]">
        <Taken result={result} onAnother={reset} onClose={onClose} />
      </div>
    )
  }

  const docs = config?.requiredDocuments ?? []
  const types = config?.incidentTypes ?? []

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) send(false)
      }}
      className="mx-auto w-full max-w-[640px]"
    >
      <div className="rounded-card border border-line bg-card p-4">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-.01em]">Take a claim</h2>
        <p className="m-0 mt-1 text-[12px] leading-[1.5] text-muted">
          First notice of loss, taken over the phone or at the counter. The claim is checked and
          routed the same way a claim filed by the customer is.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Taken by" error={fieldErrors.takenBy} hint="Recorded against the claim">
            <input
              value={form.takenBy}
              onChange={set('takenBy')}
              placeholder="Your name"
              autoComplete="name"
              className={inputClass(fieldErrors.takenBy)}
            />
          </Field>

          <Field label="Claimant's full name" error={fieldErrors.claimant}>
            <input
              value={form.claimant}
              onChange={set('claimant')}
              placeholder="As on the policy"
              className={inputClass(fieldErrors.claimant)}
            />
          </Field>

          <Field label="Registration number" error={fieldErrors.plate}>
            <input
              value={form.plate}
              onChange={set('plate')}
              placeholder="LSD-441-KJ"
              className={`${inputClass(fieldErrors.plate)} uppercase`}
            />
          </Field>

          <Field label="Date of incident" error={fieldErrors.incidentDate}>
            <input
              type="date"
              value={form.incidentDate}
              onChange={set('incidentDate')}
              className={inputClass(fieldErrors.incidentDate)}
            />
          </Field>

          <Field label="Incident type" error={fieldErrors.incidentType}>
            <select
              value={form.incidentType}
              onChange={set('incidentType')}
              className={inputClass(fieldErrors.incidentType)}
            >
              <option value="">Select…</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Estimated repair cost" error={fieldErrors.amount} hint="Naira">
            <input
              type="number"
              inputMode="numeric"
              value={form.amount}
              onChange={set('amount')}
              placeholder="450000"
              className={`${inputClass(fieldErrors.amount)} tabular-nums`}
            />
          </Field>

          <Field
            wide
            label="What happened"
            error={fieldErrors.incidentDescription}
            hint="In the caller's own words where you can"
          >
            <textarea
              rows={3}
              value={form.incidentDescription}
              onChange={set('incidentDescription')}
              placeholder="Rear-ended at the Ikeja junction while stationary at the lights…"
              className={`${inputClass(fieldErrors.incidentDescription)} resize-y leading-[1.5]`}
            />
          </Field>
        </div>

        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-[12.5px] font-medium text-ink2">
            Vehicle and policy details
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Make" error={fieldErrors.vehicleMake}>
              <input value={form.vehicleMake} onChange={set('vehicleMake')} placeholder="Toyota" className={inputClass(fieldErrors.vehicleMake)} />
            </Field>
            <Field label="Model" error={fieldErrors.vehicleModel}>
              <input value={form.vehicleModel} onChange={set('vehicleModel')} placeholder="Corolla" className={inputClass(fieldErrors.vehicleModel)} />
            </Field>
            <Field label="Year" error={fieldErrors.vehicleYear}>
              <input type="number" value={form.vehicleYear} onChange={set('vehicleYear')} placeholder="2018" className={`${inputClass(fieldErrors.vehicleYear)} tabular-nums`} />
            </Field>
            <Field label="Insured value" error={fieldErrors.insuredValue} hint="Naira">
              <input type="number" value={form.insuredValue} onChange={set('insuredValue')} placeholder="4500000" className={`${inputClass(fieldErrors.insuredValue)} tabular-nums`} />
            </Field>
            <Field label="Policy age" error={fieldErrors.policyAgeDays} hint="Days since inception">
              <input type="number" value={form.policyAgeDays} onChange={set('policyAgeDays')} placeholder="365" className={`${inputClass(fieldErrors.policyAgeDays)} tabular-nums`} />
            </Field>
            <Field label="Repair garage" error={fieldErrors.garage}>
              <input value={form.garage} onChange={set('garage')} placeholder="Name of garage" className={inputClass(fieldErrors.garage)} />
            </Field>

            <div className="flex flex-col gap-2 sm:col-span-2">
              {[
                ['thirdPartyInvolved', 'Third party involved'],
                ['injuryReported', 'Injury reported'],
              ].map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-[12.5px] text-ink2">
                  <input type="checkbox" checked={form[k]} onChange={set(k)} className="h-[15px] w-[15px] accent-[#D40000]" />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </details>

        {docs.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <div className="text-[12.5px] font-medium text-ink2">Documents</div>
            <p className="m-0 mt-0.5 text-[11px] text-muted">
              Attach anything the caller has already sent in. Each one is read and checked before
              the claim is saved. Anything missing can be supplied by the caller later.
            </p>
            <ul className="mt-2.5 flex list-none flex-col gap-1.5 p-0">
              {docs.map((doc) => (
                <Attachment
                  key={doc.id}
                  doc={doc}
                  file={files[doc.id]}
                  onPick={attach}
                  onRemove={detach}
                  busy={busy}
                />
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2.5 text-[12.5px] text-invink">
            <Warn size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg border border-accentfill bg-accentfill px-4 py-2 text-[13px] font-medium text-white transition-colors hover:not-disabled:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Taking claim…' : 'Take claim'}
          </button>

          {/* Offered only once the server says the claim is complete
              apart from gaps — never as a way past a contradiction. */}
          {canLodge && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send(true)}
              className="rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:opacity-50"
            >
              Lodge with items outstanding
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] font-medium text-ink2 transition-colors hover:border-faint"
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
