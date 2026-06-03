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
import type {
  EventHandlers,
  ModelOutputGetData,
  ModelOutputSearchData,
  ModelOutputSearchEvent,
  ModelOutputSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";

/**
 * Filters outputs by a query string.
 */
function filterOutputs(
  outputs: ModelOutputSearchItem[],
  query: string,
): ModelOutputSearchItem[] {
  if (!query) return outputs;
  const lowerQuery = query.toLowerCase();
  return outputs.filter(
    (o) =>
      (o.modelName?.toLowerCase().includes(lowerQuery) ?? false) ||
      o.type.toLowerCase().includes(lowerQuery) ||
      o.methodName.toLowerCase().includes(lowerQuery) ||
      o.status.toLowerCase().includes(lowerQuery) ||
      o.id.toLowerCase().includes(lowerQuery) ||
      o.definitionId.toLowerCase().includes(lowerQuery),
  );
}

function getStatusColor(
  status: string,
): "green" | "yellow" | "red" | "blue" | undefined {
  switch (status) {
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "yellow";
    case "pending":
      return "blue";
    default:
      return undefined;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

/**
 * Callback type for fetching output detail data for the preview pane.
 */
export type OutputPreviewFetcher = (
  item: ModelOutputSearchItem,
) => Promise<ModelOutputGetData>;

export type ModelOutputSearchRenderer = SearchRenderer<
  ModelOutputSearchEvent,
  ModelOutputSearchItem
>;

class JsonModelOutputSearchRenderer implements ModelOutputSearchRenderer {
  private _selected: ModelOutputSearchItem | undefined;

  selectedItem(): ModelOutputSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelOutputSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterOutputs(e.data.results, e.data.query);
        const output: ModelOutputSearchData = {
          query: e.data.query,
          results: filtered,
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkModelOutputSearchRenderer implements ModelOutputSearchRenderer {
  private _selected: ModelOutputSearchItem | undefined;
  private readonly fetchPreview: OutputPreviewFetcher | undefined;

  constructor(fetchPreview?: OutputPreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): ModelOutputSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelOutputSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          ModelOutputSearchItem,
          ModelOutputGetData
        >(
          e.data.results,
          e.data.query,
          (item) =>
            `${
              item.modelName ?? item.definitionId
            } ${item.type} ${item.methodName} ${item.status} ${item.id}`,
          renderOutputResultLine,
          renderOutputPreview,
          renderOutputScrollback,
          "outputs",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) => item.id,
          },
        );
        if (result) {
          this._selected = result.item;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelOutputSearchRenderer(
  mode: OutputMode,
  fetchPreview?: OutputPreviewFetcher,
): ModelOutputSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonModelOutputSearchRenderer();
    case "log":
      return new InkModelOutputSearchRenderer(fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderOutputResultLine(
  item: ModelOutputSearchItem,
): React.ReactElement {
  const methodLabel = ` ${item.methodName}`;
  const statusLabel = ` [${item.status}]`;
  const durationLabel = item.durationMs !== undefined
    ? ` (${formatDuration(item.durationMs)})`
    : undefined;
  return (
    <Text>
      {item.modelName ?? item.definitionId.slice(0, 8)}
      <Text color="cyan">{methodLabel}</Text>
      <Text color={getStatusColor(item.status)}>{statusLabel}</Text>
      {durationLabel !== undefined && <Text dimColor>{durationLabel}</Text>}
    </Text>
  );
}

/** Renders preview content for a model output. */
function renderOutputPreview(
  item: ModelOutputSearchItem,
  detail: ModelOutputGetData | undefined,
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  if (!detail) {
    // Immediate content from the search item
    const displayName = item.modelName ?? item.definitionId;
    const lines: React.ReactElement[] = [
      <Text key="name" bold wrap="truncate-end">{displayName}</Text>,
      <Text key="type" dimColor wrap="truncate-end">type: {item.type}</Text>,
      <Text key="method" wrap="truncate-end">
        method: <Text color="cyan">{item.methodName}</Text>
      </Text>,
      <Text key="status" wrap="truncate-end">
        status: <Text color={getStatusColor(item.status)}>{item.status}</Text>
      </Text>,
      <Text key="started" dimColor wrap="truncate-end">
        started: {item.startedAt}
      </Text>,
    ];
    if (item.durationMs !== undefined) {
      lines.push(
        <Text key="duration" dimColor wrap="truncate-end">
          duration: {formatDuration(item.durationMs)}
        </Text>,
      );
    }
    lines.push(
      <Text key="defId" dimColor wrap="truncate-end">
        definitionId: {item.definitionId}
      </Text>,
    );
    return (
      <Box flexDirection="column" marginLeft={1} width={innerWidth}>
        {lines}
      </Box>
    );
  }

  // Full detail from fetchPreview
  const displayName = detail.modelName ?? detail.definitionId;
  const lines: React.ReactElement[] = [
    <Text key="name" bold wrap="truncate-end">{displayName}</Text>,
    <Text key="type" dimColor wrap="truncate-end">type: {detail.type}</Text>,
    <Text key="method" wrap="truncate-end">
      method: <Text color="cyan">{detail.methodName}</Text>
    </Text>,
    <Text key="status" wrap="truncate-end">
      status: <Text color={getStatusColor(detail.status)}>{detail.status}</Text>
    </Text>,
    <Text key="started" dimColor wrap="truncate-end">
      started: {detail.startedAt}
    </Text>,
  ];
  if (detail.completedAt) {
    lines.push(
      <Text key="completed" dimColor wrap="truncate-end">
        completed: {detail.completedAt}
      </Text>,
    );
  }
  if (detail.durationMs !== undefined) {
    lines.push(
      <Text key="duration" dimColor wrap="truncate-end">
        duration: {formatDuration(detail.durationMs)}
      </Text>,
    );
  }
  lines.push(
    <Text key="retries" dimColor wrap="truncate-end">
      retries: {detail.retryCount}
    </Text>,
  );

  // Provenance section
  lines.push(<Text key="prov-gap" />);
  lines.push(
    <Text key="prov-hdr" color="cyan" bold wrap="truncate-end">
      Provenance:
    </Text>,
  );
  lines.push(
    <Text key="prov-trigger" dimColor wrap="truncate-end">
      {`  triggeredBy: ${detail.provenance.triggeredBy}`}
    </Text>,
  );
  lines.push(
    <Text key="prov-ver" dimColor wrap="truncate-end">
      {`  modelVersion: ${detail.provenance.modelVersion}`}
    </Text>,
  );
  lines.push(
    <Text key="prov-hash" dimColor wrap="truncate-end">
      {`  definitionHash: ${detail.provenance.definitionHash}`}
    </Text>,
  );
  if (detail.provenance.workflowId) {
    lines.push(
      <Text key="prov-wf" dimColor wrap="truncate-end">
        {`  workflow: ${detail.provenance.workflowId}`}
      </Text>,
    );
  }
  if (detail.provenance.stepName) {
    lines.push(
      <Text key="prov-step" dimColor wrap="truncate-end">
        {`  step: ${detail.provenance.stepName}`}
      </Text>,
    );
  }

  // Artifacts section
  if (detail.artifacts && detail.artifacts.dataArtifacts.length > 0) {
    lines.push(<Text key="art-gap" />);
    lines.push(
      <Text key="art-hdr" color="cyan" bold wrap="truncate-end">
        Artifacts:
      </Text>,
    );
    for (const a of detail.artifacts.dataArtifacts) {
      lines.push(
        <Text key={`art-${a.dataId}`} dimColor wrap="truncate-end">
          {`  ${a.name} v${a.version}`}
        </Text>,
      );
    }
  }

  // Error section
  if (detail.error) {
    lines.push(<Text key="err-gap" />);
    lines.push(
      <Text key="err-hdr" color="red" bold wrap="truncate-end">Error:</Text>,
    );
    lines.push(
      <Text key="err-msg" color="red" wrap="truncate-end">
        {`  ${detail.error.message}`}
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      {lines}
    </Box>
  );
}

/** Produces plain-text scrollback output for a selected model output. */
function renderOutputScrollback(
  item: ModelOutputSearchItem,
  detail: ModelOutputGetData | undefined,
): string {
  if (!detail) {
    const displayName = item.modelName ?? item.definitionId;
    const lines: string[] = [
      `${displayName} - ${item.methodName} [${item.status}]`,
      `type: ${item.type}`,
      `started: ${item.startedAt}`,
    ];

    if (item.durationMs !== undefined) {
      lines.push(`duration: ${formatDuration(item.durationMs)}`);
    }

    lines.push(`definitionId: ${item.definitionId}`);

    return lines.join("\n");
  }

  const displayName = detail.modelName ?? detail.definitionId;
  const lines: string[] = [
    `${displayName} - ${detail.methodName} [${detail.status}]`,
    `type: ${detail.type}`,
    `started: ${detail.startedAt}`,
  ];

  if (detail.completedAt) {
    lines.push(`completed: ${detail.completedAt}`);
  }
  if (detail.durationMs !== undefined) {
    lines.push(`duration: ${formatDuration(detail.durationMs)}`);
  }
  lines.push(`retries: ${detail.retryCount}`);

  lines.push("");
  lines.push("Provenance:");
  lines.push(`  triggeredBy: ${detail.provenance.triggeredBy}`);
  lines.push(`  modelVersion: ${detail.provenance.modelVersion}`);
  if (detail.provenance.workflowId) {
    lines.push(`  workflow: ${detail.provenance.workflowId}`);
  }
  if (detail.provenance.stepName) {
    lines.push(`  step: ${detail.provenance.stepName}`);
  }

  if (detail.artifacts && detail.artifacts.dataArtifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts:");
    for (const a of detail.artifacts.dataArtifacts) {
      lines.push(`  ${a.name} v${a.version}`);
    }
  }

  if (detail.error) {
    lines.push("");
    lines.push(`Error: ${detail.error.message}`);
  }

  return lines.join("\n");
}
