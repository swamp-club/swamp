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
  _width: number,
  _height: number,
): React.ReactElement {
  if (!detail) {
    // Immediate content from the search item
    const displayName = item.modelName ?? item.definitionId;
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>{displayName}</Text>
        <Text dimColor>type: {item.type}</Text>
        <Text>
          method: <Text color="cyan">{item.methodName}</Text>
        </Text>
        <Text>
          status: <Text color={getStatusColor(item.status)}>{item.status}</Text>
        </Text>
        <Text dimColor>started: {item.startedAt}</Text>
        {item.durationMs !== undefined && (
          <Text dimColor>duration: {formatDuration(item.durationMs)}</Text>
        )}
        <Text dimColor>definitionId: {item.definitionId}</Text>
      </Box>
    );
  }

  // Full detail from fetchPreview
  const displayName = detail.modelName ?? detail.definitionId;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{displayName}</Text>
      <Text dimColor>type: {detail.type}</Text>
      <Text>
        method: <Text color="cyan">{detail.methodName}</Text>
      </Text>
      <Text>
        status:{" "}
        <Text color={getStatusColor(detail.status)}>{detail.status}</Text>
      </Text>
      <Text dimColor>started: {detail.startedAt}</Text>
      {detail.completedAt && (
        <Text dimColor>completed: {detail.completedAt}</Text>
      )}
      {detail.durationMs !== undefined && (
        <Text dimColor>duration: {formatDuration(detail.durationMs)}</Text>
      )}
      <Text dimColor>retries: {detail.retryCount}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>Provenance:</Text>
        <Text dimColor>triggeredBy: {detail.provenance.triggeredBy}</Text>
        <Text dimColor>modelVersion: {detail.provenance.modelVersion}</Text>
        <Text dimColor>
          definitionHash: {detail.provenance.definitionHash}
        </Text>
        {detail.provenance.workflowId && (
          <Text dimColor>workflow: {detail.provenance.workflowId}</Text>
        )}
        {detail.provenance.stepName && (
          <Text dimColor>step: {detail.provenance.stepName}</Text>
        )}
      </Box>

      {detail.artifacts &&
        detail.artifacts.dataArtifacts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>Artifacts:</Text>
          {detail.artifacts.dataArtifacts.map((a) => (
            <Text key={a.dataId} dimColor>
              {"  "}
              {a.name} v{a.version}
            </Text>
          ))}
        </Box>
      )}

      {detail.error && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>Error:</Text>
          <Text color="red">{detail.error.message}</Text>
        </Box>
      )}
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
