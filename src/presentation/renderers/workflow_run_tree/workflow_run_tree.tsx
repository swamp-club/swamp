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

// deno-lint-ignore verbatim-module-syntax
import React, { useEffect, useReducer } from "react";
import { Box, Static, Text, useApp } from "ink";
import type { WorkflowRunEvent } from "../../../libswamp/mod.ts";
import {
  createInitialState,
  type ScrollbackItem,
  type TreeAction,
  treeReducer,
} from "./state.ts";
import { computeTier, extractBudgetInput } from "./budget.ts";
import { useTerminalSize } from "../../output/hooks/mod.ts";
import { ScrollbackEntry } from "./components/scrollback_item.tsx";
import { ActiveZone, ReportProgress } from "./components/active_zone.tsx";

/**
 * Event bridge that batches rapid-fire events into single React dispatches.
 *
 * Events arriving within the same microtask are accumulated and dispatched
 * as a single `{ type: "batch", events }` action, avoiding React's maximum
 * update depth limit on large parallel workflows.
 */
export class EventBridge {
  private buffer: WorkflowRunEvent[] = [];
  private pending: WorkflowRunEvent[] = [];
  private dispatchFn: ((action: TreeAction) => void) | null = null;
  private flushScheduled = false;
  private _closed = false;

  push(event: WorkflowRunEvent): void {
    if (this._closed) return;
    if (this.dispatchFn) {
      this.pending.push(event);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    } else {
      this.buffer.push(event);
    }
  }

  connect(dispatch: (action: TreeAction) => void): void {
    this.dispatchFn = dispatch;
    if (this.buffer.length > 0) {
      dispatch({ type: "batch", events: this.buffer });
      this.buffer = [];
    }
  }

  close(): void {
    this._closed = true;
    // Flush any remaining pending events
    this.flush();
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pending.length > 0 && this.dispatchFn) {
      const events = this.pending;
      this.pending = [];
      this.dispatchFn({ type: "batch", events });
    }
  }
}

function SeparatorLine(
  { width, workflowName }: { width: number; workflowName: string },
) {
  const prefix = "\u2500";
  const brand = "swamp";
  const suffix = ` ${workflowName} \u2500\u2500`;
  const fixedLen = prefix.length + brand.length + suffix.length;
  const padLen = Math.max(0, width - fixedLen);
  return (
    <Text>
      <Text color="cyan">{prefix}</Text>
      <Text color="greenBright">{brand}</Text>
      <Text color="cyan">{"\u2500".repeat(padLen)}{suffix}</Text>
    </Text>
  );
}

interface WorkflowRunTreeProps {
  bridge: EventBridge;
  workflowName: string;
  onDone: (failed: boolean) => void;
}

export function WorkflowRunTree(
  { bridge, workflowName, onDone }: WorkflowRunTreeProps,
) {
  const [state, dispatch] = useReducer(
    treeReducer,
    createInitialState(workflowName),
  );
  const { width, height } = useTerminalSize();
  const { exit } = useApp();

  useEffect(() => {
    bridge.connect(dispatch);
  }, [bridge]);

  useEffect(() => {
    if (state.phase === "done") {
      onDone(state.failed);
      // Allow one final render cycle before exit
      const id = setTimeout(() => exit(), 0);
      return () => clearTimeout(id);
    }
  }, [state.phase, state.failed]);

  const budgetInput = extractBudgetInput(state);
  const budget = computeTier(height, budgetInput);

  const showActiveZone = state.phase === "running" &&
    (budgetInput.runningJobCount > 0 || budgetInput.waitingJobCount > 0);
  const showReportProgress = state.phase === "reports";

  const showBottomZone = showActiveZone || showReportProgress;
  const zoneHeight = Math.floor(height / 2);

  return (
    <Box flexDirection="column">
      <Static items={state.scrollback}>
        {(item: ScrollbackItem, index: number) => (
          <ScrollbackEntry key={index} item={item} />
        )}
      </Static>
      {state.phase === "init" && (
        <Box>
          <Box flexGrow={1} />
        </Box>
      )}
      {showBottomZone && (
        <Box flexDirection="column" height={zoneHeight}>
          <SeparatorLine width={width} workflowName={state.workflowName} />
          {showActiveZone && <ActiveZone state={state} budget={budget} />}
          {showReportProgress && (
            <ReportProgress reportName={state.activeReport} />
          )}
        </Box>
      )}
    </Box>
  );
}
