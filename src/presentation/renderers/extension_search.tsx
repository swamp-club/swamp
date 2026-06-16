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
  ExtensionSearchEvent,
  ExtensionSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";

const EM_DASH = "\u2014";

export interface ExtensionSearchRenderer
  extends SearchRenderer<ExtensionSearchEvent, ExtensionSearchItem> {
  selectedAction(): "select" | "install" | undefined;
}

class JsonExtensionSearchRenderer implements ExtensionSearchRenderer {
  selectedItem(): ExtensionSearchItem | undefined {
    return undefined;
  }

  selectedAction(): "select" | "install" | undefined {
    return undefined;
  }

  handlers(): EventHandlers<ExtensionSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const output = {
          query: e.data.query,
          extensions: e.data.results.map((ext) => {
            const { platforms, labels, contentTypes, ...rest } = ext;
            return { ...rest, platforms, labels, contentTypes };
          }),
          meta: e.data.meta,
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkExtensionSearchRenderer implements ExtensionSearchRenderer {
  private _selected: ExtensionSearchItem | undefined;
  private _action: "select" | "install" | undefined;

  selectedItem(): ExtensionSearchItem | undefined {
    return this._selected;
  }

  selectedAction(): "select" | "install" | undefined {
    return this._action;
  }

  handlers(): EventHandlers<ExtensionSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<ExtensionSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.description} ${item.labels.join(" ")}`,
          renderExtensionResultLine,
          renderExtensionPreview,
          renderExtensionScrollback,
          "extensions",
          {
            previewKeyFn: (item) => item.name,
            actions: [
              { key: "n", label: "Install", action: "install" },
            ],
          },
        );

        if (result) {
          this._selected = result.item;
          this._action = (result.action as "select" | "install") ?? "select";
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionSearchRenderer(
  mode: OutputMode,
): ExtensionSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionSearchRenderer();
    case "log":
      return new InkExtensionSearchRenderer();
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

const DESCRIPTION_MAX = 60;

function renderExtensionResultLine(
  item: ExtensionSearchItem,
): React.ReactElement {
  const truncatedDesc = item.description.length > DESCRIPTION_MAX
    ? item.description.slice(0, DESCRIPTION_MAX) + "\u2026"
    : item.description;

  const labelsStr = item.labels.length > 0
    ? ` [${item.labels.join(", ")}]`
    : "";
  const deprecated = item.deprecatedAt != null;
  return (
    <Text>
      {`${item.name} `}
      <Text dimColor>{`v${item.latestVersion}`}</Text>
      {deprecated && <Text color="yellow">[deprecated]</Text>}
      {truncatedDesc && <Text dimColor>{` ${EM_DASH} ${truncatedDesc}`}</Text>}
      {labelsStr && <Text color="blue">{labelsStr}</Text>}
    </Text>
  );
}

function renderExtensionPreview(
  item: ExtensionSearchItem,
  _detail: ExtensionSearchItem | undefined,
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  const lines: React.ReactElement[] = [
    <Text key="name" wrap="truncate-end">
      <Text color="cyan" bold>{item.name}</Text>{" "}
      <Text dimColor>v{item.latestVersion}</Text>
    </Text>,
  ];

  if (item.description) {
    lines.push(<Text key="desc-gap" />);
    lines.push(
      <Text key="desc" wrap="truncate-end">{item.description}</Text>,
    );
  }

  if (item.platforms.length > 0) {
    lines.push(<Text key="plat-gap" />);
    lines.push(
      <Text key="platforms" wrap="truncate-end">
        <Text bold>Platforms:</Text> {item.platforms.join(", ")}
      </Text>,
    );
  }

  if (item.labels.length > 0) {
    lines.push(<Text key="label-gap" />);
    lines.push(
      <Text key="labels" wrap="truncate-end">
        <Text bold>Labels:</Text> {item.labels.join(", ")}
      </Text>,
    );
  }

  if (item.contentTypes.length > 0) {
    lines.push(<Text key="ct-gap" />);
    lines.push(
      <Text key="contentTypes" wrap="truncate-end">
        <Text bold>Content Types:</Text> {item.contentTypes.join(", ")}
      </Text>,
    );
  }

  if (item.repository) {
    lines.push(<Text key="repo-gap" />);
    lines.push(
      <Text key="repo" wrap="truncate-end">
        <Text bold>Repository:</Text> {item.repository}
        {item.repositoryVerified && (
          <>
            {" "}
            <Text color="green">(verified)</Text>
          </>
        )}
      </Text>,
    );
  }

  if (item.deprecatedAt != null) {
    lines.push(<Text key="dep-gap" />);
    lines.push(
      <Text key="deprecated" color="yellow" wrap="truncate-end">
        <Text bold>Deprecated:</Text>{" "}
        {item.deprecationReason ?? "No reason given"}
      </Text>,
    );
    if (item.supersededBy) {
      lines.push(
        <Text key="successor" color="yellow" wrap="truncate-end">
          <Text bold>Superseded by:</Text> {item.supersededBy}
        </Text>,
      );
    }
  }

  lines.push(<Text key="dates-gap" />);
  lines.push(
    <Text key="created" dimColor wrap="truncate-end">
      Created: {item.createdAt}
    </Text>,
  );
  lines.push(
    <Text key="updated" dimColor wrap="truncate-end">
      Updated: {item.updatedAt}
    </Text>,
  );

  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      {lines}
    </Box>
  );
}

function renderExtensionScrollback(
  item: ExtensionSearchItem,
  _detail: ExtensionSearchItem | undefined,
): string {
  const lines: string[] = [
    `${item.name} v${item.latestVersion}`,
  ];

  if (item.description) {
    lines.push(item.description);
  }

  if (item.platforms.length > 0) {
    lines.push(`Platforms: ${item.platforms.join(", ")}`);
  }

  if (item.labels.length > 0) {
    lines.push(`Labels: ${item.labels.join(", ")}`);
  }

  if (item.contentTypes.length > 0) {
    lines.push(`Content Types: ${item.contentTypes.join(", ")}`);
  }

  if (item.repository) {
    const verified = item.repositoryVerified ? " (verified)" : "";
    lines.push(`Repository: ${item.repository}${verified}`);
  }

  if (item.deprecatedAt != null) {
    lines.push(
      `Deprecated: ${item.deprecationReason ?? "No reason given"}`,
    );
    if (item.supersededBy) {
      lines.push(`Superseded by: ${item.supersededBy}`);
    }
  }

  return lines.join("\n");
}
