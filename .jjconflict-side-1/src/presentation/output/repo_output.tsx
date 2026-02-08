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

// ============================================================================
// Repo Index Output
// ============================================================================

/**
 * Data for repo index rebuild output.
 */
export interface RepoIndexRebuildData {
  path: string;
  modelsIndexed: number;
  workflowsIndexed: number;
  workflowRunsIndexed: number;
}

/**
 * Data for repo index verify output.
 */
export interface RepoIndexVerifyData {
  path: string;
  valid: boolean;
  brokenLinks: string[];
  missingTargets: string[];
}

/**
 * Data for repo index prune output.
 */
export interface RepoIndexPruneData {
  path: string;
  removedLinks: string[];
}

export function renderRepoIndexRebuild(
  data: RepoIndexRebuildData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveRepoIndexRebuild(data);
  }
}

function renderInteractiveRepoIndexRebuild(data: RepoIndexRebuildData): void {
  const { lastFrame } = render(<RepoIndexRebuildDisplay {...data} />);
  console.log(lastFrame());
}

export function renderRepoIndexVerify(
  data: RepoIndexVerifyData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveRepoIndexVerify(data);
  }
}

function renderInteractiveRepoIndexVerify(data: RepoIndexVerifyData): void {
  const { lastFrame } = render(<RepoIndexVerifyDisplay {...data} />);
  console.log(lastFrame());
}

export function renderRepoIndexPrune(
  data: RepoIndexPruneData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveRepoIndexPrune(data);
  }
}

function renderInteractiveRepoIndexPrune(data: RepoIndexPruneData): void {
  const { lastFrame } = render(<RepoIndexPruneDisplay {...data} />);
  console.log(lastFrame());
}

interface RepoIndexRebuildDisplayProps {
  path: string;
  modelsIndexed: number;
  workflowsIndexed: number;
  workflowRunsIndexed: number;
}

export function RepoIndexRebuildDisplay(
  props: RepoIndexRebuildDisplayProps,
): React.ReactElement {
  const total = props.modelsIndexed + props.workflowsIndexed +
    props.workflowRunsIndexed;
  return (
    <Box flexDirection="column">
      <Text color="green">Rebuilt repository index:</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Path:</Text>
          <Text>{props.path}</Text>
        </Text>
        <Text>
          <Text color="cyan">Models:</Text>
          <Text>{props.modelsIndexed}</Text>
        </Text>
        <Text>
          <Text color="cyan">Workflows:</Text>
          <Text>{props.workflowsIndexed}</Text>
        </Text>
        <Text>
          <Text color="cyan">Workflow runs:</Text>
          <Text>{props.workflowRunsIndexed}</Text>
        </Text>
        <Text>
          <Text color="cyan">Total:</Text>
          <Text>{total} entries indexed</Text>
        </Text>
      </Box>
    </Box>
  );
}

interface RepoIndexVerifyDisplayProps {
  path: string;
  valid: boolean;
  brokenLinks: string[];
  missingTargets: string[];
}

export function RepoIndexVerifyDisplay(
  props: RepoIndexVerifyDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={props.valid ? "green" : "red"}>
        Index verification: {props.valid ? "VALID" : "INVALID"}
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Path:</Text>
          <Text>{props.path}</Text>
        </Text>
        {props.brokenLinks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">
              Broken symlinks ({props.brokenLinks.length}):
            </Text>
            {props.brokenLinks.map((link, i) => (
              <Text key={i} color="gray">
                {link}
              </Text>
            ))}
          </Box>
        )}
        {props.valid && <Text color="green">All symlinks are valid.</Text>}
      </Box>
    </Box>
  );
}

interface RepoIndexPruneDisplayProps {
  path: string;
  removedLinks: string[];
}

export function RepoIndexPruneDisplay(
  props: RepoIndexPruneDisplayProps,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">
        Pruned {props.removedLinks.length} broken symlink(s)
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Path:</Text>
          <Text>{props.path}</Text>
        </Text>
        {props.removedLinks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">Removed:</Text>
            {props.removedLinks.map((link, i) => (
              <Text key={i} color="gray">
                {link}
              </Text>
            ))}
          </Box>
        )}
        {props.removedLinks.length === 0 && (
          <Text color="green">No broken symlinks found.</Text>
        )}
      </Box>
    </Box>
  );
}
