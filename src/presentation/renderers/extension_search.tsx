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
import { Box, render, Text, useApp, useInput } from "ink";
import type {
  EventHandlers,
  ExtensionSearchEvent,
  ExtensionSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";
import { suppressInkTtyErrors } from "../output/ink_lifecycle.ts";

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
          results: e.data.results.map((ext) => {
            const { platforms, labels, contentTypes, ...rest } = ext;
            return {
              ...rest,
              ...(platforms.length > 0 ? { platforms } : {}),
              ...(labels.length > 0 ? { labels } : {}),
              ...(contentTypes.length > 0 ? { contentTypes } : {}),
            };
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

/**
 * Extension detail view with action selection (Enter: Select, i: Install, Esc: Back).
 * Matches the pre-migration UX where selecting an extension shows details
 * before committing to an action.
 */
interface ExtensionDetailViewProps {
  extension: ExtensionSearchItem;
  onAction: (action: "select" | "install") => void;
  onBack: () => void;
}

function ExtensionDetailView(
  props: ExtensionDetailViewProps,
): React.ReactElement {
  const { extension, onAction, onBack } = props;
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onBack();
      return;
    }
    if (key.return) {
      exit();
      onAction("select");
      return;
    }
    if (input === "i" && !key.ctrl && !key.meta) {
      exit();
      onAction("install");
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{extension.name}</Text>
        <Text dimColor>{` v${extension.latestVersion}`}</Text>
      </Box>

      {extension.description && (
        <Box marginTop={1}>
          <Text>{extension.description}</Text>
        </Box>
      )}

      {extension.platforms.length > 0 && (
        <Box marginTop={1}>
          <Text bold>{`Platforms: ${extension.platforms.join(", ")}`}</Text>
        </Box>
      )}

      {extension.labels.length > 0 && (
        <Box marginTop={1}>
          <Text bold>{`Labels: ${extension.labels.join(", ")}`}</Text>
        </Box>
      )}

      {extension.contentTypes.length > 0 && (
        <Box marginTop={1}>
          <Text bold>
            {`Content Types: ${extension.contentTypes.join(", ")}`}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold>{`Created: ${extension.createdAt}`}</Text>
      </Box>

      <Box>
        <Text bold>{`Updated: ${extension.updatedAt}`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter: Select | i: Install | Esc: Back</Text>
      </Box>
    </Box>
  );
}

/**
 * Two-phase detail view: shows extension details and lets the user choose
 * "select" (Enter) or "install" (i), or go back (Esc).
 *
 * When the user goes back, returns `undefined` so the caller can re-launch the
 * search TUI.
 */
function renderExtensionAction(
  extension: ExtensionSearchItem,
): Promise<"select" | "install" | undefined> {
  return new Promise<"select" | "install" | undefined>((resolve) => {
    const cleanupTty = suppressInkTtyErrors();
    const { waitUntilExit, unmount } = render(
      <ExtensionDetailView
        extension={extension}
        onAction={(action) => {
          cleanupTty();
          resolve(action);
        }}
        onBack={() => {
          cleanupTty();
          unmount();
          resolve(undefined);
        }}
      />,
    );
    waitUntilExit().catch(() => {});
  });
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
        // Loop: search → detail → back returns to search
        while (true) {
          const selected = await renderInteractiveSearch<ExtensionSearchItem>(
            e.data.results,
            e.data.query,
            (item) =>
              `${item.name} ${item.description} ${item.labels.join(" ")}`,
            (item, isSelected) => {
              const descriptionMax = 60;
              const truncatedDesc = item.description.length > descriptionMax
                ? item.description.slice(0, descriptionMax) + "\u2026"
                : item.description;

              return (
                <Box>
                  <Text
                    color={isSelected ? "green" : undefined}
                    bold={isSelected}
                  >
                    {isSelected ? "\u25B6 " : "  "}
                    {item.name}
                  </Text>
                  <Text dimColor>
                    {` v${item.latestVersion}`}
                  </Text>
                  {truncatedDesc && (
                    <Text dimColor>
                      {` \u2014 ${truncatedDesc}`}
                    </Text>
                  )}
                  {item.labels.length > 0 && (
                    <Text color="blue">
                      {` [${item.labels.join(", ")}]`}
                    </Text>
                  )}
                </Box>
              );
            },
            "extensions",
          );

          if (!selected) {
            // User cancelled the search
            return;
          }

          // Show detail view with action selection
          const action = await renderExtensionAction(selected);
          if (action) {
            this._selected = selected;
            this._action = action;
            return;
          }
          // action === undefined means "back" — loop to re-show search
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
