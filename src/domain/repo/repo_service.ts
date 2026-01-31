import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { RepoPath } from "./repo_path.ts";
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

    return {
      path: repoPath.value,
      version: this.currentVersion.toString(),
      initializedAt: markerData.initializedAt,
      skillsCopied,
      claudeMdCreated,
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

## Getting Started

Always start by using the \`swamp-model\` skill to work with swamp models.

## Commands

Use \`swamp --help\` to see available commands.
`;
  }

  /**
   * Creates the data directory structure for storing repository artifacts.
   */
  private async createDataDirectoryStructure(
    repoPath: RepoPath,
  ): Promise<void> {
    const dataDir = join(repoPath.value, ".data");
    const subdirs = [
      "inputs",
      "resources",
      "workflows",
      "data",
      "outputs",
      "workflow-runs",
      "inputs-evaluated",
      "workflows-evaluated",
      "logs",
      "files",
    ];

    for (const subdir of subdirs) {
      await ensureDir(join(dataDir, subdir));
    }
  }
}
