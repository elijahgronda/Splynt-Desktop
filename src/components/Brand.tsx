export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`} aria-label="Splynt">
      <span className="brand__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && <span className="brand__name">Splynt</span>}
    </div>
  );
}
