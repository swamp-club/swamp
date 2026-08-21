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
