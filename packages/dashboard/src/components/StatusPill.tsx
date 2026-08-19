const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  succeeded: { bg: "var(--success-bg)", color: "var(--success)" },
  failed: { bg: "var(--danger-bg)", color: "var(--danger)" },
  running: { bg: "var(--running-bg)", color: "var(--running)" },
  suspended: { bg: "var(--warning-bg)", color: "var(--warning)" },
  cancelled: { bg: "var(--cancelled-bg)", color: "var(--cancelled)" },
  pending: { bg: "var(--info-bg)", color: "var(--info)" },
  healthy: { bg: "var(--success-bg)", color: "var(--success)" },
  degraded: { bg: "var(--warning-bg)", color: "var(--warning)" },
  active: { bg: "var(--success-bg)", color: "var(--success)" },
  idle: { bg: "var(--cancelled-bg)", color: "var(--cancelled)" },
};

export function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "0.65rem",
        fontWeight: 500,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        padding: "2px 8px",
        borderRadius: "4px",
        whiteSpace: "nowrap",
        background: style.bg,
        color: style.color,
      }}
    >
      {status}
    </span>
  );
}
