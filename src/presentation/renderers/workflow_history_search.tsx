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
import React from "react";
import { Box, Text } from "ink";
import { dim, red } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  HistorySkippedWorkflow,
  WorkflowHistorySearchData,
  WorkflowHistorySearchEvent,
  WorkflowHistorySearchItem,
} from "../../libswamp/workflows/history_search.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import type {
  SearchRenderer,
  SearchRendererOptions,
} from "./search_renderer.ts";
import { createSearchListRenderer } from "./search_result_list.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";
import { writeReapedRunsLine } from "./workflow_run_search.tsx";
import { inputPairs } from "./run_input_pairs.ts";

const STATUS_COLORS: Record<string, string> = {
  pending: "gray",
  running: "yellow",
  succeeded: "green",
  failed: "red",
};

const STATUS_ICONS: Record<string, string> = {
  succeeded: "\u2713",
  failed: "\u2717",
  running: "\u25CB",
  pending: "\u25CB",
  skipped: "\u2014",
};

function formatDurationSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export type HistoryPreviewFetcher = (
  item: WorkflowHistorySearchItem,
) => Promise<WorkflowRunView>;

function filterRuns(
  items: WorkflowHistorySearchItem[],
  query: string,
): WorkflowHistorySearchItem[] {
  if (!query) return items;
  const lowerQuery = query.toLowerCase();
  return items.filter(
    (r) =>
      r.workflowName.toLowerCase().includes(lowerQuery) ||
      r.runId.toLowerCase().includes(lowerQuery) ||
      r.status.toLowerCase().includes(lowerQuery) ||
      (r.inputs &&
        Object.entries(r.inputs).some(([k, v]) =>
          `${k}=${String(v)}`.toLowerCase().includes(lowerQuery)
        )),
  );
}

export type WorkflowHistorySearchRenderer = SearchRenderer<
  WorkflowHistorySearchEvent,
  WorkflowHistorySearchItem
>;

class JsonWorkflowHistorySearchRenderer
  implements WorkflowHistorySearchRenderer {
  private _selected: WorkflowHistorySearchItem | undefined;

  selectedItem(): WorkflowHistorySearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowHistorySearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterRuns(e.data.results, e.data.query);
        const output: WorkflowHistorySearchData = {
          query: e.data.query,
          results: filtered,
          ...(e.data.reapedBefore ? { reapedBefore: e.data.reapedBefore } : {}),
          ...(e.data.skippedWorkflows
            ? { skippedWorkflows: e.data.skippedWorkflows }
            : {}),
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkWorkflowHistorySearchRenderer
  implements WorkflowHistorySearchRenderer {
  private _selected: WorkflowHistorySearchItem | undefined;
  private readonly fetchPreview: HistoryPreviewFetcher | undefined;

  constructor(fetchPreview?: HistoryPreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): WorkflowHistorySearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowHistorySearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          WorkflowHistorySearchItem,
          WorkflowRunView
        >(
          e.data.results,
          e.data.query,
          (item) => {
            const tagStr = item.tags
              ? Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(
                " ",
              )
              : "";
            // matched on listed values only, so "omitted" matches no run
            const inputStr = Object.entries(item.inputs ?? {})
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(" ");
            return `${item.workflowName} ${item.runId} ${item.status} ${tagStr} ${inputStr}`
              .trim();
          },
          renderHistoryResultLine,
          renderHistoryPreview,
          renderHistoryScrollback,
          "runs",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) => item.runId,
          },
        );
        if (result) {
          this._selected = result.item;
        }
        writeReapedRunsLine(e.data.reapedBefore);
        writeSkippedWorkflowsLines(e.data.skippedWorkflows);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

function writeSkippedWorkflowsLines(
  skipped: readonly HistorySkippedWorkflow[] | undefined,
): void {
  for (const { workflowName, runId, reason } of skipped ?? []) {
    writeOutput(
      `${
        red(`Left out workflow ${workflowName}:`)
      } the record of run ${runId} cannot be read: ${reason}. ${
        dim("See 'swamp run doctor'.")
      }`,
    );
  }
}

export function createWorkflowHistorySearchRenderer(
  mode: OutputMode,
  fetchPreview?: HistoryPreviewFetcher,
  options: SearchRendererOptions = {},
): WorkflowHistorySearchRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowHistorySearchRenderer();
    case "log":
      if (options.interactive === false) {
        return createSearchListRenderer<
          WorkflowHistorySearchEvent,
          WorkflowHistorySearchItem
        >({
          itemLabel: "runs",
          items: (e) => filterRuns(e.data.results, e.data.query),
          renderEntry: (item) => renderHistoryScrollback(item, undefined),
          afterList: (e) => {
            writeReapedRunsLine(e.data.reapedBefore);
            writeSkippedWorkflowsLines(e.data.skippedWorkflows);
          },
          toError: (error) => new UserError(error.message),
        });
      }
      return new InkWorkflowHistorySearchRenderer(fetchPreview);
  }
}

function renderHistoryResultLine(
  item: WorkflowHistorySearchItem,
): React.ReactElement {
  const statusColor = STATUS_COLORS[item.status] ?? "white";
  const dateStr = item.startedAt
    ? new Date(item.startedAt).toLocaleString()
    : "not started";
  const durationStr = item.duration !== undefined
    ? `${(item.duration / 1000).toFixed(1)}s`
    : "";
  const tagStr = item.tags && Object.keys(item.tags).length > 0
    ? Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(", ")
    : "";
  const inputStr = inputPairs(item).join(", ");

  return (
    <Text>
      {`${item.workflowName} `}
      <Text color={statusColor}>{`[${item.status}]`}</Text>
      {` ${dateStr}`}
      {durationStr ? ` ${durationStr}` : ""}
      {tagStr ? <Text color="cyan">{` [${tagStr}]`}</Text> : null}
      {inputStr ? <Text color="magenta">{` {${inputStr}}`}</Text> : null}
    </Text>
  );
}

function renderHistoryPreview(
  item: WorkflowHistorySearchItem,
  detail: WorkflowRunView | undefined,
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  if (!detail) {
    const statusColor = STATUS_COLORS[item.status] ?? "white";
    const dateStr = item.startedAt
      ? new Date(item.startedAt).toLocaleString()
      : "not started";
    const completedStr = item.completedAt
      ? new Date(item.completedAt).toLocaleString()
      : "";
    const durationStr = item.duration !== undefined
      ? `${(item.duration / 1000).toFixed(1)}s`
      : "";
    const tagStr = item.tags && Object.keys(item.tags).length > 0
      ? Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(", ")
      : "";

    const lines: React.ReactElement[] = [
      <Text key="name" bold wrap="truncate-end">{item.workflowName}</Text>,
      <Text key="run" dimColor wrap="truncate-end">run: {item.runId}</Text>,
      <Text key="status" wrap="truncate-end">
        status: <Text color={statusColor}>{item.status}</Text>
      </Text>,
      <Text key="started" dimColor wrap="truncate-end">
        started: {dateStr}
      </Text>,
    ];
    if (completedStr) {
      lines.push(
        <Text key="completed" dimColor wrap="truncate-end">
          completed: {completedStr}
        </Text>,
      );
    }
    if (durationStr) {
      lines.push(
        <Text key="duration" dimColor wrap="truncate-end">
          duration: {durationStr}
        </Text>,
      );
    }
    if (tagStr) {
      lines.push(
        <Text key="tags" dimColor wrap="truncate-end">tags: {tagStr}</Text>,
      );
    }
    const previewInputStr = inputPairs(item).join(", ");
    if (previewInputStr) {
      lines.push(
        <Text key="inputs" dimColor wrap="truncate-end">
          inputs: {previewInputStr}
        </Text>,
      );
    }
    return (
      <Box flexDirection="column" marginLeft={1} width={innerWidth}>
        {lines}
      </Box>
    );
  }

  const statusColor = STATUS_COLORS[detail.status] ?? "white";
  const durationStr = detail.duration !== undefined
    ? formatDurationSec(detail.duration)
    : "";

  const lines: React.ReactElement[] = [
    <Text key="name" bold wrap="truncate-end">{detail.workflowName}</Text>,
    <Text key="run" dimColor wrap="truncate-end">run: {detail.id}</Text>,
    <Text key="status" wrap="truncate-end">
      status: <Text color={statusColor}>{detail.status}</Text>
    </Text>,
  ];
  if (durationStr) {
    lines.push(
      <Text key="duration" dimColor wrap="truncate-end">
        duration: {durationStr}
      </Text>,
    );
  }

  if (detail.jobs.length > 0) {
    lines.push(<Text key="jobs-gap" />);
    lines.push(
      <Text key="jobs-hdr" color="cyan" bold wrap="truncate-end">Jobs:</Text>,
    );
    for (const job of detail.jobs) {
      const jobIcon = STATUS_ICONS[job.status] ?? " ";
      const jobColor = STATUS_COLORS[job.status] ?? "white";
      const jobDur = job.duration !== undefined
        ? ` (${formatDurationSec(job.duration)})`
        : "";
      lines.push(
        <Text key={`job-${job.name}`} wrap="truncate-end">
          {"  "}
          <Text color={jobColor}>{jobIcon}</Text> <Text bold>{job.name}</Text>
          <Text dimColor>{jobDur}</Text>
        </Text>,
      );
      for (const step of job.steps) {
        const stepIcon = STATUS_ICONS[step.status] ?? " ";
        const stepColor = STATUS_COLORS[step.status] ?? "white";
        const stepDur = step.duration !== undefined
          ? ` (${formatDurationSec(step.duration)})`
          : "";
        lines.push(
          <Text key={`step-${job.name}-${step.name}`} wrap="truncate-end">
            {"    "}
            <Text color={stepColor}>{stepIcon}</Text> {step.name}
            <Text dimColor>{stepDur}</Text>
            {step.error && <Text color="red">- {step.error}</Text>}
          </Text>,
        );
      }
    }
  }

  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      {lines}
    </Box>
  );
}

function renderHistoryScrollback(
  item: WorkflowHistorySearchItem,
  detail: WorkflowRunView | undefined,
): string {
  if (!detail) {
    const dateStr = item.startedAt
      ? new Date(item.startedAt).toLocaleString()
      : "not started";
    const durationStr = item.duration !== undefined
      ? `${(item.duration / 1000).toFixed(1)}s`
      : "";
    const tagStr = item.tags && Object.keys(item.tags).length > 0
      ? Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(", ")
      : "";

    const lines: string[] = [
      `${item.workflowName} [${item.status}]`,
      `run: ${item.runId}`,
      `started: ${dateStr}`,
    ];

    if (item.completedAt) {
      lines.push(`completed: ${new Date(item.completedAt).toLocaleString()}`);
    }
    if (durationStr) {
      lines.push(`duration: ${durationStr}`);
    }
    if (tagStr) {
      lines.push(`tags: ${tagStr}`);
    }
    const scrollInputStr = inputPairs(item).join(", ");
    if (scrollInputStr) {
      lines.push(`inputs: ${scrollInputStr}`);
    }

    return lines.join("\n");
  }

  const durationStr = detail.duration !== undefined
    ? formatDurationSec(detail.duration)
    : "";

  const lines: string[] = [
    `${detail.workflowName} [${detail.status}]`,
    `run: ${detail.id}`,
  ];

  if (durationStr) {
    lines.push(`duration: ${durationStr}`);
  }

  if (detail.jobs.length > 0) {
    lines.push("");
    lines.push("Jobs:");
    for (const job of detail.jobs) {
      const jobIcon = STATUS_ICONS[job.status] ?? " ";
      const jobDur = job.duration !== undefined
        ? ` (${formatDurationSec(job.duration)})`
        : "";
      lines.push(`  ${jobIcon} ${job.name}${jobDur}`);
      for (const step of job.steps) {
        const stepIcon = STATUS_ICONS[step.status] ?? " ";
        const stepDur = step.duration !== undefined
          ? ` (${formatDurationSec(step.duration)})`
          : "";
        const stepErr = step.error ? ` - ${step.error}` : "";
        lines.push(`    ${stepIcon} ${step.name}${stepDur}${stepErr}`);
      }
    }
  }

  return lines.join("\n");
}
