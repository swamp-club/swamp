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

import { join } from "@std/path";

/**
 * Central constants for swamp data storage paths.
 *
 * All code that references the .swamp directory should use these constants
 * to ensure consistency and make future path changes easier.
 */

/** The main data directory name (hidden directory in repo root) */
export const SWAMP_DATA_DIR = ".swamp";

/** The marker file name for initialized repositories */
export const SWAMP_MARKER_FILE = ".swamp.yaml";

/**
 * Subdirectory names within the .swamp directory.
 */
export const SWAMP_SUBDIRS = {
  /** Model and resource definitions */
  definitions: "definitions",
  /** Evaluated definitions with resolved expressions */
  definitionsEvaluated: "definitions-evaluated",
  /** Workflow definitions */
  workflows: "workflows",
  /** Evaluated workflows */
  workflowsEvaluated: "workflows-evaluated",
  /** Workflow execution runs */
  workflowRuns: "workflow-runs",
  /** Method execution outputs */
  outputs: "outputs",
  /** Unified data storage (resources, logs, files) */
  data: "data",
  /** Vault configurations */
  vault: "vault",
  /** Encrypted secrets for local vaults */
  secrets: "secrets",
  /** Telemetry data */
  telemetry: "telemetry",
  /** Log files */
  logs: "logs",
  /** Arbitrary files */
  files: "files",
  /** Legacy: input definitions (now use definitions) */
  inputs: "inputs",
  /** Legacy: evaluated inputs */
  inputsEvaluated: "inputs-evaluated",
  /** Legacy: resource definitions */
  resources: "resources",
} as const;

/**
 * Constructs a path within the .swamp data directory.
 *
 * @param repoDir - The repository root directory
 * @param segments - Path segments to join after .swamp/
 * @returns The full path
 *
 * @example
 * swampPath("/repo", "definitions", "aws/ec2", "my-vpc.yaml")
 * // Returns: "/repo/.swamp/definitions/aws/ec2/my-vpc.yaml"
 */
export function swampPath(repoDir: string, ...segments: string[]): string {
  return join(repoDir, SWAMP_DATA_DIR, ...segments);
}

/**
 * Constructs the path to the repository marker file.
 *
 * @param repoDir - The repository root directory
 * @returns The full path to .swamp.yaml
 */
export function swampMarkerPath(repoDir: string): string {
  return join(repoDir, SWAMP_MARKER_FILE);
}
