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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";

const logger = getSwampLogger(["extension", "push"]);

/** Data for showing resolved extension contents before push. */
export interface ExtensionPushResolvedData {
  name: string;
  version: string;
  description: string | undefined;
  repository: string | undefined;
  modelFiles: string[];
  workflowFiles: string[];
  vaultFiles: string[];
  additionalFiles: string[];
  platforms: string[];
  labels: string[];
  dependencies: string[];
}

/** Data for successful push output. */
export interface ExtensionPushSuccessData {
  name: string;
  version: string;
  extensionId: string;
  archiveSize: number;
  modelCount: number;
  workflowCount: number;
  bundleCount: number;
  vaultCount: number;
}

/** Data for compilation error output. */
export interface CompilationError {
  file: string;
  error: string;
}

/**
 * Renders the resolved extension contents before push.
 */
export function renderExtensionPushResolved(
  data: ExtensionPushResolvedData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Extension: ${data.name}@${data.version}`;
    if (data.description) {
      logger.info`Description: ${data.description}`;
    }
    if (data.repository) {
      logger.info`Repository: ${data.repository}`;
    }
    if (data.modelFiles.length > 0) {
      logger.info`Models (${data.modelFiles.length}):`;
      for (const f of data.modelFiles) {
        logger.info`  ${f}`;
      }
    }
    if (data.workflowFiles.length > 0) {
      logger.info`Workflows (${data.workflowFiles.length}):`;
      for (const f of data.workflowFiles) {
        logger.info`  ${f}`;
      }
    }
    if (data.vaultFiles.length > 0) {
      logger.info`Vaults (${data.vaultFiles.length}):`;
      for (const f of data.vaultFiles) {
        logger.info`  ${f}`;
      }
    }
    if (data.additionalFiles.length > 0) {
      logger.info`Additional files (${data.additionalFiles.length}):`;
      for (const f of data.additionalFiles) {
        logger.info`  ${f}`;
      }
    }
    if (data.platforms.length > 0) {
      logger.info`Platforms: ${data.platforms.join(", ")}`;
    }
    if (data.labels.length > 0) {
      logger.info`Labels: ${data.labels.join(", ")}`;
    }
    if (data.dependencies.length > 0) {
      logger.info`Dependencies: ${data.dependencies.join(", ")}`;
    }
  }
}

/**
 * Renders safety warnings.
 */
export function renderExtensionPushSafetyWarnings(
  warnings: SafetyIssue[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ warnings }, null, 2));
  } else {
    logger.warn`Safety warnings:`;
    for (const w of warnings) {
      logger.warn`  ${w.file}: ${w.message}`;
    }
  }
}

/**
 * Renders safety errors.
 */
export function renderExtensionPushSafetyErrors(
  errors: SafetyIssue[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ errors }, null, 2));
  } else {
    logger.error`Safety errors (push blocked):`;
    for (const e of errors) {
      logger.error`  ${e.file}: ${e.message}`;
    }
  }
}

/**
 * Renders successful push result.
 */
export function renderExtensionPush(
  data: ExtensionPushSuccessData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Pushed ${data.name}@${data.version}`;
    logger.info`Extension ID: ${data.extensionId}`;
    logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    logger
      .info`Models: ${data.modelCount}, Workflows: ${data.workflowCount}, Vaults: ${data.vaultCount}, Bundles: ${data.bundleCount}`;
  }
}

/**
 * Renders cancellation message.
 */
export function renderExtensionPushCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    logger.info("Push cancelled.");
  }
}

/**
 * Renders compilation errors.
 */
export function renderExtensionPushCompilationErrors(
  results: CompilationError[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ compilationErrors: results }, null, 2));
  } else {
    logger.error`Bundle compilation failed:`;
    for (const r of results) {
      logger.error`  ${r.file}: ${r.error}`;
    }
  }
}

/**
 * Renders dry-run completion message.
 */
export function renderExtensionPushDryRun(
  data: { name: string; version: string; archiveSize: number },
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ ...data, status: "dry_run" }, null, 2));
  } else {
    logger.info`Dry run complete for ${data.name}@${data.version}`;
    logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    logger.info("No API calls were made.");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
