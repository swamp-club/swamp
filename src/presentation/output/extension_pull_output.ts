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

const logger = getSwampLogger(["extension", "pull"]);

/** Data for showing resolved extension info before pull. */
export interface ExtensionPullResolvedData {
  name: string;
  version: string;
  description: string | undefined;
}

/** Data for successful pull output. */
export interface ExtensionPullSuccessData {
  name: string;
  version: string;
  extractedFiles: string[];
}

/**
 * Renders the resolved extension info before pull.
 */
export function renderExtensionPullResolved(
  data: ExtensionPullResolvedData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Pulling ${data.name}@${data.version}`;
    if (data.description) {
      logger.info`Description: ${data.description}`;
    }
  }
}

/**
 * Renders successful pull result.
 */
export function renderExtensionPull(
  data: ExtensionPullSuccessData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Pulled ${data.name}@${data.version}`;
    logger.info`Extracted ${data.extractedFiles.length} files:`;
    for (const f of data.extractedFiles) {
      logger.info`  ${f}`;
    }
  }
}

/**
 * Renders file conflict list.
 */
export function renderExtensionPullConflicts(
  conflicts: string[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ conflicts }, null, 2));
  } else {
    logger.warn`The following files already exist and will be overwritten:`;
    for (const c of conflicts) {
      logger.warn`  ${c}`;
    }
  }
}

/**
 * Renders cancellation message.
 */
export function renderExtensionPullCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    logger.info("Pull cancelled.");
  }
}

/**
 * Renders dependency pull message.
 */
export function renderExtensionPullDependencyPull(
  name: string,
  version: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ status: "pulling_dependency", name, version }, null, 2),
    );
  } else {
    logger.info`Pulling dependency ${name}@${version}`;
  }
}

/**
 * Renders safety errors.
 */
export function renderExtensionPullSafetyErrors(
  errors: SafetyIssue[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ errors }, null, 2));
  } else {
    logger.error`Safety errors (pull blocked):`;
    for (const e of errors) {
      logger.error`  ${e.file}: ${e.message}`;
    }
  }
}

/**
 * Renders safety warnings.
 */
export function renderExtensionPullSafetyWarnings(
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
