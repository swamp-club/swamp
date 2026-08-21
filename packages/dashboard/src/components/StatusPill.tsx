// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

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
