// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { StepState } from "../state.ts";
import { StatusIcon } from "./status_icon.tsx";
import { useSpinner } from "../hooks.ts";
import { useElapsed } from "../hooks.ts";
import { formatDuration } from "../../../output/utils/duration_formatter.ts";

interface StepLineProps {
  step: StepState;
  /** Tree continuation prefix (e.g., "  │  ├─ " or "  │  └─ "). */
  prefix: string;
}

export function StepLine({ step, prefix }: StepLineProps) {
  const spinnerFrame = useSpinner();
  const elapsed = useElapsed(step.startedAt);

  const modelMethod = step.modelName && step.methodName
    ? `${step.modelName} \u2192 ${step.methodName}`
    : null;
  const stepPrefix = modelMethod && step.id !== step.modelName
    ? `${step.id}: `
    : "";
  const label = modelMethod ? `${stepPrefix}${modelMethod}` : step.id;

  const duration = elapsed > 0 ? formatDuration(elapsed) : "";

  const approvalHint = step.status === "waiting_approval" && step.approvalPrompt
    ? ` — ${step.approvalPrompt}`
    : "";

  return (
    <Box>
      <Text dimColor>{prefix}</Text>
      <Text>{label}</Text>
      {approvalHint ? <Text color="yellow">{approvalHint}</Text> : null}
      <Box flexGrow={1} />
      <Text>
        <StatusIcon status={step.status} spinnerFrame={spinnerFrame} />
      </Text>
      {duration ? <Text dimColor>{duration}</Text> : null}
    </Box>
  );
}
