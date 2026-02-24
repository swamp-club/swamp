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
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import type { RepoPath } from "./repo_path.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { SwampVersion } from "./swamp_version.ts";
import {
  type AiTool,
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { SkillAssets } from "../../infrastructure/assets/skill_assets.ts";
import { UserError } from "../errors.ts";

export type { AiTool } from "../../infrastructure/persistence/repo_marker_repository.ts";

const GITIGNORE_FILENAME = ".gitignore";

const SKILL_DIRS: Record<AiTool, string> = {
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
};

const INSTRUCTIONS_FILES: Record<AiTool, string> = {
  claude: "CLAUDE.md",
  cursor: ".cursor/rules/swamp.mdc",
  opencode: "AGENTS.md",
  codex: "AGENTS.md",
};

const GITIGNORE_TOOL_ENTRIES: Record<AiTool, string> = {
  claude: "# Claude Code configuration (managed by swamp)\n.claude/",
  cursor: "# Cursor skills (managed by swamp)\n.cursor/skills/",
  opencode: "# Agent skills (managed by swamp)\n.agents/skills/",
  codex: "# Agent skills (managed by swamp)\n.agents/skills/",
};

/**
 * Result of a repository initialization operation.
 */
export interface RepoInitResult {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  instructionsFileCreated: boolean;
  settingsCreated: boolean;
  gitignoreCreated: boolean;
  tool: AiTool;
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
  settingsUpdated: boolean;
  gitignoreCreated: boolean;
  tool: AiTool;
}

/**
 * Options for initialization.
 */
export interface RepoInitOptions {
  force?: boolean;
  tool?: AiTool;
}

/**
 * Options for upgrade.
 */
export interface RepoUpgradeOptions {
  tool?: AiTool;
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
    const tool = options.tool ?? "claude";
    const isAlreadyInit = await this.isInitialized(repoPath);

    if (isAlreadyInit && !options.force) {
      throw new UserError(
        `Repository already initialized at ${repoPath.value}. Use --force to reinitialize.`,
      );
    }

    // Ensure the directory exists
    await ensureDir(repoPath.value);

    // Create marker file with tool choice
    const markerData = this.markerRepo.createInitMarker(this.currentVersion);
    markerData.tool = tool;
    await this.markerRepo.write(repoPath, markerData);

    // Create data directory structure
    await this.createDataDirectoryStructure(repoPath);

    // Copy skills to tool-appropriate directory
    const skillsDir = join(repoPath.value, SKILL_DIRS[tool]);
    await this.skillAssets.copySkillsTo(skillsDir);
    const skillsCopied = this.skillAssets.getSkillNames();

    // Create instructions file if it doesn't exist
    const instructionsFileCreated = await this
      .createInstructionsFileIfNotExists(repoPath, tool);

    // Create Claude settings.local.json only for Claude
    let settingsCreated = false;
    if (tool === "claude") {
      settingsCreated = await this.createClaudeSettingsIfNotExists(repoPath);
    }

    // Create .gitignore if it doesn't exist
    const gitignoreCreated = await this.createGitignoreIfNotExists(
      repoPath,
      tool,
    );

    return {
      path: repoPath.value,
      version: this.currentVersion.toString(),
      initializedAt: markerData.initializedAt,
      skillsCopied,
      instructionsFileCreated,
      settingsCreated,
      gitignoreCreated,
      tool,
    };
  }

  /**
   * Upgrades an existing swamp repository.
   *
   * @param repoPath - The path to upgrade
   * @param options - Upgrade options
   * @throws Error if not initialized
   */
  async upgrade(
    repoPath: RepoPath,
    options: RepoUpgradeOptions = {},
  ): Promise<RepoUpgradeResult> {
    const existingMarker = await this.markerRepo.read(repoPath);

    if (!existingMarker) {
      throw new UserError(
        `Not a swamp repository: ${repoPath.value}. Run 'swamp repo init' first.`,
      );
    }

    // Determine tool: CLI override > stored marker > default "claude"
    const tool = options.tool ?? existingMarker.tool ?? "claude";
    const previousVersion = existingMarker.swampVersion;

    // Update marker with new version and tool
    const updatedMarker = this.markerRepo.createUpgradeMarker(
      existingMarker,
      this.currentVersion,
    );
    updatedMarker.tool = tool;
    await this.markerRepo.write(repoPath, updatedMarker);

    // Update skills in tool-appropriate directory
    const skillsDir = join(repoPath.value, SKILL_DIRS[tool]);
    await this.skillAssets.copySkillsTo(skillsDir);
    const skillsUpdated = this.skillAssets.getSkillNames();

    // Create instructions file if it doesn't exist (e.g., when switching tools)
    await this.createInstructionsFileIfNotExists(repoPath, tool);

    // Update Claude settings only for Claude tool
    let settingsUpdated = false;
    if (tool === "claude") {
      settingsUpdated = await this.updateClaudeSettings(repoPath);
    }

    // Create .gitignore if it doesn't exist
    const gitignoreCreated = await this.createGitignoreIfNotExists(
      repoPath,
      tool,
    );

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
      settingsUpdated,
      gitignoreCreated,
      tool,
    };
  }

  /**
   * Gets the current marker data for a repository.
   */
  getMarker(repoPath: RepoPath): Promise<RepoMarkerData | null> {
    return this.markerRepo.read(repoPath);
  }

  /**
   * Creates the tool-appropriate instructions file if it doesn't already exist.
   */
  private async createInstructionsFileIfNotExists(
    repoPath: RepoPath,
    tool: AiTool,
  ): Promise<boolean> {
    const filePath = join(repoPath.value, INSTRUCTIONS_FILES[tool]);

    try {
      await Deno.stat(filePath);
      // File exists, don't overwrite
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Ensure parent directory exists (for cursor: .cursor/rules/)
        const parentDir = join(filePath, "..");
        await ensureDir(parentDir);

        const content = this.generateInstructionsContent(tool);
        await Deno.writeTextFile(filePath, content);
        return true;
      }
      throw error;
    }
  }

  /**
   * Generates the instructions content for the given tool.
   */
  private generateInstructionsContent(tool: AiTool): string {
    const body = `# Project

This repository is managed with [swamp](https://github.com/systeminit/swamp).

## Rules

1. **Extension models for service integrations.** When automating AWS, APIs, or any external service, ALWAYS create an extension model in \`extensions/models/\`. Use the \`swamp-extension-model\` skill for guidance. The \`command/shell\` model is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** Don't work around a missing capability with shell scripts or multi-step hacks. Add a method to the extension model. One method, one purpose.
3. **Use the data model.** Once data exists in a model (via \`lookup\`, \`start\`, \`sync\`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with \`model.*\` expressions. Always prefer \`model.<name>.resource.<spec>.<instance>.attributes.<field>\` over \`data.latest()\`.
5. **Verify before destructive operations.** Always \`swamp model get <name> --json\` and verify resource IDs before running delete/stop/destroy methods.

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- \`swamp-model\` - Work with swamp models (creating, editing, validating)
- \`swamp-workflow\` - Work with workflows (creating, editing, running)
- \`swamp-vault\` - Manage secrets and credentials
- \`swamp-data\` - Manage model data lifecycle
- \`swamp-repo\` - Repository management
- \`swamp-extension-model\` - Create custom TypeScript models
- \`swamp-issue\` - Submit bug reports and feature requests
- \`swamp-troubleshooting\` - Debug and diagnose swamp issues

## Getting Started

Always start by using the \`swamp-model\` skill to work with swamp models.

## Commands

Use \`swamp --help\` to see available commands.
`;

    if (tool === "cursor") {
      return `---
description: Swamp automation rules
alwaysApply: true
---
${body}`;
    }

    return body;
  }

  /**
   * Creates .gitignore if it doesn't already exist.
   */
  private async createGitignoreIfNotExists(
    repoPath: RepoPath,
    tool: AiTool,
  ): Promise<boolean> {
    const gitignorePath = join(repoPath.value, GITIGNORE_FILENAME);

    try {
      await Deno.stat(gitignorePath);
      // File exists, don't overwrite
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Create the file
        const content = this.generateGitignoreContent(tool);
        await Deno.writeTextFile(gitignorePath, content);
        return true;
      }
      throw error;
    }
  }

  /**
   * Generates the content for .gitignore.
   */
  private generateGitignoreContent(tool: AiTool): string {
    return `# Swamp managed defaults
# Feel free to modify this file to suit your needs

# Local telemetry (not needed for reconstruction)
.swamp/telemetry/

# Encryption keyfile (NEVER commit - allows decrypting secrets)
.swamp/secrets/keyfile

${GITIGNORE_TOOL_ENTRIES[tool]}
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
      "Bash(swamp issue:*)",
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
    await atomicWriteTextFile(
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
