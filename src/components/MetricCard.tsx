export function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative" | "warning";
}) {
  return (
    <div className="card metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone ?? ""}`}>{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </div>
  );
}
