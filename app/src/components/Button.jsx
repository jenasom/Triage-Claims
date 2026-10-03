export default function Button({ primary, icon: Icon, children, disabled, ...rest }) {
  return (
    <button
      type="button"
      disabled={disabled}
      {...rest}
      className={[
        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-[7px] text-[12.5px] font-medium transition-colors',
        'shadow-[0_1px_2px_rgba(20,16,15,.05)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        primary
          ? 'border-accentfill bg-accentfill text-white hover:not-disabled:brightness-95'
          : 'border-line bg-card text-ink2 hover:not-disabled:border-faint',
      ].join(' ')}
    >
      {Icon && <Icon size={14} />}
      {children}
    </button>
  )
}
