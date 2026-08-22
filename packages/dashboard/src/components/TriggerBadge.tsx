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
