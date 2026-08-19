const DOT_COLORS: Record<string, string> = {
  succeeded: "var(--success)",
  failed: "var(--danger)",
  running: "var(--running)",
  suspended: "var(--warning)",
  cancelled: "var(--cancelled)",
  healthy: "var(--success)",
  degraded: "var(--warning)",
  pending: "var(--info)",
};

export function StatusDot({ status }: { status: string }) {
  const color = DOT_COLORS[status] ?? "var(--text-3)";
  const isAnimated = status === "running";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        display: "inline-block",
        animation: isAnimated ? "pulse-dot 1.5s infinite" : undefined,
      }}
    />
  );
}
