// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data for repo init output.
 */
export interface RepoInitData {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  claudeMdCreated: boolean;
}

/**
 * Data for repo upgrade output.
 */
export interface RepoUpgradeData {
  path: string;
  previousVersion: string;
  newVersion: string;
  upgradedAt: string;
  skillsUpdated: string[];
}

export function renderRepoInit(data: RepoInitData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveRepoInit(data);
  }
}

function renderInteractiveRepoInit(data: RepoInitData): void {
  const { lastFrame } = render(<RepoInitDisplay {...data} />);
  console.log(lastFrame());
}

export function renderRepoUpgrade(
  data: RepoUpgradeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveRepoUpgrade(data);
  }
}

function renderInteractiveRepoUpgrade(data: RepoUpgradeData): void {
  const { lastFrame } = render(<RepoUpgradeDisplay {...data} />);
  console.log(lastFrame());
}

interface RepoInitDisplayProps {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  claudeMdCreated: boolean;
}

export function RepoInitDisplay(
  props: RepoInitDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Initialized swamp repository:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Path:</Text>
          <Text>{props.path}</Text>
        </Text>
        <Text>
          <Text color="cyan">Version:</Text>
          <Text>{props.version}</Text>
        </Text>
        <Text>
          <Text color="cyan">Skills:</Text>
          <Text>{props.skillsCopied.join(", ")}</Text>
        </Text>
        {props.claudeMdCreated && (
          <Text>
            <Text color="cyan">Created:</Text>
            <Text>CLAUDE.md</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

interface RepoUpgradeDisplayProps {
  path: string;
  previousVersion: string;
  newVersion: string;
  upgradedAt: string;
  skillsUpdated: string[];
}

export function RepoUpgradeDisplay(
  props: RepoUpgradeDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">Upgraded swamp repository:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Path:</Text>
          <Text>{props.path}</Text>
        </Text>
        <Text>
          <Text color="cyan">Version:</Text>
          <Text>
            {props.previousVersion} → {props.newVersion}
          </Text>
        </Text>
        <Text>
          <Text color="cyan">Skills updated:</Text>
          <Text>{props.skillsUpdated.join(", ")}</Text>
        </Text>
      </Box>
    </Box>
  );
}
