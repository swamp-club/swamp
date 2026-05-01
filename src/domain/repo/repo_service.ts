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
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { defaultCommandResolver } from "../../infrastructure/process/resolve_command.ts";
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
import { assertNever, UserError } from "../errors.ts";
import { resolvePrimaryTool } from "./primary_tool.ts";
import { resolveSkillsDir, SKILL_DIRS } from "./skill_dirs.ts";

const logger = getLogger(["swamp", "repo", "service"]);

export type { AiTool } from "../../infrastructure/persistence/repo_marker_repository.ts";

const GITIGNORE_FILENAME = ".gitignore";
const GITIGNORE_SECTION_BEGIN = "# BEGIN swamp managed section - DO NOT EDIT";
const GITIGNORE_SECTION_END = "# END swamp managed section";
const GITIGNORE_LEGACY_HEADER = "# Swamp managed defaults";

const INSTRUCTIONS_SECTION_BEGIN =
  "<!-- BEGIN swamp managed section - DO NOT EDIT -->";
const INSTRUCTIONS_SECTION_END = "<!-- END swamp managed section -->";
const LEGACY_INSTRUCTIONS_SIGNATURE = "This repository is managed with [swamp]";

/**
 * Describes what happened to the .gitignore during init/upgrade.
 * - "created": a new .gitignore file was created with the managed section
 * - "updated": an existing .gitignore had its managed section added or refreshed
 * - "unchanged": the managed section already existed and was up-to-date
 * - "skipped": gitignore management was not opted in
 */
export type GitignoreAction = "created" | "updated" | "unchanged" | "skipped";

const INSTRUCTIONS_FILES: Partial<Record<AiTool, string>> = {
  claude: "CLAUDE.md",
  cursor: ".cursor/rules/swamp.mdc",
  opencode: "AGENTS.md",
  codex: "AGENTS.md",
  copilot: "AGENTS.md",
  kiro: ".kiro/steering/swamp-rules.md",
};

const GITIGNORE_TOOL_ENTRIES: Partial<Record<AiTool, string>> = {
  claude: "# Claude Code configuration (managed by swamp)\n.claude/",
  cursor: "# Cursor skills (managed by swamp)\n.cursor/skills/",
  opencode: "# Agent skills (managed by swamp)\n.agents/skills/",
  codex: "# Agent skills (managed by swamp)\n.agents/skills/",
  copilot: "# Agent skills (managed by swamp)\n.agents/skills/",
  kiro: "# Kiro skills (managed by swamp)\n.kiro/skills/",
};

/**
 * Dedupes a tools list while preserving first-seen order, so set semantics
 * on `marker.tools` are enforced at the domain boundary.
 */
function normalizeToolsList(tools: AiTool[]): AiTool[] {
  const seen = new Set<AiTool>();
  const result: AiTool[] = [];
  for (const tool of tools) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}

/**
 * Renders a tools list for human-readable error/diagnostic messages.
 * Empty list renders as "none" so output is never ambiguous.
 */
function formatToolsList(tools: AiTool[]): string {
  return tools.length === 0 ? "none" : tools.join(", ");
}

/**
 * Pulled extensions present for one of the previously-enrolled tools that
 * were NOT copied into a newly-added tool's skills directory. Surfaced so
 * the renderer can advise the user to re-run `swamp extension pull <name>`
 * for the new tool.
 */
export interface ExtensionsToReinstall {
  tool: AiTool;
  names: string[];
}

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
  gitignoreAction: GitignoreAction;
  tools: AiTool[];
  /**
   * Tools previously enrolled (when `--force` reinit drops some) whose
   * scaffolding files were left on disk. Empty for fresh inits.
   */
  removedTools: AiTool[];
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
  instructionsUpdated: boolean;
  settingsUpdated: boolean;
  gitignoreAction: GitignoreAction;
  /** Enrolled tools as recorded by `marker.tools` BEFORE this upgrade. */
  previousTools: AiTool[];
  tools: AiTool[];
  addedTools: AiTool[];
  removedTools: AiTool[];
  extensionsToReinstall: ExtensionsToReinstall[];
}

/**
 * Options for initialization. `tools` is the canonical input; defaults to
 * `["claude"]` when omitted. An empty array means "no tool scaffolding".
 */
export interface RepoInitOptions {
  force?: boolean;
  tools?: AiTool[];
}

/**
 * Options for upgrade. `tools` semantics:
 *  - undefined: preserve the existing `marker.tools` (no-op-tool-change path)
 *  - []: clear (the `--tool none` case)
 *  - [list]: replace
 */
export interface RepoUpgradeOptions {
  tools?: AiTool[];
  includeGitignore?: boolean;
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
    const tools = normalizeToolsList(options.tools ?? ["claude"]);
    const isAlreadyInit = await this.isInitialized(repoPath);

    let removedTools: AiTool[] = [];

    if (isAlreadyInit) {
      const existingMarker = await this.markerRepo.read(repoPath);
      const existingTools = existingMarker?.tools ?? [];

      if (!options.force) {
        throw new UserError(
          `Repository already initialized at ${repoPath.value} ` +
            `(tools: ${formatToolsList(existingTools)}). ` +
            "To change the enrolled tools, run: swamp repo upgrade --tool <tool>. " +
            "To reinitialize from scratch, run: swamp repo init --force --tool <tool>",
        );
      }

      // --force replaces the tool list; surface the diff so the renderer can
      // tell the user files for dropped tools were not deleted.
      removedTools = existingTools.filter((t) => !tools.includes(t));
    }

    // Ensure the directory exists
    await ensureDir(repoPath.value);

    // Create marker with the new tools list
    const markerData = this.markerRepo.createInitMarker(this.currentVersion);
    markerData.tools = tools;

    // Create data directory structure
    await this.createDataDirectoryStructure(repoPath);

    // Run scaffolding for each enrolled tool
    let skillsCopied: string[] = [];
    let instructionsFileCreated = false;
    let settingsCreated = false;
    for (const tool of tools) {
      const r = await this.applyToolScaffolding(repoPath, tool, isAlreadyInit);
      if (r.skillsCopied.length > 0) skillsCopied = r.skillsCopied;
      instructionsFileCreated = instructionsFileCreated ||
        r.instructionsFileChanged;
      settingsCreated = settingsCreated || r.settingsChanged;
    }

    // Always manage .gitignore on init (single call with the full tools list)
    const gitignoreAction = await this.ensureGitignoreSection(repoPath, tools);
    markerData.gitignoreManaged = true;

    await this.markerRepo.write(repoPath, markerData);

    return {
      path: repoPath.value,
      version: this.currentVersion.toString(),
      initializedAt: markerData.initializedAt,
      skillsCopied,
      instructionsFileCreated,
      settingsCreated,
      gitignoreAction,
      tools,
      removedTools,
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

    const oldTools = existingMarker.tools ?? [];
    // The OLD primary tool — resolved BEFORE any mutation. Used to walk for
    // pulled extensions, since that's the directory they actually live in.
    const oldPrimary = resolvePrimaryTool(existingMarker);
    const oldPrimarySkillsDir = resolveSkillsDir(repoPath.value, oldPrimary);

    // Determine the requested tools list:
    //  - undefined: preserve the existing tools (no-op-tool-change path)
    //  - else (incl. []): replace
    const tools = options.tools === undefined
      ? oldTools
      : normalizeToolsList(options.tools);
    const previousVersion = existingMarker.swampVersion;

    const addedTools = tools.filter((t) => !oldTools.includes(t));
    const removedTools = oldTools.filter((t) => !tools.includes(t));

    // For each newly-added tool, find pulled extensions in the OLD primary's
    // skills dir that won't be present in the new tool's. Suppress when the
    // dirs are equal (the .agents/skills/ shared-dir case).
    const extensionsToReinstall: ExtensionsToReinstall[] = [];
    if (addedTools.length > 0) {
      const pulled = await this.listPulledExtensions(oldPrimarySkillsDir);
      if (pulled.length > 0) {
        for (const tool of addedTools) {
          const newDir = resolveSkillsDir(repoPath.value, tool);
          if (newDir !== oldPrimarySkillsDir) {
            extensionsToReinstall.push({ tool, names: pulled });
          }
        }
      }
    }

    // Update marker with new version and tool list
    const updatedMarker = this.markerRepo.createUpgradeMarker(
      existingMarker,
      this.currentVersion,
    );
    updatedMarker.tools = tools;

    // Run scaffolding for each currently-enrolled tool
    let skillsUpdated: string[] = [];
    let instructionsUpdated = false;
    let settingsUpdated = false;
    for (const tool of tools) {
      const r = await this.applyToolScaffolding(repoPath, tool, true);
      if (r.skillsCopied.length > 0) skillsUpdated = r.skillsCopied;
      instructionsUpdated = instructionsUpdated || r.instructionsFileChanged;
      settingsUpdated = settingsUpdated || r.settingsChanged;
    }

    // Determine gitignore management: CLI flag > marker preference > default off
    const shouldManageGitignore = options.includeGitignore ??
      existingMarker.gitignoreManaged ?? false;

    // Persist the CLI flag choice if explicitly provided
    if (options.includeGitignore !== undefined) {
      updatedMarker.gitignoreManaged = options.includeGitignore;
    }

    let gitignoreAction: GitignoreAction;
    if (shouldManageGitignore) {
      gitignoreAction = await this.ensureGitignoreSection(repoPath, tools);
    } else {
      gitignoreAction = "skipped";
    }

    // Migrate from symlink-based layout to datastore layout
    await this.migrateFromSymlinks(repoPath);

    await this.markerRepo.write(repoPath, updatedMarker);

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
      instructionsUpdated,
      settingsUpdated,
      gitignoreAction,
      previousTools: oldTools,
      tools,
      addedTools,
      removedTools,
      extensionsToReinstall,
    };
  }

  /**
   * Runs all per-tool scaffolding for a single tool: skills copy, instructions
   * file, settings/hooks/configs. Idempotent across calls — when the same
   * tool runs twice, the writers no-op or re-sync existing content.
   *
   * `alreadyExists` controls whether settings writers run their "create new"
   * or "update existing" path; `true` for upgrades and force-reinit, `false`
   * for fresh init.
   */
  private async applyToolScaffolding(
    repoPath: RepoPath,
    tool: AiTool,
    alreadyExists: boolean,
  ): Promise<{
    skillsCopied: string[];
    instructionsFileChanged: boolean;
    settingsChanged: boolean;
  }> {
    if (tool === "none") {
      return {
        skillsCopied: [],
        instructionsFileChanged: false,
        settingsChanged: false,
      };
    }

    // Copy skills to tool-appropriate directory
    const skillsDir = join(repoPath.value, SKILL_DIRS[tool]!);
    await this.skillAssets.copySkillsTo(skillsDir);
    const skillsCopied = this.skillAssets.getSkillNames();

    // Create or update instructions file
    const instructionsFileChanged = alreadyExists
      ? await this.updateInstructionsFile(repoPath, tool)
      : await this.createInstructionsFileIfNotExists(repoPath, tool);

    // Create or update tool-specific settings
    let settingsChanged = false;
    switch (tool) {
      case "claude":
        settingsChanged = alreadyExists
          ? await this.updateClaudeSettings(repoPath)
          : await this.createClaudeSettingsIfNotExists(repoPath);
        break;
      case "cursor":
        settingsChanged = alreadyExists
          ? await this.updateCursorHooks(repoPath)
          : await this.createCursorHooksIfNotExists(repoPath);
        break;
      case "kiro": {
        const s = alreadyExists
          ? await this.updateKiroSettings(repoPath)
          : await this.createKiroSettingsIfNotExists(repoPath);
        const h = alreadyExists
          ? await this.updateKiroHooks(repoPath)
          : await this.createKiroHooksIfNotExists(repoPath);
        const a = alreadyExists
          ? await this.updateKiroAgentConfig(repoPath)
          : await this.createKiroAgentConfigIfNotExists(repoPath);
        const c = await this.ensureKiroCliDefaultAgent(repoPath);
        settingsChanged = s || h || a || c;
        break;
      }
      case "opencode":
        settingsChanged = alreadyExists
          ? await this.updateOpenCodePlugin(repoPath)
          : await this.createOpenCodePluginIfNotExists(repoPath);
        break;
      case "codex":
      case "copilot":
        break;
      default:
        assertNever(tool);
    }

    return { skillsCopied, instructionsFileChanged, settingsChanged };
  }

  /**
   * Lists pulled-extension subdirectory names in a skills directory —
   * everything that's NOT a bundled scaffolding skill. Returns an empty list
   * when the directory doesn't exist.
   */
  private async listPulledExtensions(skillsDir: string): Promise<string[]> {
    const bundled = new Set(this.skillAssets.getSkillNames());
    const result: string[] = [];
    try {
      for await (const entry of Deno.readDir(skillsDir)) {
        if (entry.isDirectory && !bundled.has(entry.name)) {
          result.push(entry.name);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
    result.sort();
    return result;
  }

  /**
   * Gets the current marker data for a repository.
   */
  getMarker(repoPath: RepoPath): Promise<RepoMarkerData | null> {
    return this.markerRepo.read(repoPath);
  }

  /**
   * Creates the tool-appropriate instructions file if it doesn't already exist.
   * For shared-file tools, creates with section markers from the start.
   */
  private async createInstructionsFileIfNotExists(
    repoPath: RepoPath,
    tool: AiTool,
  ): Promise<boolean> {
    const filePath = join(repoPath.value, INSTRUCTIONS_FILES[tool]!);

    // For shared-file tools, always ensure the managed section exists
    // (merges into existing file or creates new one)
    if (this.usesSharedInstructionsFile(tool)) {
      return this.ensureInstructionsSection(filePath, tool);
    }

    // For tool-specific files, only create if missing
    try {
      await Deno.stat(filePath);
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const parentDir = join(filePath, "..");
        await ensureDir(parentDir);
        await Deno.writeTextFile(
          filePath,
          this.generateInstructionsContent(tool),
        );
        return true;
      }
      throw error;
    }
  }

  /**
   * Updates the tool-appropriate instructions file.
   * For tool-specific files (cursor/kiro): overwrites entirely.
   * For shared files (claude/opencode/codex): merges using section markers.
   */
  private updateInstructionsFile(
    repoPath: RepoPath,
    tool: AiTool,
  ): Promise<boolean> {
    const filePath = join(repoPath.value, INSTRUCTIONS_FILES[tool]!);
    if (!this.usesSharedInstructionsFile(tool)) {
      return this.overwriteIfChanged(
        filePath,
        this.generateInstructionsContent(tool),
      );
    }
    return this.ensureInstructionsSection(filePath, tool);
  }

  /**
   * Ensures the shared instructions file contains an up-to-date managed section.
   *
   * - If no file exists: creates with managed section.
   * - If file has markers: replaces content between markers.
   * - If file has legacy swamp content (no markers): migrates to marked section.
   * - If file has no swamp content: prepends managed section.
   */
  private async ensureInstructionsSection(
    filePath: string,
    tool: AiTool,
  ): Promise<boolean> {
    const newSection = this.buildInstructionsSection(tool);

    let existingContent: string | null = null;
    try {
      existingContent = await Deno.readTextFile(filePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Case 1: No file exists — create with managed section
    if (existingContent === null) {
      await ensureDir(join(filePath, ".."));
      await Deno.writeTextFile(filePath, newSection + "\n");
      return true;
    }

    // Case 2: File has markers — replace managed section
    // Only proceed if both BEGIN and END markers are present;
    // a missing END marker (accidental deletion) falls through to case 4.
    if (
      existingContent.includes(INSTRUCTIONS_SECTION_BEGIN) &&
      existingContent.includes(INSTRUCTIONS_SECTION_END)
    ) {
      const updatedContent = this.replaceManagedSection(
        existingContent,
        newSection,
        INSTRUCTIONS_SECTION_BEGIN,
        INSTRUCTIONS_SECTION_END,
      );
      if (updatedContent === existingContent) {
        return false;
      }
      await atomicWriteTextFile(filePath, updatedContent);
      return true;
    }

    // Case 3: Orphaned BEGIN marker (END was accidentally deleted).
    // Strip the orphaned BEGIN before falling through to prepend,
    // so we don't end up with duplicate BEGIN markers.
    if (existingContent.includes(INSTRUCTIONS_SECTION_BEGIN)) {
      existingContent = existingContent.replace(
        INSTRUCTIONS_SECTION_BEGIN + "\n",
        "",
      ).replace(INSTRUCTIONS_SECTION_BEGIN, "");
    }

    // Case 4: File has legacy swamp content (no markers) — migrate
    if (this.hasLegacyInstructionsContent(existingContent)) {
      const updatedContent = this.migrateLegacyInstructions(
        existingContent,
        newSection,
      );
      await atomicWriteTextFile(filePath, updatedContent);
      return true;
    }

    // Case 5: File has no swamp content — prepend managed section
    const separator = existingContent.startsWith("\n") ? "" : "\n";
    await atomicWriteTextFile(
      filePath,
      newSection + "\n" + separator + existingContent,
    );
    return true;
  }

  /**
   * Detects legacy swamp-generated instructions content (without markers).
   */
  private hasLegacyInstructionsContent(content: string): boolean {
    return content.includes(LEGACY_INSTRUCTIONS_SIGNATURE);
  }

  /**
   * Migrates legacy instructions content to the marked section format.
   * Finds the old template boundaries and replaces with the marked section,
   * preserving any user content before/after.
   * Falls back to prepend if boundaries can't be found.
   */
  private migrateLegacyInstructions(
    content: string,
    newSection: string,
  ): string {
    // Find start: "# Project\n\nThis repository is managed with [swamp]"
    const startPattern =
      /# Project\n\nThis repository is managed with \[swamp\]/;
    const startMatch = startPattern.exec(content);

    if (!startMatch) {
      // Can't find boundaries — prepend
      const separator = content.startsWith("\n") ? "" : "\n";
      return newSection + "\n" + separator + content;
    }

    // Find end: "Use `swamp --help` to see available commands.\n"
    const endMarker = "Use `swamp --help` to see available commands.\n";
    const endIndex = content.indexOf(endMarker, startMatch.index);

    if (endIndex === -1) {
      // Start matched but end didn't — the user edited the template.
      // We can't determine where the legacy template ends, so prepend the
      // new managed section to preserve ALL existing content (including user
      // additions). This may leave some duplicate template text in the file,
      // but that's preferable to silently deleting user content.
      const separator = content.startsWith("\n") ? "" : "\n";
      return newSection + "\n" + separator + content;
    }

    const endSlice = endIndex + endMarker.length;

    const before = content.substring(0, startMatch.index);
    const after = content.substring(endSlice);

    const prefix = before.length > 0 ? before : "";
    const suffix = after.length > 0 ? after : "\n";

    return prefix + newSection + "\n" + suffix;
  }

  /**
   * Returns true if the tool shares its instructions file with user content
   * (CLAUDE.md, AGENTS.md) and needs section markers to avoid overwriting.
   */
  private usesSharedInstructionsFile(tool: AiTool): boolean {
    switch (tool) {
      case "claude":
      case "opencode":
      case "codex":
      case "copilot":
        return true;
      case "cursor":
      case "kiro":
        return false;
      case "none":
        return false;
      default:
        assertNever(tool);
    }
  }

  /**
   * Generates the raw instructions body without any frontmatter or markers.
   */
  private generateInstructionsBody(tool: AiTool): string {
    const skillsDir = SKILL_DIRS[tool] ?? ".agents/skills";
    const useSkillNames = tool === "claude";

    const skillAction = (name: string, verb: string): string =>
      useSkillNames
        ? `${verb} the \`${name}\` skill`
        : `Read \`${skillsDir}/${name}/SKILL.md\``;

    const skillListEntry = (name: string, desc: string): string =>
      useSkillNames
        ? `- \`${name}\` - ${desc}`
        : `- \`${skillsDir}/${name}/SKILL.md\` - ${desc}`;

    const skillsIntro = useSkillNames
      ? `**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.`
      : `**IMPORTANT:** Skills are detailed guides stored in \`${skillsDir}/\`. When a task
matches a skill area below, read the corresponding \`SKILL.md\` file for guidance.`;

    const gettingStarted = useSkillNames
      ? `**IMPORTANT:** At the start of every conversation, run
\`swamp model search --json\`. If no models are returned (empty result), you MUST
immediately invoke the \`swamp-getting-started\` skill before doing anything else.
This walks new users through an interactive onboarding tutorial.

If models already exist, start by using the \`swamp-model\` skill to work with
swamp models.`
      : `**IMPORTANT:** At the start of every conversation, run
\`swamp model search --json\`. If no models are returned (empty result), you MUST
immediately read \`${skillsDir}/swamp-getting-started/SKILL.md\` and follow its
instructions. This walks new users through an interactive onboarding tutorial.

If models already exist, start by reading \`${skillsDir}/swamp-model/SKILL.md\`
to work with swamp models.`;

    return `# Project

This repository is managed with [swamp](https://github.com/systeminit/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search local types with \`swamp model type search <query>\`, (b) search community extensions with \`swamp extension search <query>\`, (c) if a community extension exists, install it with \`swamp extension pull <package>\` instead of building from scratch, (d) only create a custom extension model in \`extensions/models/\` if nothing exists. ${
      skillAction("swamp-extension-model", "Use")
    } for guidance. The \`command/shell\` model is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it with \`export const extension\` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use \`swamp model type describe <type> --json\` to check available methods.
3. **Use the data model.** Once data exists in a model (via \`lookup\`, \`start\`, \`sync\`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL expressions. Always prefer \`data.latest("<name>", "<dataName>").attributes.<field>\` over the deprecated \`model.<name>.resource.<spec>.<instance>.attributes.<field>\` pattern.
5. **Verify before destructive operations.** Always \`swamp model get <name> --json\` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate \`swamp model method run\` calls against the same model. Multiple parallel calls against the same model contend on the per-model lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check \`swamp model type describe\` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled, not lockfile-tracked.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. \`deno.lock\` and \`package.json\` do NOT cover extension model dependencies — this is by design. Always pin explicit versions in \`npm:\` import specifiers (e.g., \`npm:lodash-es@4.17.21\`).
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze model output (security reports, cost analysis, compliance checks, summaries), create a report extension. ${
      skillAction("swamp-report", "Use")
    } for guidance.

## Skills

${skillsIntro}

${
      skillListEntry(
        "swamp-getting-started",
        "Interactive onboarding for new swamp users",
      )
    }
${
      skillListEntry(
        "swamp-model",
        "Work with swamp models (creating, editing, validating)",
      )
    }
${
      skillListEntry(
        "swamp-workflow",
        "Work with workflows (creating, editing, running)",
      )
    }
${skillListEntry("swamp-vault", "Manage secrets and credentials")}
${skillListEntry("swamp-data", "Manage model data lifecycle")}
${
      skillListEntry(
        "swamp-data-query",
        "Query model data artifacts with CEL predicates",
      )
    }
${
      skillListEntry(
        "swamp-report",
        "Create and run reports for models and workflows",
      )
    }
${skillListEntry("swamp-repo", "Repository management")}
${skillListEntry("swamp-extension-model", "Create custom TypeScript models")}
${skillListEntry("swamp-extension-driver", "Create custom execution drivers")}
${
      skillListEntry(
        "swamp-extension-datastore",
        "Create custom datastore backends",
      )
    }
${skillListEntry("swamp-extension-vault", "Create custom vault providers")}
${
      skillListEntry(
        "swamp-extension-publish",
        "Publish extensions to the registry",
      )
    }
${
      skillListEntry(
        "swamp-extension-quality",
        "Improve extension quality scorecards",
      )
    }
${skillListEntry("swamp-issue", "Submit bug reports and feature requests")}
${
      skillListEntry(
        "swamp-troubleshooting",
        "Diagnose swamp problems and verify swamp's health",
      )
    }

## Getting Started

${gettingStarted}

## Commands

Use \`swamp --help\` to see available commands. For a machine-readable JSON
schema of the CLI (commands, options, arguments) intended for agent
consumption, run \`swamp help [<command>...]\` — e.g. \`swamp help\` returns
the full tree, and \`swamp help model method run\` scopes to a subtree.
`;
  }

  /**
   * Wraps the instructions body in BEGIN/END markers for shared files.
   */
  private buildInstructionsSection(tool: AiTool): string {
    const body = this.generateInstructionsBody(tool);
    return INSTRUCTIONS_SECTION_BEGIN + "\n" + body +
      INSTRUCTIONS_SECTION_END;
  }

  /**
   * Generates the full instructions content for tool-specific files (cursor/kiro).
   * Shared-file tools should use buildInstructionsSection() instead.
   */
  private generateInstructionsContent(tool: AiTool): string {
    const body = this.generateInstructionsBody(tool);

    switch (tool) {
      case "cursor":
        return `---
description: Swamp automation rules
alwaysApply: true
---
${body}`;
      case "kiro":
        return `---
inclusion: always
---
${body}`;
      case "claude":
      case "opencode":
      case "codex":
      case "copilot":
        return body;
      case "none":
        return body;
      default:
        assertNever(tool);
    }
  }

  /**
   * Ensures the .gitignore contains an up-to-date swamp managed section.
   *
   * - If no .gitignore exists: creates one with the managed section.
   * - If .gitignore exists without a swamp section: appends the managed section.
   * - If .gitignore exists with a swamp section: replaces the section if content differs.
   * - If .gitignore has legacy format (pre-marker): migrates to managed section.
   */
  private async ensureGitignoreSection(
    repoPath: RepoPath,
    tools: AiTool[],
  ): Promise<GitignoreAction> {
    const gitignorePath = join(repoPath.value, GITIGNORE_FILENAME);
    const newSection = this.buildGitignoreSection(tools);

    let existingContent: string | null = null;
    try {
      existingContent = await Deno.readTextFile(gitignorePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Case 1: No .gitignore exists — create new file
    if (existingContent === null) {
      await Deno.writeTextFile(gitignorePath, newSection + "\n");
      return "created";
    }

    // Case 2: File exists with markers — replace managed section
    if (existingContent.includes(GITIGNORE_SECTION_BEGIN)) {
      const updatedContent = this.replaceManagedSection(
        existingContent,
        newSection,
        GITIGNORE_SECTION_BEGIN,
        GITIGNORE_SECTION_END,
      );
      if (updatedContent === existingContent) {
        return "unchanged";
      }
      await atomicWriteTextFile(gitignorePath, updatedContent);
      return "updated";
    }

    // Case 3: File exists with legacy header — migrate
    if (existingContent.includes(GITIGNORE_LEGACY_HEADER)) {
      const updatedContent = this.migrateLegacyGitignore(
        existingContent,
        newSection,
      );
      await atomicWriteTextFile(gitignorePath, updatedContent);
      return "updated";
    }

    // Case 4: File exists without any swamp content — append section
    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    await atomicWriteTextFile(
      gitignorePath,
      existingContent + separator + newSection + "\n",
    );
    return "updated";
  }

  /**
   * Builds the full managed section including BEGIN/END markers.
   */
  private buildGitignoreSection(tools: AiTool[]): string {
    const body = this.generateGitignoreSectionBody(tools);
    return GITIGNORE_SECTION_BEGIN + "\n" + body + GITIGNORE_SECTION_END;
  }

  /**
   * Generates the content between markers (not including the markers).
   * Emits one entry per enrolled tool, deduplicated so tools that share an
   * ignore line (e.g. opencode/codex/copilot all use `.agents/skills/`) only
   * produce a single entry.
   */
  private generateGitignoreSectionBody(tools: AiTool[]): string {
    const lines = [
      "",
      "# Runtime data (not needed in version control)",
      ".swamp/",
      "",
      "# Local extension sources (developer-specific, not shared)",
      ".swamp-sources.yaml",
    ];

    const seenEntries = new Set<string>();
    for (const tool of tools) {
      const toolEntry = GITIGNORE_TOOL_ENTRIES[tool];
      if (toolEntry && !seenEntries.has(toolEntry)) {
        seenEntries.add(toolEntry);
        lines.push("", toolEntry);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Replaces the managed section between BEGIN and END markers.
   * Preserves all content outside the markers exactly as-is.
   * Works for both gitignore and instructions files.
   */
  private replaceManagedSection(
    content: string,
    newSection: string,
    beginMarker: string,
    endMarker: string,
  ): string {
    const beginIndex = content.indexOf(beginMarker);
    const endIndex = content.indexOf(endMarker);

    if (beginIndex === -1 || endIndex === -1) {
      throw new Error("Internal error: managed section markers not found");
    }

    if (endIndex < beginIndex) {
      throw new Error(
        "Internal error: managed section END marker appears before BEGIN marker",
      );
    }

    // Detect duplicate marker pairs
    const secondBegin = content.indexOf(beginMarker, beginIndex + 1);
    const secondEnd = content.indexOf(endMarker, endIndex + 1);
    if (secondBegin !== -1 || secondEnd !== -1) {
      throw new UserError(
        "Found multiple swamp managed sections in file. " +
          "Please remove the duplicate section and run the command again.",
      );
    }

    const endOfEndMarker = endIndex + endMarker.length;
    // Consume the trailing newline after END marker if present
    const nextChar = content[endOfEndMarker];
    const endSlice = nextChar === "\n" ? endOfEndMarker + 1 : endOfEndMarker;

    const before = content.substring(0, beginIndex);
    const after = content.substring(endSlice);

    return before + newSection + "\n" + after;
  }

  /**
   * Migrates a legacy .gitignore (with "Swamp managed defaults" header
   * but no section markers) to the new managed section format.
   * Replaces the legacy swamp block; preserves user content after it.
   */
  private migrateLegacyGitignore(
    content: string,
    newSection: string,
  ): string {
    const lines = content.split("\n");
    const headerLineIndex = lines.findIndex((l) =>
      l.includes(GITIGNORE_LEGACY_HEADER)
    );

    if (headerLineIndex === -1) {
      throw new Error("Internal error: legacy header not found");
    }

    // Scan forward from the header to find the end of the legacy block.
    // The legacy block consists of comments and entries that match known patterns.
    const swampPatterns = [
      ".swamp/telemetry/",
      ".swamp/secrets/keyfile",
      ".swamp/bundles/",
      ".swamp/audit/",
      ".claude/",
      ".cursor/skills/",
      ".agents/skills/",
      ".kiro/skills/",
      "# Feel free to modify",
      "# Local telemetry",
      "# Audit command logs",
      "# Encryption keyfile",
      "# Cached extension bundles",
      "# Claude Code configuration",
      "# Cursor skills",
      "# Agent skills",
      "# Kiro skills",
      "# Swamp managed defaults",
    ];

    let legacyEndIndex = headerLineIndex;
    for (let i = headerLineIndex; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (
        trimmed === "" || swampPatterns.some((p) => trimmed.includes(p))
      ) {
        legacyEndIndex = i;
      } else {
        break;
      }
    }

    const before = lines.slice(0, headerLineIndex).join("\n");
    const after = lines.slice(legacyEndIndex + 1).join("\n");

    const prefix = before.length > 0 ? before + "\n" : "";
    const suffix = after.length > 0 ? "\n" + after : "\n";

    return prefix + newSection + suffix;
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
      "Bash(swamp audit:*)",
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
      hooks: this.getClaudeHooks(),
    };
    return JSON.stringify(settings, null, 2) + "\n";
  }

  /**
   * Gets the hooks configuration for Claude settings.
   */
  private getClaudeHooks(): Record<string, unknown[]> {
    return {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "swamp audit record --from-hook",
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "swamp audit record --from-hook",
            },
          ],
        },
      ],
    };
  }

  /**
   * Creates a file if it doesn't already exist, ensuring parent directories exist.
   * Returns true if the file was created, false if it already existed.
   */
  private async createFileIfNotExists(
    filePath: string,
    content: string,
  ): Promise<boolean> {
    try {
      await Deno.stat(filePath);
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await ensureDir(join(filePath, ".."));
        await Deno.writeTextFile(filePath, content);
        return true;
      }
      throw error;
    }
  }

  /**
   * Overwrites a managed file if its content has changed.
   * Returns true if the file was written, false if content was identical.
   */
  private async overwriteIfChanged(
    filePath: string,
    newContent: string,
  ): Promise<boolean> {
    await ensureDir(join(filePath, ".."));
    try {
      const existing = await Deno.readTextFile(filePath);
      if (existing === newContent) return false;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await atomicWriteTextFile(filePath, newContent);
    return true;
  }

  /**
   * Creates settings.local.json if it doesn't already exist.
   */
  private createClaudeSettingsIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const settingsPath = join(repoPath.value, ".claude", "settings.local.json");
    return this.createFileIfNotExists(
      settingsPath,
      this.generateClaudeSettingsContent(),
    );
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

    let existingSettings: {
      permissions?: { allow?: string[] };
      hooks?: Record<string, unknown[]>;
    } = {};
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

    // Merge hooks
    const ourHooks = this.getClaudeHooks();
    const mergedHooks = this.mergeHooks(
      existingSettings.hooks ?? {},
      ourHooks,
    );

    // Check if anything changed
    const permissionsChanged = mergedAllow.length !== existingAllow.length ||
      !ourCommands.every((cmd) => existingAllow.includes(cmd));
    const hooksChanged = JSON.stringify(existingSettings.hooks ?? {}) !==
      JSON.stringify(mergedHooks);
    const hasChanges = permissionsChanged || hooksChanged;

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
      hooks: mergedHooks,
    };
    await atomicWriteTextFile(
      settingsPath,
      JSON.stringify(newSettings, null, 2) + "\n",
    );
    return true;
  }

  /**
   * Generates the content for Kiro's .vscode/settings.local.json.
   */
  private generateKiroSettingsContent(): string {
    const settings = {
      "kiroAgent.trustedCommands": [
        "swamp *",
      ],
    };
    return JSON.stringify(settings, null, 2) + "\n";
  }

  /**
   * Creates .vscode/settings.local.json for Kiro if it doesn't already exist.
   */
  private createKiroSettingsIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const settingsPath = join(
      repoPath.value,
      ".vscode",
      "settings.local.json",
    );
    return this.createFileIfNotExists(
      settingsPath,
      this.generateKiroSettingsContent(),
    );
  }

  /**
   * Updates .vscode/settings.local.json for Kiro, merging trusted commands.
   */
  private async updateKiroSettings(repoPath: RepoPath): Promise<boolean> {
    const vscodeDir = join(repoPath.value, ".vscode");
    const settingsPath = join(vscodeDir, "settings.local.json");

    await ensureDir(vscodeDir);

    let existingSettings: Record<string, unknown> = {};
    let settingsExisted = false;

    try {
      const content = await Deno.readTextFile(settingsPath);
      existingSettings = JSON.parse(content);
      settingsExisted = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const ourCommands = ["swamp *"];
    const existingCommands =
      (existingSettings["kiroAgent.trustedCommands"] as string[] | undefined) ??
        [];
    const mergedCommands = [...new Set([...existingCommands, ...ourCommands])];

    const hasChanges = mergedCommands.length !== existingCommands.length ||
      !ourCommands.every((cmd) => existingCommands.includes(cmd));

    if (!hasChanges && settingsExisted) {
      return false;
    }

    const newSettings = {
      ...existingSettings,
      "kiroAgent.trustedCommands": mergedCommands,
    };
    await atomicWriteTextFile(
      settingsPath,
      JSON.stringify(newSettings, null, 2) + "\n",
    );
    return true;
  }

  /**
   * Generates the content for Cursor's .cursor/hooks.json.
   */
  private generateCursorHooksContent(): string {
    const hooks = {
      version: 1,
      hooks: {
        postToolUse: [
          { command: "swamp audit record --from-hook --tool cursor" },
        ],
        postToolUseFailure: [
          { command: "swamp audit record --from-hook --tool cursor" },
        ],
      },
    };
    return JSON.stringify(hooks, null, 2) + "\n";
  }

  /**
   * Creates .cursor/hooks.json if it doesn't already exist.
   */
  private createCursorHooksIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const hooksPath = join(repoPath.value, ".cursor", "hooks.json");
    return this.createFileIfNotExists(
      hooksPath,
      this.generateCursorHooksContent(),
    );
  }

  /**
   * Updates .cursor/hooks.json, merging new hook entries with existing ones.
   */
  private async updateCursorHooks(repoPath: RepoPath): Promise<boolean> {
    const cursorDir = join(repoPath.value, ".cursor");
    const hooksPath = join(cursorDir, "hooks.json");

    await ensureDir(cursorDir);

    let existingHooks: {
      version?: number;
      hooks?: Record<string, unknown[]>;
    } = {};
    let hooksExisted = false;

    try {
      const content = await Deno.readTextFile(hooksPath);
      existingHooks = JSON.parse(content);
      hooksExisted = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const ourHooks: Record<string, unknown[]> = {
      postToolUse: [
        { command: "swamp audit record --from-hook --tool cursor" },
      ],
      postToolUseFailure: [
        { command: "swamp audit record --from-hook --tool cursor" },
      ],
    };

    const mergedHooks = this.mergeHooks(
      existingHooks.hooks ?? {},
      ourHooks,
    );

    const hooksChanged = JSON.stringify(existingHooks.hooks ?? {}) !==
      JSON.stringify(mergedHooks);

    if (!hooksChanged && hooksExisted) {
      return false;
    }

    const newContent = {
      version: existingHooks.version ?? 1,
      hooks: mergedHooks,
    };
    await atomicWriteTextFile(
      hooksPath,
      JSON.stringify(newContent, null, 2) + "\n",
    );
    return true;
  }

  /**
   * Generates the content for Kiro's .kiro/hooks/swamp-audit.kiro.hook.
   * Uses the absolute path to the swamp binary because kiro-cli does not
   * perform PATH resolution when executing hook commands.
   */
  private async generateKiroHookContent(): Promise<string> {
    const swampBin = await this.resolveSwampBinaryPath();
    const hook = {
      name: "Swamp Audit",
      description: "Records agent tool usage for swamp audit tracking",
      version: "1",
      when: { type: "postToolUse", toolTypes: ["*"] },
      then: {
        type: "runCommand",
        command: `"${swampBin}" audit record --from-hook --tool kiro`,
        timeout: 5,
      },
    };
    return JSON.stringify(hook, null, 2) + "\n";
  }

  /**
   * Resolves the absolute path to the swamp binary.
   * Falls back to bare "swamp" if resolution fails.
   */
  private async resolveSwampBinaryPath(): Promise<string> {
    const path = await defaultCommandResolver().resolve("swamp");
    return path ?? "swamp";
  }

  /**
   * Creates .kiro/hooks/swamp-audit.kiro.hook if it doesn't already exist.
   */
  private async createKiroHooksIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const hookPath = join(
      repoPath.value,
      ".kiro",
      "hooks",
      "swamp-audit.kiro.hook",
    );
    return await this.createFileIfNotExists(
      hookPath,
      await this.generateKiroHookContent(),
    );
  }

  /**
   * Updates .kiro/hooks/swamp-audit.kiro.hook, always overwriting with latest content.
   * Also removes the old swamp-audit.json hook file if it exists.
   */
  private async updateKiroHooks(repoPath: RepoPath): Promise<boolean> {
    // Remove old .json hook file if it exists
    const oldHookPath = join(
      repoPath.value,
      ".kiro",
      "hooks",
      "swamp-audit.json",
    );
    try {
      await Deno.remove(oldHookPath);
    } catch {
      // not found, ignore
    }
    const hookPath = join(
      repoPath.value,
      ".kiro",
      "hooks",
      "swamp-audit.kiro.hook",
    );
    return this.overwriteIfChanged(
      hookPath,
      await this.generateKiroHookContent(),
    );
  }

  /**
   * Generates the content for the kiro CLI agent config at .kiro/agents/swamp.json.
   * This provides kiro-cli with trusted commands, audit hooks, and resource
   * references that the IDE gets from .vscode/settings.local.json and .kiro/hooks/.
   */
  private async generateKiroAgentConfigContent(): Promise<string> {
    const swampBin = await this.resolveSwampBinaryPath();
    const config = {
      name: "swamp",
      description: "Swamp automation agent with audit tracking",
      // kiro-cli's agent schema only accepts explicit tool names from its
      // built-in list. Using "*" silently fails parsing and kiro-cli falls
      // back to the default agent, skipping the postToolUse audit hook.
      tools: ["read", "write", "shell", "grep", "glob", "thinking", "todo"],
      resources: [
        "file://.kiro/steering/**/*.md",
        "skill://.kiro/skills/**/SKILL.md",
      ],
      toolsSettings: {
        shell: {
          allowedCommands: ["swamp .*"],
        },
      },
      hooks: {
        postToolUse: [
          {
            command: `"${swampBin}" audit record --from-hook --tool kiro`,
          },
        ],
      },
    };
    return JSON.stringify(config, null, 2) + "\n";
  }

  /**
   * Creates .kiro/agents/swamp.json if it doesn't already exist.
   */
  private async createKiroAgentConfigIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const configPath = join(
      repoPath.value,
      ".kiro",
      "agents",
      "swamp.json",
    );
    return await this.createFileIfNotExists(
      configPath,
      await this.generateKiroAgentConfigContent(),
    );
  }

  /**
   * Updates .kiro/agents/swamp.json, overwriting with latest content.
   */
  private async updateKiroAgentConfig(repoPath: RepoPath): Promise<boolean> {
    const configPath = join(
      repoPath.value,
      ".kiro",
      "agents",
      "swamp.json",
    );
    return await this.overwriteIfChanged(
      configPath,
      await this.generateKiroAgentConfigContent(),
    );
  }

  /**
   * Ensures `.kiro/settings/cli.json` selects the swamp agent as the workspace
   * default. Without this, plain `kiro-cli chat` (no --agent flag) loads the
   * built-in `kiro_default` agent and the swamp audit hook never fires.
   *
   * If the file doesn't exist, creates it with `{ "chat.defaultAgent": "swamp" }`.
   * If it exists, merges the key — preserving any unrelated settings the user
   * has set. If `chat.defaultAgent` is already set to a non-"swamp" value, the
   * user's preference wins and we log a warning.
   */
  private async ensureKiroCliDefaultAgent(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const settingsDir = join(repoPath.value, ".kiro", "settings");
    const settingsPath = join(settingsDir, "cli.json");

    let existingSettings: Record<string, unknown> = {};
    let settingsExisted = false;

    try {
      const content = await Deno.readTextFile(settingsPath);
      existingSettings = JSON.parse(content);
      settingsExisted = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    const currentDefault = existingSettings["chat.defaultAgent"];
    if (
      settingsExisted &&
      typeof currentDefault === "string" &&
      currentDefault !== "swamp"
    ) {
      logger.warn(
        "Leaving existing chat.defaultAgent={current} in {path} — " +
          "swamp audit hooks will not run under kiro-cli unless you " +
          'either switch it to "swamp" or invoke `kiro-cli chat --agent swamp`.',
        { current: currentDefault, path: settingsPath },
      );
      return false;
    }

    if (settingsExisted && currentDefault === "swamp") {
      return false;
    }

    const newSettings = {
      ...existingSettings,
      "chat.defaultAgent": "swamp",
    };
    await ensureDir(settingsDir);
    await atomicWriteTextFile(
      settingsPath,
      JSON.stringify(newSettings, null, 2) + "\n",
    );
    return true;
  }

  /**
   * Generates the content for OpenCode's .opencode/plugins/swamp-audit.ts.
   */
  private generateOpenCodePluginContent(): string {
    return `// Swamp audit plugin for OpenCode
// Records bash tool invocations for the swamp audit timeline.
// This is a managed file — it will be overwritten on swamp upgrade.

import type { Plugin } from "@opencode-ai/plugin";

const pendingCommands = new Map();

export const SwampAudit: Plugin = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      const command = output.args?.command;
      if (command && input.sessionID) {
        pendingCommands.set(input.sessionID, command);
      }
    },
    "tool.execute.after": async (input) => {
      if (input.tool !== "bash") return;
      const command = pendingCommands.get(input.sessionID);
      pendingCommands.delete(input.sessionID);
      if (!command) return;

      try {
        const payload = JSON.stringify({
          tool_name: "bash",
          tool_input: { command },
          cwd: directory,
          session_id: input.sessionID,
        });
        const proc = Bun.spawn(
          ["swamp", "audit", "record", "--from-hook", "--tool", "opencode"],
          { stdin: new Blob([payload]) },
        );
        await proc.exited;
      } catch {
        // Must never throw — this is a hook
      }
    },
  };
};
`;
  }

  /**
   * Creates .opencode/plugins/swamp-audit.ts if it doesn't already exist.
   */
  private createOpenCodePluginIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const pluginPath = join(
      repoPath.value,
      ".opencode",
      "plugins",
      "swamp-audit.ts",
    );
    return this.createFileIfNotExists(
      pluginPath,
      this.generateOpenCodePluginContent(),
    );
  }

  /**
   * Updates .opencode/plugins/swamp-audit.ts, always overwriting with latest content.
   */
  private updateOpenCodePlugin(repoPath: RepoPath): Promise<boolean> {
    const pluginPath = join(
      repoPath.value,
      ".opencode",
      "plugins",
      "swamp-audit.ts",
    );
    return this.overwriteIfChanged(
      pluginPath,
      this.generateOpenCodePluginContent(),
    );
  }

  /**
   * Merges hook configurations, adding our hooks without duplicating.
   */
  private mergeHooks(
    existing: Record<string, unknown[]>,
    ours: Record<string, unknown[]>,
  ): Record<string, unknown[]> {
    const merged = { ...existing };

    for (const [event, ourEntries] of Object.entries(ours)) {
      const existingEntries = merged[event] ?? [];
      const mergedEntries = [...existingEntries];

      for (const ourEntry of ourEntries) {
        const ourJson = JSON.stringify(ourEntry);
        const alreadyExists = mergedEntries.some(
          (e) => JSON.stringify(e) === ourJson,
        );
        if (!alreadyExists) {
          mergedEntries.push(ourEntry);
        }
      }

      merged[event] = mergedEntries;
    }

    return merged;
  }

  /**
   * Creates the data directory structure for storing repository artifacts.
   */
  private async createDataDirectoryStructure(
    repoPath: RepoPath,
  ): Promise<void> {
    // Top-level directories for source-of-truth files
    const topLevelDirs = ["models", "workflows", "vaults"];
    for (const dir of topLevelDirs) {
      await ensureDir(join(repoPath.value, dir));
    }

    // Runtime data directories under .swamp/
    const runtimeSubdirs = [
      SWAMP_SUBDIRS.data,
      SWAMP_SUBDIRS.outputs,
      SWAMP_SUBDIRS.workflowRuns,
      SWAMP_SUBDIRS.workflowsEvaluated,
      SWAMP_SUBDIRS.definitionsEvaluated,
      SWAMP_SUBDIRS.secrets,
      SWAMP_SUBDIRS.telemetry,
      SWAMP_SUBDIRS.audit,
      SWAMP_SUBDIRS.vaultBundles,
    ];

    for (const subdir of runtimeSubdirs) {
      await ensureDir(swampPath(repoPath.value, subdir));
    }
  }

  /**
   * Migrates to top-level directory layout:
   * - Replaces `latest` symlinks in data dirs with text files
   * - Removes old symlink directories at models/, workflows/, vaults/
   * - Moves files from .swamp/definitions/ → models/
   * - Moves files from .swamp/workflows/ → workflows/
   * - Moves files from .swamp/vault/ → vaults/
   */
  private async migrateFromSymlinks(repoPath: RepoPath): Promise<void> {
    // Replace latest symlinks with text files in data directory
    const dataDir = swampPath(repoPath.value, SWAMP_SUBDIRS.data);
    await this.replaceLatestSymlinks(dataDir);

    // Clean up old symlink-based index directories
    for (const dir of ["models", "workflows", "vaults"]) {
      const dirPath = join(repoPath.value, dir);
      try {
        const stat = await Deno.lstat(dirPath);
        if (stat.isSymlink) {
          // Top-level symlink: remove it entirely
          await Deno.remove(dirPath);
        } else if (stat.isDirectory) {
          // Real directory from old index: remove all symlinks inside
          await this.removeSymlinksRecursively(dirPath);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          // Non-fatal: continue
        }
      }
    }

    // Create top-level directories
    for (const dir of ["models", "workflows", "vaults"]) {
      await ensureDir(join(repoPath.value, dir));
    }

    // Move files from .swamp/definitions/ → models/
    await this.moveDirectoryContents(
      swampPath(repoPath.value, SWAMP_SUBDIRS.definitions),
      join(repoPath.value, "models"),
    );

    // Move files from .swamp/workflows/ → workflows/
    await this.moveDirectoryContents(
      swampPath(repoPath.value, SWAMP_SUBDIRS.workflows),
      join(repoPath.value, "workflows"),
    );

    // Move files from .swamp/vault/ → vaults/
    await this.moveDirectoryContents(
      swampPath(repoPath.value, SWAMP_SUBDIRS.vault),
      join(repoPath.value, "vaults"),
    );
  }

  /**
   * Recursively moves all contents from source to destination directory,
   * preserving directory structure. Removes empty source directories after moving.
   */
  private async moveDirectoryContents(
    srcDir: string,
    destDir: string,
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(srcDir)) {
        const srcPath = join(srcDir, entry.name);
        const destPath = join(destDir, entry.name);

        if (entry.isDirectory) {
          await ensureDir(destPath);
          await this.moveDirectoryContents(srcPath, destPath);
          // Remove the now-empty source directory
          try {
            await Deno.remove(srcPath);
          } catch {
            // Non-fatal: directory may not be empty
          }
        } else if (entry.isFile) {
          // Only move if destination doesn't already exist
          try {
            await Deno.stat(destPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
              await Deno.rename(srcPath, destPath);
            }
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // Non-fatal: source directory might not exist
      }
    }

    // Try to remove the now-empty source directory
    try {
      await Deno.remove(srcDir);
    } catch {
      // Non-fatal: directory may not exist or may not be empty
    }
  }

  /**
   * Recursively removes all symlinks from a directory, then removes
   * any empty directories left behind. Used to clean up old symlink-based
   * index structures (models/name/definition.yaml → ..., etc.).
   */
  private async removeSymlinksRecursively(dir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);
        const stat = await Deno.lstat(fullPath);

        if (stat.isSymlink) {
          await Deno.remove(fullPath);
        } else if (stat.isDirectory) {
          await this.removeSymlinksRecursively(fullPath);
          // Try to remove the directory if it's now empty
          try {
            await Deno.remove(fullPath);
          } catch {
            // Non-fatal: directory may not be empty (has real files)
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // Non-fatal: continue
      }
    }
  }

  /**
   * Recursively replaces `latest` symlinks with text files containing
   * the version number.
   */
  private async replaceLatestSymlinks(dir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);

        if (entry.name === "latest" && entry.isSymlink) {
          try {
            const target = await Deno.readLink(fullPath);
            const version = parseInt(target.replace(/\/$/, ""), 10);
            if (!isNaN(version)) {
              await Deno.remove(fullPath);
              await Deno.writeTextFile(fullPath, version.toString());
            }
          } catch {
            // Non-fatal: skip this symlink
          }
        } else if (entry.isDirectory) {
          await this.replaceLatestSymlinks(fullPath);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // Non-fatal: data directory might not exist yet
      }
    }
  }
}
