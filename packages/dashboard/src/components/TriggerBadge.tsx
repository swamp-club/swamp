const TRIGGER_STYLES: Record<string, { bg: string; color: string }> = {
  schedule: { bg: "var(--info-bg)", color: "var(--info)" },
  webhook: { bg: "var(--running-bg)", color: "var(--running)" },
  manual: { bg: "var(--cancelled-bg)", color: "var(--text-3)" },
  api: { bg: "var(--accent-subtle)", color: "var(--accent)" },
};

export function TriggerBadge({ trigger }: { trigger: string | undefined }) {
  const label = trigger ?? "manual";
  const style = TRIGGER_STYLES[label] ?? TRIGGER_STYLES.manual;
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "0.6rem",
        fontWeight: 500,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "1px 6px",
        borderRadius: "3px",
        background: style.bg,
        color: style.color,
      }}
    >
      {label}
    </span>
  );
}
