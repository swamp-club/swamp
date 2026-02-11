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
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";
import { useScrollableList } from "./hooks/mod.ts";
import { join, relative } from "@std/path";

/**
 * Result of input file selection.
 */
export interface InputFileSelection {
  type: "file" | "skip";
  path?: string;
}

/**
 * Data for displaying input file selection.
 */
export interface InputFileSelectData {
  workflowName: string;
  requiredInputs: string[];
  hasDefaults: boolean;
  searchDir: string;
}

/**
 * A discovered input file candidate.
 */
interface InputFileCandidate {
  path: string;
  relativePath: string;
}

/**
 * Renders input file selection in either interactive or JSON mode.
 *
 * @param data - The data for input file selection
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selection, or undefined if cancelled
 */
export async function renderInputFileSelect(
  data: InputFileSelectData,
  mode: OutputMode,
): Promise<InputFileSelection | undefined> {
  if (mode === "json") {
    // In JSON mode, skip file selection
    return { type: "skip" };
  } else {
    return await renderInteractiveInputFileSelect(data);
  }
}

/**
 * Renders an interactive input file selection UI.
 */
function renderInteractiveInputFileSelect(
  data: InputFileSelectData,
): Promise<InputFileSelection | undefined> {
  return new Promise<InputFileSelection | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <InputFileSelectUI
        workflowName={data.workflowName}
        requiredInputs={data.requiredInputs}
        hasDefaults={data.hasDefaults}
        searchDir={data.searchDir}
        onSelect={(selection) => resolve(selection)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface InputFileSelectUIProps {
  workflowName: string;
  requiredInputs: string[];
  hasDefaults: boolean;
  searchDir: string;
  onSelect: (selection: InputFileSelection) => void;
  onCancel: () => void;
}

/**
 * Interactive input file selection component.
 */
export function InputFileSelectUI(
  props: InputFileSelectUIProps,
): React.ReactElement {
  const {
    workflowName,
    requiredInputs,
    hasDefaults,
    searchDir,
    onSelect,
    onCancel,
  } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<InputFileCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [customPathMode, setCustomPathMode] = useState(false);
  const [customPath, setCustomPath] = useState("");

  // Discover YAML files on mount
  useEffect(() => {
    discoverYamlFiles(searchDir).then((discovered) => {
      setFiles(discovered);
      setLoading(false);
    });
  }, [searchDir]);

  // Create fzf instance for fuzzy searching
  const fzf = useMemo(
    () =>
      new Fzf(files, {
        selector: (item) => item.relativePath,
      }),
    [files],
  );

  // Get filtered results - files matching query
  const fileResults: FzfResultItem<InputFileCandidate>[] = fzf.find(query);

  // Build display items: files + special options
  const displayItems = useMemo(() => {
    const items: DisplayItem[] = fileResults.map((r) => ({
      type: "file" as const,
      file: r.item,
    }));

    // Add "enter custom path" option
    items.push({ type: "custom" as const });

    // Add "skip" option if workflow has defaults for all inputs
    if (hasDefaults || requiredInputs.length === 0) {
      items.push({ type: "skip" as const });
    }

    return items;
  }, [fileResults, hasDefaults, requiredInputs.length]);

  // Use shared scrollable list hook
  const {
    selectedIndex,
    setSelectedIndex,
    visibleItems,
    scrollMetrics,
  } = useScrollableList(displayItems, 10, [query, files]);

  const handleSelect = useCallback(() => {
    if (displayItems.length === 0) return;

    const selected = displayItems[selectedIndex];
    if (selected.type === "file") {
      exit();
      onSelect({ type: "file", path: selected.file.path });
    } else if (selected.type === "custom") {
      setCustomPathMode(true);
    } else if (selected.type === "skip") {
      exit();
      onSelect({ type: "skip" });
    }
  }, [displayItems, selectedIndex, exit, onSelect]);

  const handleCustomPathSubmit = useCallback(() => {
    if (customPath.trim()) {
      exit();
      onSelect({ type: "file", path: customPath.trim() });
    }
  }, [customPath, exit, onSelect]);

  const handleCancel = useCallback(() => {
    if (customPathMode) {
      setCustomPathMode(false);
      setCustomPath("");
    } else {
      exit();
      onCancel();
    }
  }, [customPathMode, exit, onCancel]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      handleCancel();
      return;
    }

    if (customPathMode) {
      if (key.return) {
        handleCustomPathSubmit();
        return;
      }

      if (key.backspace || key.delete) {
        setCustomPath((p) => p.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setCustomPath((p) => p + input);
      }
      return;
    }

    if (key.return) {
      handleSelect();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(displayItems.length - 1, i + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }

    // Handle regular character input
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
    }
  });

  if (customPathMode) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            Enter input file path:
          </Text>
        </Box>
        <Box>
          <Text>{customPath}</Text>
          <Text color="gray">▏</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter: Confirm | Esc: Back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="cyan" bold>
            Select input file for:{" "}
          </Text>
          <Text bold>{workflowName}</Text>
        </Box>
        {requiredInputs.length > 0 && (
          <Box>
            <Text dimColor>
              Required inputs: {requiredInputs.join(", ")}
            </Text>
          </Box>
        )}
      </Box>

      {/* Search input */}
      <Box>
        <Text color="cyan" bold>
          Search:{" "}
        </Text>
        <Text>{query}</Text>
        <Text color="gray">▏</Text>
      </Box>

      {/* Results count */}
      <Box marginTop={1}>
        {loading
          ? <Text dimColor>Scanning for YAML files...</Text>
          : (
            <Text dimColor>
              {fileResults.length} files found
            </Text>
          )}
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleItems.map((item, index) => (
          <DisplayItemRow
            key={item.type === "file" ? item.file.path : item.type}
            item={item}
            isSelected={index + scrollMetrics.moreAboveCount === selectedIndex}
          />
        ))}
        {scrollMetrics.hasMoreBelow && (
          <Text dimColor>... {scrollMetrics.moreBelowCount} more below</Text>
        )}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓: Navigate | Enter: Select | Esc: Back
        </Text>
      </Box>
    </Box>
  );
}

type DisplayItem =
  | { type: "file"; file: InputFileCandidate }
  | { type: "custom" }
  | { type: "skip" };

interface DisplayItemRowProps {
  item: DisplayItem;
  isSelected: boolean;
}

function DisplayItemRow(props: DisplayItemRowProps): React.ReactElement {
  const { item, isSelected } = props;

  const prefix = isSelected ? "▶ " : "  ";
  const color = isSelected ? "green" : undefined;

  if (item.type === "file") {
    return (
      <Box>
        <Text color={color} bold={isSelected}>
          {prefix}
          {item.file.relativePath}
        </Text>
      </Box>
    );
  }

  if (item.type === "custom") {
    return (
      <Box>
        <Text color={isSelected ? "yellow" : "gray"} bold={isSelected}>
          {prefix}
          (Enter custom path...)
        </Text>
      </Box>
    );
  }

  // type === "skip"
  return (
    <Box>
      <Text color={isSelected ? "blue" : "gray"} bold={isSelected}>
        {prefix}
        (Skip - run without input file)
      </Text>
    </Box>
  );
}

/**
 * Discovers YAML files in the given directory and subdirectories.
 * Limits depth to 3 levels to avoid scanning too deep.
 */
async function discoverYamlFiles(
  baseDir: string,
  maxDepth: number = 3,
): Promise<InputFileCandidate[]> {
  const files: InputFileCandidate[] = [];

  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);

        // Skip hidden directories and common non-relevant directories
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        if (entry.name === "vendor") continue;

        if (entry.isDirectory) {
          await scan(fullPath, depth + 1);
        } else if (entry.isFile) {
          if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
            // Skip workflow files and definition files
            if (
              entry.name.startsWith("workflow-") ||
              entry.name.startsWith("definition-")
            ) {
              continue;
            }
            files.push({
              path: fullPath,
              relativePath: relative(baseDir, fullPath),
            });
          }
        }
      }
    } catch {
      // Ignore permission errors or non-existent directories
    }
  }

  await scan(baseDir, 0);

  // Sort by path for consistent ordering
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return files;
}
