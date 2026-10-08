// One labelled number, announced as a group named after its label (screen readers and tests).
export function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: 'inline-block', margin: '0 1rem 0.5rem 0' }}
    >
      <div>{label}</div>
      <strong style={{ fontSize: '1.5rem' }}>{value}</strong>
    </div>
  );
}
