import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["repo"]);

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

export function renderRepoInit(data: RepoInitData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Initialized swamp repository at ${data.path}`;
  }
}

export function renderRepoUpgrade(
  data: RepoUpgradeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger
      .info`Upgraded swamp repository: ${data.previousVersion} \u2192 ${data.newVersion}`;
  }
}

export function renderRepoIndexRebuild(
  data: RepoIndexRebuildData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const total = data.modelsIndexed + data.workflowsIndexed +
      data.workflowRunsIndexed;
    logger.info`Rebuilt repository index: ${total} entries indexed`;
  }
}

export function renderRepoIndexVerify(
  data: RepoIndexVerifyData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const status = data.valid ? "VALID" : "INVALID";
    logger.info`Index verification: ${status}`;
  }
}

export function renderRepoIndexPrune(
  data: RepoIndexPruneData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Pruned ${data.removedLinks.length} broken symlink(s)`;
  }
}
