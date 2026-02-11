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
import { ensureDir } from "@std/fs";
import type { RepoPath } from "./repo_path.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { SwampVersion } from "./swamp_version.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { SkillAssets } from "../../infrastructure/assets/skill_assets.ts";
import { UserError } from "../errors.ts";

const CLAUDE_MD_FILENAME = "CLAUDE.md";

/**
 * Result of a repository initialization operation.
 */
export interface RepoInitResult {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  claudeMdCreated: boolean;
  claudeSettingsCreated: boolean;
}

/**
 * Result of a repository upgrade operation.
 */
export interface RepoUpgradeResult {
  path: string;
  previousVersion: string;
  newVersion: string;
  upgradedAt: string;
  skillsUpdated: string[];
  claudeSettingsUpdated: boolean;
}

/**
 * Options for initialization.
 */
export interface RepoInitOptions {
  force?: boolean;
}

/**
 * RepoService handles repository initialization and upgrade operations.
 */
export class RepoService {
  private readonly markerRepo: RepoMarkerRepository;
  private readonly skillAssets: SkillAssets;
  private readonly currentVersion: SwampVersion;

  constructor(version: string) {
    this.markerRepo = new RepoMarkerRepository();
    this.skillAssets = new SkillAssets();
    this.currentVersion = SwampVersion.create(version);
  }

  /**
   * Checks if a path is already initialized as a swamp repository.
   */
  isInitialized(repoPath: RepoPath): Promise<boolean> {
    return this.markerRepo.exists(repoPath);
  }

  /**
   * Initializes a new swamp repository.
   *
   * @param repoPath - The path to initialize
   * @param options - Initialization options
   * @throws Error if already initialized and force is not set
   */
  async init(
    repoPath: RepoPath,
    options: RepoInitOptions = {},
  ): Promise<RepoInitResult> {
    const isAlreadyInit = await this.isInitialized(repoPath);

    if (isAlreadyInit && !options.force) {
      throw new UserError(
        `Repository already initialized at ${repoPath.value}. Use --force to reinitialize.`,
      );
    }

    // Ensure the directory exists
    await ensureDir(repoPath.value);

    // Create marker file
    const markerData = this.markerRepo.createInitMarker(this.currentVersion);
    await this.markerRepo.write(repoPath, markerData);

    // Create data directory structure
    await this.createDataDirectoryStructure(repoPath);

    // Copy skills
    const skillsDir = join(repoPath.value, ".claude", "skills");
    await this.skillAssets.copySkillsTo(skillsDir);
    const skillsCopied = this.skillAssets.getSkillNames();

    // Create CLAUDE.md if it doesn't exist
    const claudeMdCreated = await this.createClaudeMdIfNotExists(repoPath);

    // Create Claude settings.local.json if it doesn't exist
    const claudeSettingsCreated = await this.createClaudeSettingsIfNotExists(
      repoPath,
    );

    return {
      path: repoPath.value,
      version: this.currentVersion.toString(),
      initializedAt: markerData.initializedAt,
      skillsCopied,
      claudeMdCreated,
      claudeSettingsCreated,
    };
  }

  /**
   * Upgrades an existing swamp repository.
   *
   * @param repoPath - The path to upgrade
   * @throws Error if not initialized
   */
  async upgrade(repoPath: RepoPath): Promise<RepoUpgradeResult> {
    const existingMarker = await this.markerRepo.read(repoPath);

    if (!existingMarker) {
      throw new UserError(
        `Not a swamp repository: ${repoPath.value}. Run 'swamp repo init' first.`,
      );
    }

    const previousVersion = existingMarker.swampVersion;

    // Update marker with new version
    const updatedMarker = this.markerRepo.createUpgradeMarker(
      existingMarker,
      this.currentVersion,
    );
    await this.markerRepo.write(repoPath, updatedMarker);

    // Update skills
    const skillsDir = join(repoPath.value, ".claude", "skills");
    await this.skillAssets.copySkillsTo(skillsDir);
    const skillsUpdated = this.skillAssets.getSkillNames();

    // Update Claude settings.local.json (merge new permissions)
    const claudeSettingsUpdated = await this.updateClaudeSettings(repoPath);

    // createUpgradeMarker always sets upgradedAt, but TypeScript doesn't know this
    if (!updatedMarker.upgradedAt) {
      throw new Error(
        "Internal error: upgradedAt was not set by createUpgradeMarker",
      );
    }

    return {
      path: repoPath.value,
      previousVersion,
      newVersion: this.currentVersion.toString(),
      upgradedAt: updatedMarker.upgradedAt,
      skillsUpdated,
      claudeSettingsUpdated,
    };
  }

  /**
   * Gets the current marker data for a repository.
   */
  getMarker(repoPath: RepoPath): Promise<RepoMarkerData | null> {
    return this.markerRepo.read(repoPath);
  }

  /**
   * Creates CLAUDE.md if it doesn't already exist.
   */
  private async createClaudeMdIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const claudeMdPath = join(repoPath.value, CLAUDE_MD_FILENAME);

    try {
      await Deno.stat(claudeMdPath);
      // File exists, don't overwrite
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Create the file
        const content = this.generateClaudeMdContent();
        await Deno.writeTextFile(claudeMdPath, content);
        return true;
      }
      throw error;
    }
  }

  /**
   * Generates the content for CLAUDE.md.
   */
  private generateClaudeMdContent(): string {
    return `# Project

This repository is managed with [swamp](https://github.com/systeminit/swamp).

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- \`swamp-model\` - Work with swamp models (creating, editing, validating)
- \`swamp-workflow\` - Work with workflows (creating, editing, running)
- \`swamp-vault\` - Manage secrets and credentials
- \`swamp-data\` - Manage model data lifecycle
- \`swamp-repo\` - Repository management

## Getting Started

Always start by using the \`swamp-model\` skill to work with swamp models.

## Commands

Use \`swamp --help\` to see available commands.
`;
  }

  /**
   * Gets the list of allowed swamp commands for Claude settings.
   */
  private getClaudeAllowedCommands(): string[] {
    return [
      "Bash(swamp model type search:*)",
      "Bash(swamp model type describe:*)",
      "Bash(swamp model search:*)",
      "Bash(swamp model create:*)",
      "Bash(swamp model edit:*)",
      "Bash(swamp model delete:*)",
      "Bash(swamp model get:*)",
      "Bash(swamp model validate:*)",
      "Bash(swamp model output:*)",
      "Bash(swamp model method history:*)",
      "Bash(swamp workflow search:*)",
      "Bash(swamp workflow create:*)",
      "Bash(swamp workflow edit:*)",
      "Bash(swamp workflow delete:*)",
      "Bash(swamp workflow get:*)",
      "Bash(swamp workflow validate:*)",
      "Bash(swamp workflow schema:*)",
      "Bash(swamp workflow history:*)",
      "Bash(swamp vault:*)",
      "Bash(swamp data:*)",
      "Bash(swamp repo:*)",
      "Bash(swamp telemetry:*)",
      "Bash(swamp init:*)",
      "Bash(swamp version:*)",
      "Bash(swamp completions:*)",
    ];
  }

  /**
   * Generates the content for settings.local.json.
   */
  private generateClaudeSettingsContent(): string {
    const settings = {
      permissions: {
        allow: this.getClaudeAllowedCommands(),
      },
    };
    return JSON.stringify(settings, null, 2) + "\n";
  }

  /**
   * Creates settings.local.json if it doesn't already exist.
   */
  private async createClaudeSettingsIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const claudeDir = join(repoPath.value, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");

    try {
      await Deno.stat(settingsPath);
      // File exists, don't overwrite
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Ensure .claude directory exists
        await ensureDir(claudeDir);
        // Create the file
        const content = this.generateClaudeSettingsContent();
        await Deno.writeTextFile(settingsPath, content);
        return true;
      }
      throw error;
    }
  }

  /**
   * Updates settings.local.json, merging new permissions with existing ones.
   * If the file doesn't exist, it creates it.
   */
  private async updateClaudeSettings(repoPath: RepoPath): Promise<boolean> {
    const claudeDir = join(repoPath.value, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");

    // Ensure .claude directory exists
    await ensureDir(claudeDir);

    let existingSettings: { permissions?: { allow?: string[] } } = {};
    let settingsExisted = false;

    try {
      const content = await Deno.readTextFile(settingsPath);
      existingSettings = JSON.parse(content);
      settingsExisted = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      // File doesn't exist, will create new
    }

    // Get our allowed commands
    const ourCommands = this.getClaudeAllowedCommands();

    // Merge with existing permissions
    const existingAllow = existingSettings.permissions?.allow ?? [];
    const mergedAllow = [...new Set([...existingAllow, ...ourCommands])];

    // Check if anything changed
    const hasChanges = mergedAllow.length !== existingAllow.length ||
      !ourCommands.every((cmd) => existingAllow.includes(cmd));

    if (!hasChanges && settingsExisted) {
      return false;
    }

    // Write merged settings
    const newSettings = {
      ...existingSettings,
      permissions: {
        ...existingSettings.permissions,
        allow: mergedAllow,
      },
    };
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify(newSettings, null, 2) + "\n",
    );
    return true;
  }

  /**
   * Creates the data directory structure for storing repository artifacts.
   */
  private async createDataDirectoryStructure(
    repoPath: RepoPath,
  ): Promise<void> {
    const subdirs = [
      SWAMP_SUBDIRS.workflows,
      SWAMP_SUBDIRS.data,
      SWAMP_SUBDIRS.outputs,
      SWAMP_SUBDIRS.workflowRuns,
      SWAMP_SUBDIRS.workflowsEvaluated,
      SWAMP_SUBDIRS.definitions,
      SWAMP_SUBDIRS.definitionsEvaluated,
      SWAMP_SUBDIRS.vault,
      SWAMP_SUBDIRS.secrets,
      SWAMP_SUBDIRS.telemetry,
    ];

    for (const subdir of subdirs) {
      await ensureDir(swampPath(repoPath.value, subdir));
    }
  }
}
