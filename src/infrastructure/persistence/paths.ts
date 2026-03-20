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

import { isAbsolute, join, relative } from "@std/path";

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
  /** Cached extension bundles */
  bundles: "bundles",
  /** Cached vault extension bundles */
  vaultBundles: "vault-bundles",
  /** Cached driver extension bundles */
  driverBundles: "driver-bundles",
  /** Cached datastore extension bundles */
  datastoreBundles: "datastore-bundles",
  /** Cached report extension bundles */
  reportBundles: "report-bundles",
  /** Audit command logs */
  audit: "audit",
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

/**
 * Converts an absolute path to a relative path from the repository root.
 *
 * Used when persisting paths to YAML files so they work across different
 * users and machines. If the path is already relative, returns it unchanged.
 *
 * @param repoDir - The repository root directory
 * @param absolutePath - The absolute path to convert
 * @returns The relative path from repoDir
 */
export function toRelativePath(repoDir: string, absolutePath: string): string {
  if (!isAbsolute(absolutePath)) {
    return absolutePath; // Already relative
  }
  return relative(repoDir, absolutePath);
}

/**
 * Converts a relative path to an absolute path from the repository root.
 *
 * Used when loading paths from YAML files to reconstruct the full path
 * for the current machine. If the path is already absolute, returns it
 * unchanged for backwards compatibility with existing data.
 *
 * @param repoDir - The repository root directory
 * @param relativePath - The relative path to convert
 * @returns The absolute path
 */
export function toAbsolutePath(repoDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return relativePath; // Backwards compat: already absolute
  }
  return join(repoDir, relativePath);
}

/**
 * Returns the user-level swamp data directory (`~/.swamp/`).
 *
 * This directory stores operational data like installed binaries and
 * downloaded source code. Distinct from the XDG config directory which
 * stores identity and auth configuration.
 *
 * @returns The absolute path to the ~/.swamp directory
 * @throws Error if HOME environment variable is not set
 */
export function getSwampDataDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory (HOME/USERPROFILE not set)",
    );
  }
  return join(home, ".swamp");
}

/**
 * Returns the user-level swamp configuration directory.
 *
 * Follows the XDG Base Directory specification:
 * - Uses `$XDG_CONFIG_HOME/swamp/` if `XDG_CONFIG_HOME` is set
 * - Falls back to `~/.config/swamp/`
 *
 * @returns The absolute path to the swamp config directory
 * @throws Error if HOME environment variable is not set
 */
export function getSwampConfigDir(): string {
  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
  if (xdgConfigHome) {
    return join(xdgConfigHome, "swamp");
  }

  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error("HOME environment variable is not set");
  }
  return join(home, ".config", "swamp");
}
