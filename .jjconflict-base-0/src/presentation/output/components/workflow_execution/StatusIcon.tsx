// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Text } from "ink";

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

interface StatusIconProps {
  status: RunStatus;
}

const statusConfig: Record<RunStatus, { icon: string; color: string }> = {
  pending: { icon: "○", color: "gray" },
  running: { icon: "◐", color: "yellow" },
  succeeded: { icon: "✓", color: "green" },
  failed: { icon: "✗", color: "red" },
  skipped: { icon: "⊘", color: "gray" },
};

/**
 * Displays a status icon with color coding.
 */
export function StatusIcon({ status }: StatusIconProps): React.ReactElement {
  const { icon, color } = statusConfig[status] ?? { icon: "?", color: "white" };
  return <Text color={color}>{icon}</Text>;
}
