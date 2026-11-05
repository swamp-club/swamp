// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { join, resolve, SEPARATOR } from "@std/path";
import { ensureDir } from "@std/fs";
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { migrateRepoTelemetryToGlobal } from "../../infrastructure/persistence/telemetry_spool_migration.ts";
import type { RepoPath } from "./repo_path.ts";
import {
  homeDirectory,
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
import { assertNever, markErrorPaths, UserError } from "../errors.ts";
import { resolvePrimaryTool } from "./primary_tool.ts";
import {
  resolveSkillsDir,
  resolveUniqueGlobalSkillsDirs,
} from "./skill_dirs.ts";
import {
  removeSupersededLocalSkills,
  removeSupersededSkills,
} from "./superseded_skills.ts";
import { assertStorableServerAddress } from "./server_address.ts";
import {
  assertPathContained,
  CLAUDE_RULES_FILE,
  type ClaudeInstructionsState,
  claudeToolConfigFor,
  type ToolConfig,
} from "./custom_tool.ts";
import { ToolResolver } from "./tool_resolver.ts";
import {
  createDefaultVaultConfig,
  DEFAULT_VAULT_NAME,
  type DefaultVaultStore,
} from "../vaults/default_vault.ts";
import { readCustomTools } from "../../infrastructure/persistence/custom_tools_repository.ts";
import {
  BUILTIN_TOOL_SKILL_DIRS_FILE,
  BuiltInToolSkillDirsRepository,
} from "../../infrastructure/persistence/builtin_tool_skill_dirs_repository.ts";
import {
  CUSTOM_TOOL_SKILL_DIRS_FILE,
  CustomToolSkillDirsRepository,
} from "../../infrastructure/persistence/custom_tool_skill_dirs_repository.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import { BRIEF_HEADER } from "../start/brief.ts";

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

// legacy entry that pre-approves swamp vault read-secret; upgrade removes this
// exact entry
const LEGACY_CLAUDE_VAULT_ALLOW = "Bash(swamp vault:*)";

const KIRO_AUDIT_COMMAND = "swamp audit record --from-hook --tool kiro";
// matches swamp's audit hook command exactly (bare or absolute-path binary,
// nothing after), so upgrade deletes only that and keeps a command the user
// extended
const KIRO_AUDIT_COMMAND_PATTERN =
  /^(?:swamp|"[^"]*swamp(?:\.exe)?"|\S*[\\/]swamp(?:\.exe)?) audit record --from-hook --tool kiro$/;

// legacy Kiro IDE settings that Kiro IDE 1.0 does not read (rules moved to
// permissions.yaml outside the repo); upgrade removes these exact entries
const LEGACY_KIRO_IDE_SETTINGS: Record<string, string> = {
  "kiroAgent.trustedCommands": "swamp *",
  "kiroAgent.commandDenylist": "read-secret",
};

// legacy Amp allowlist entry that Amp does not read as amp.commands; upgrade
// removes this exact entry
const LEGACY_AMP_ALLOW = "swamp *";

function isKiroAuditCommand(command: unknown): boolean {
  return typeof command === "string" &&
    KIRO_AUDIT_COMMAND_PATTERN.test(command.trim());
}

function isKiroAuditHookEntry(hook: unknown): boolean {
  const entry = hook as
    | { trigger?: unknown; action?: { command?: unknown } }
    | null;
  return (entry?.trigger === "PostToolUse" ||
    entry?.trigger === "postToolUse") &&
    isKiroAuditCommand(entry?.action?.command);
}

export type GitignoreAction = "created" | "updated" | "unchanged" | "skipped";

function normalizeToolsList(tools: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of tools) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}

function formatToolsList(tools: string[]): string {
  return tools.length === 0 ? "none" : tools.join(", ");
}

export {
  detectSupersededSkills,
  SUPERSEDED_SKILLS,
} from "./superseded_skills.ts";

export const BUNDLED_SKILL_NAMES = ["swamp", "swamp-getting-started"];

export async function removeLocalBundledSkills(
  localCopies: LocalSkillCopy[],
): Promise<void> {
  for (const copy of localCopies) {
    for (const name of copy.names) {
      const dir = join(copy.skillsDir, name);
      try {
        await Deno.remove(dir, { recursive: true });
        logger.debug`Removed local skill copy ${dir}`;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
  }
}

export async function detectLocalBundledSkills(
  repoDir: string,
  tools: readonly string[],
): Promise<LocalSkillCopy[]> {
  const results: LocalSkillCopy[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const dir = resolveSkillsDir(repoDir, tool);
    if (seen.has(dir)) continue;
    seen.add(dir);

    const found: string[] = [];
    for (const name of BUNDLED_SKILL_NAMES) {
      try {
        await Deno.stat(join(dir, name, "SKILL.md"));
        found.push(name);
      } catch {
        // Not present locally
      }
    }
    if (found.length > 0) {
      results.push({ skillsDir: dir, names: found });
    }
  }
  return results;
}

export interface ExtensionsToReinstall {
  tool: string;
  names: string[];
}

export interface RepoInitResult {
  path: string;
  version: string;
  initializedAt: string;
  skillsCopied: string[];
  instructionsFileCreated: boolean;
  settingsCreated: boolean;
  gitignoreAction: GitignoreAction;
  tools: string[];
  /** tools dropped by a force reinit whose scaffolding files were left on disk */
  removedTools: string[];
  vault: RepoInitVault | null;
}

/**
 * The default vault repo init set up. `created` is false when a vault named
 * `default` already existed and was kept.
 */
export interface RepoInitVault {
  name: string;
  type: string;
  created: boolean;
}

export interface LocalSkillCopy {
  skillsDir: string;
  names: string[];
}

export interface RepoUpgradeResult {
  path: string;
  previousVersion: string;
  newVersion: string;
  upgradedAt: string;
  skillsUpdated: string[];
  instructionsUpdated: boolean;
  settingsUpdated: boolean;
  gitignoreAction: GitignoreAction;
  previousTools: string[];
  tools: string[];
  addedTools: string[];
  removedTools: string[];
  extensionsToReinstall: ExtensionsToReinstall[];
  localSkillCopies: LocalSkillCopy[];
  changedFiles: string[];
  untrustedCollectives: string[];
}

/**
 * tools defaults to ["claude"] when omitted; an empty array means no tool
 * scaffolding
 */
export interface RepoInitOptions {
  force?: boolean;
  tools?: string[];
  serverAddress?: string;
  /**
   * when given, init creates the default local_encryption vault unless one
   * exists and records it as defaultVault (a force reinit keeps the recorded
   * one); omitted means no vault
   */
  defaultVaultStore?: DefaultVaultStore;
}

/**
 * tools: undefined preserves marker.tools, [] clears (--tool none), a list
 * replaces
 */
export interface RepoUpgradeOptions {
  tools?: string[];
  includeGitignore?: boolean;
  /**
   * the caller resolves the lockfile (under managedConfig it lives at the
   * datastore config base); null means unresolved and the check is skipped;
   * omitted reads <modelsDir>/upstream_extensions.json
   */
  lockfilePath?: string | null;
}

/**
 * default to the ambient environment; callers that must keep writes inside a
 * directory they own, tests above all, pass them explicitly instead of
 * repointing the environment
 */
export interface RepoServiceUserDirs {
  homeDir?: string;
  configDir?: string;
}

/**
 * Claude nests commands under matcher entries; Cursor and Copilot list flat
 * command entries with no matcher
 */
export interface AuditHookShape {
  marker: string;
  commandsOf(entry: Record<string, unknown>): string[];
  applies(entry: Record<string, unknown>): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Follows Claude Code's matcher rules: empty, absent and `*` match every
 * tool; a matcher of only letters, digits, `_`, `-`, spaces, `,` and `|` is
 * a list of exact tool names; anything else is an unanchored regex.
 */
function claudeMatcherCoversBash(matcher: unknown): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).some((name) => name.trim() === "Bash");
  }
  try {
    return new RegExp(matcher).test("Bash");
  } catch {
    return false;
  }
}

function flatAuditHookShape(marker: string): AuditHookShape {
  return {
    marker,
    commandsOf: (entry) =>
      typeof entry.command === "string" ? [entry.command] : [],
    applies: () => true,
  };
}

export const CLAUDE_AUDIT_HOOK_SHAPE: AuditHookShape = {
  marker: "swamp audit record --from-hook",
  commandsOf: (entry) =>
    Array.isArray(entry.hooks)
      ? entry.hooks
        .filter(isRecord)
        .map((hook) => hook.command)
        .filter((command): command is string => typeof command === "string")
      : [],
  applies: (entry) => claudeMatcherCoversBash(entry.matcher),
};

const CLAUDE_AUDIT_HOOK_EVENTS = ["PostToolUse", "PostToolUseFailure"];

function claudeAuditHookEntry(matcher: string): Record<string, unknown> {
  return {
    matcher,
    hooks: [{ type: "command", command: "swamp audit record --from-hook" }],
  };
}

/** covers both of Claude Code's shell tools */
export function claudeAuditHooks(): Record<string, unknown[]> {
  return Object.fromEntries(
    CLAUDE_AUDIT_HOOK_EVENTS.map((event) => [
      event,
      [claudeAuditHookEntry("Bash|PowerShell")],
    ]),
  );
}

/** what swamp wrote before the hook matched PowerShell */
export const LEGACY_CLAUDE_AUDIT_HOOK_ENTRY: Readonly<Record<string, unknown>> =
  claudeAuditHookEntry("Bash");

/** mergeAuditHooks alone would count the Bash-only entry as present and never widen it */
export function migrateLegacyClaudeAuditHooks(
  hooks: Record<string, unknown>,
): Record<string, unknown> {
  const legacyJson = JSON.stringify(LEGACY_CLAUDE_AUDIT_HOOK_ENTRY);
  const current = claudeAuditHooks();
  const migrated = { ...hooks };
  for (const event of CLAUDE_AUDIT_HOOK_EVENTS) {
    const entries = migrated[event];
    if (!Array.isArray(entries)) continue;
    migrated[event] = entries.map((entry) =>
      JSON.stringify(entry) === legacyJson ? current[event][0] : entry
    );
  }
  return migrated;
}

export const CURSOR_AUDIT_HOOK_SHAPE: AuditHookShape = flatAuditHookShape(
  "swamp audit record --from-hook --tool cursor",
);

export const COPILOT_AUDIT_HOOK_SHAPE: AuditHookShape = flatAuditHookShape(
  "swamp audit record --from-hook --tool copilot",
);

/**
 * the config is repo-controlled, so entries of an unexpected shape are skipped,
 * never thrown on
 */
export function countAuditHooks(
  entries: unknown,
  shape: AuditHookShape,
): number {
  if (!Array.isArray(entries)) return 0;
  let count = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || !shape.applies(entry)) continue;
    count += shape.commandsOf(entry).filter((command) =>
      command.includes(shape.marker)
    ).length;
  }
  return count;
}

/**
 * an event already running the audit hook keeps it and swamp's entry is not
 * added beside it (two hooks would record every call twice); only entries whose
 * JSON equals swamp's are removed or collapsed
 */
export function mergeAuditHooks(
  existing: Record<string, unknown>,
  ours: Record<string, unknown[]>,
  shape: AuditHookShape,
): Record<string, unknown> {
  const merged = { ...existing };

  for (const [event, ourEntries] of Object.entries(ours)) {
    let entries = Array.isArray(merged[event]) ? merged[event] : [];

    for (const ourEntry of ourEntries) {
      const ourJson = JSON.stringify(ourEntry);
      const isOurs = (entry: unknown) => JSON.stringify(entry) === ourJson;
      const auditHooks = countAuditHooks(entries, shape);
      const ourCopies = entries.filter(isOurs).length;

      if (auditHooks === 0) {
        entries = [...entries, ourEntry];
      } else if (auditHooks > ourCopies) {
        entries = entries.filter((entry) => !isOurs(entry));
      } else if (ourCopies > 1) {
        const first = entries.findIndex(isOurs);
        entries = entries.filter((entry, i) => i === first || !isOurs(entry));
      }
    }

    merged[event] = entries;
  }

  return merged;
}

export class RepoService {
  private readonly markerRepo: RepoMarkerRepository;
  private readonly skillAssets: SkillAssets;
  private readonly currentVersion: SwampVersion;
  private readonly userDirs: RepoServiceUserDirs;

  constructor(version: string, userDirs: RepoServiceUserDirs = {}) {
    this.markerRepo = new RepoMarkerRepository();
    this.skillAssets = new SkillAssets();
    this.currentVersion = SwampVersion.create(version);
    this.userDirs = userDirs;
  }

  /**
   * Resolves `name` inside an injected config dir, or `undefined` to leave the
   * callee on its own environment-resolved default.
   */
  private userConfigPath(name: string): string | undefined {
    const { configDir } = this.userDirs;
    return configDir ? join(configDir, name) : undefined;
  }

  isInitialized(repoPath: RepoPath): Promise<boolean> {
    return this.markerRepo.exists(repoPath);
  }

  async hasOrphanedSwampDir(repoPath: RepoPath): Promise<boolean> {
    try {
      const stat = await Deno.stat(swampPath(repoPath.value));
      return stat.isDirectory;
    } catch {
      return false;
    }
  }

  async init(
    repoPath: RepoPath,
    options: RepoInitOptions = {},
  ): Promise<RepoInitResult> {
    // Before any filesystem work, so a refused URL leaves nothing behind.
    if (options.serverAddress) {
      assertStorableServerAddress(options.serverAddress);
    }

    const tools = normalizeToolsList(options.tools ?? ["claude"]);
    const isAlreadyInit = await this.isInitialized(repoPath);

    let removedTools: string[] = [];
    let existingDefaultVault: string | undefined;

    if (isAlreadyInit) {
      const existingMarker = await this.markerRepo.read(repoPath);
      existingDefaultVault = existingMarker?.defaultVault;
      const existingTools = existingMarker?.tools ?? [];

      if (!options.force) {
        throw markErrorPaths(
          new UserError(
            `Repository already initialized at ${repoPath.value} ` +
              `(tools: ${formatToolsList(existingTools)}). ` +
              "To change the enrolled tools, run: swamp repo upgrade --tool <tool>. " +
              "To reinitialize from scratch, run: swamp repo init --force --tool <tool>",
          ),
          [repoPath.value],
        );
      }

      // --force replaces the tool list; surface the diff so the renderer can
      // tell the user files for dropped tools were not deleted.
      removedTools = existingTools.filter((t) => !tools.includes(t));
    }

    await ensureDir(repoPath.value);

    const markerData = this.markerRepo.createInitMarker(this.currentVersion);
    markerData.tools = tools;
    if (options.serverAddress) {
      markerData.serverAddress = options.serverAddress;
    }

    await this.createDataDirectoryStructure(repoPath);

    let vault: RepoInitVault | null = null;
    if (options.defaultVaultStore) {
      vault = await this.ensureDefaultVault(options.defaultVaultStore);
      markerData.defaultVault = existingDefaultVault ?? vault.name;
    }

    let skillsCopied = await this.installGlobalSkills(tools);

    const resolver = new ToolResolver(repoPath.value, readCustomTools);
    const resolvedConfigs: ToolConfig[] = [];
    let instructionsFileCreated = false;
    let settingsCreated = false;
    const claudeState = await this.readClaudeInstructionsState(repoPath);
    for (const tool of tools) {
      const config = tool === "claude"
        ? claudeToolConfigFor(claudeState)
        : await resolver.resolve(tool);
      resolvedConfigs.push(config);
      const r = await this.applyToolScaffolding(
        repoPath,
        config,
        isAlreadyInit,
      );
      instructionsFileCreated = instructionsFileCreated ||
        r.instructionsFileChanged;
      settingsCreated = settingsCreated || r.settingsChanged;
    }

    await this.installCustomToolGlobalSkills(resolvedConfigs);

    const localSkillNames = await this.installCustomToolLocalSkills(
      repoPath,
      resolvedConfigs,
    );
    if (localSkillNames.length > 0 && skillsCopied.length === 0) {
      skillsCopied = localSkillNames;
    }

    const gitignoreAction = await this.ensureGitignoreSection(
      repoPath,
      resolvedConfigs,
    );
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
      vault,
    };
  }

  /**
   * Creates the default vault unless a vault named `default` already exists,
   * which is kept whatever its type.
   */
  private async ensureDefaultVault(
    store: DefaultVaultStore,
  ): Promise<RepoInitVault> {
    const existing = await store.findByName(DEFAULT_VAULT_NAME);
    if (existing) {
      return { name: existing.name, type: existing.type, created: false };
    }
    const config = createDefaultVaultConfig();
    await store.save(config);
    return { name: config.name, type: config.type, created: true };
  }

  async upgrade(
    repoPath: RepoPath,
    options: RepoUpgradeOptions = {},
  ): Promise<RepoUpgradeResult> {
    const existingMarker = await this.markerRepo.read(repoPath);

    if (!existingMarker) {
      if (await this.hasOrphanedSwampDir(repoPath)) {
        throw markErrorPaths(
          new UserError(
            `Found a .swamp/ directory at ${repoPath.value} but no .swamp.yaml marker — ` +
              "the repository appears partially initialized or corrupted. " +
              "If you previously used a remote datastore, re-initializing with " +
              "'swamp repo init' will not reconnect to it. Restore .swamp.yaml " +
              "from version control or re-initialize with the correct --datastore flag.",
          ),
          [repoPath.value],
        );
      }
      throw markErrorPaths(
        new UserError(
          `Not a swamp repository: ${repoPath.value}. Run 'swamp repo init' first.`,
        ),
        [repoPath.value],
      );
    }

    const oldTools = existingMarker.tools ?? [];
    // The OLD primary tool — resolved BEFORE any mutation. Used to walk for
    // pulled extensions, since that's the directory they actually live in.
    const oldPrimary = resolvePrimaryTool(existingMarker);
    const oldPrimarySkillsDir = resolveSkillsDir(repoPath.value, oldPrimary);

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

    const updatedMarker = this.markerRepo.createUpgradeMarker(
      existingMarker,
      this.currentVersion,
    );
    updatedMarker.tools = tools;

    let skillsUpdated = await this.installGlobalSkills(tools);

    await removeSupersededLocalSkills(repoPath.value, tools);

    const resolver = new ToolResolver(repoPath.value, readCustomTools);
    const resolvedConfigs: ToolConfig[] = [];
    let instructionsUpdated = false;
    let settingsUpdated = false;
    const changedFiles: string[] = [];

    changedFiles.push(".swamp.yaml");

    const claudeState = await this.readClaudeInstructionsState(repoPath);
    for (const tool of tools) {
      const config = tool === "claude"
        ? claudeToolConfigFor(claudeState)
        : await resolver.resolve(tool);
      resolvedConfigs.push(config);
      const r = await this.applyToolScaffolding(repoPath, config, true);
      instructionsUpdated = instructionsUpdated || r.instructionsFileChanged;
      settingsUpdated = settingsUpdated || r.settingsChanged;
      changedFiles.push(...r.changedFiles);
    }

    await this.installCustomToolGlobalSkills(resolvedConfigs);

    const localSkillNames = await this.installCustomToolLocalSkills(
      repoPath,
      resolvedConfigs,
    );
    if (localSkillNames.length > 0 && skillsUpdated.length === 0) {
      skillsUpdated = localSkillNames;
    }

    const shouldManageGitignore = options.includeGitignore ??
      existingMarker.gitignoreManaged ?? false;

    if (options.includeGitignore !== undefined) {
      updatedMarker.gitignoreManaged = options.includeGitignore;
    }

    let gitignoreAction: GitignoreAction;
    if (shouldManageGitignore) {
      gitignoreAction = await this.ensureGitignoreSection(
        repoPath,
        resolvedConfigs,
      );
    } else {
      gitignoreAction = "skipped";
    }

    if (gitignoreAction === "created" || gitignoreAction === "updated") {
      changedFiles.push(".gitignore");
    }

    const localSkillCopies = await detectLocalBundledSkills(
      repoPath.value,
      tools,
    );

    await this.migrateFromSymlinks(repoPath);

    await this.migrateRepoLocalTelemetry(repoPath, existingMarker);

    if (localSkillCopies.length === 0) {
      delete updatedMarker.skillMigrationDismissed;
    }
    // When local copies remain, do NOT set skillMigrationDismissed here —
    // the flag can be set manually in .swamp.yaml for repos that
    // intentionally keep local skills (e.g., the swamp source repo).

    // runtime-state fields do not belong in the tracked .swamp.yaml, so any
    // left there are stripped
    // deno-lint-ignore no-explicit-any
    const raw = updatedMarker as Record<string, any>;
    delete raw.lastSkillMigrationWarning;
    delete raw.lastStalenessWarning;

    await this.markerRepo.write(repoPath, updatedMarker);

    if (!updatedMarker.upgradedAt) {
      throw new Error(
        "Internal error: upgradedAt was not set by createUpgradeMarker",
      );
    }

    const untrustedCollectives = await this.detectUntrustedCollectives(
      repoPath,
      updatedMarker,
      options.lockfilePath,
    );

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
      localSkillCopies,
      changedFiles,
      untrustedCollectives,
    };
  }

  private async installGlobalSkills(
    tools: readonly string[],
  ): Promise<string[]> {
    let globalDirs: string[];
    try {
      globalDirs = resolveUniqueGlobalSkillsDirs(tools, this.userDirs.homeDir);
    } catch {
      logger.warn`Skipping global skill install: home directory not available`;
      return [];
    }

    try {
      const builtInRepo = new BuiltInToolSkillDirsRepository(
        this.userConfigPath(BUILTIN_TOOL_SKILL_DIRS_FILE),
      );
      if (globalDirs.length > 0) {
        await builtInRepo.addDirs(globalDirs);
      } else if (!await builtInRepo.exists()) {
        await builtInRepo.write([]);
      }
    } catch {
      logger.warn`Failed to register built-in tool skill dirs`;
    }

    if (globalDirs.length === 0) return [];

    for (const dir of globalDirs) {
      await this.skillAssets.copySkillsTo(dir);
      await removeSupersededSkills(dir);
      logger.debug`Installed global skills to ${dir}`;
    }
    return this.skillAssets.getSkillNames();
  }

  /**
   * registers each directory in custom-tool-skill-dirs.json so swamp update can
   * discover them
   */
  private async installCustomToolGlobalSkills(
    configs: readonly ToolConfig[],
  ): Promise<void> {
    const customConfigs = configs.filter((c) =>
      !c.isBuiltIn && c.skillsDir.startsWith("~/")
    );
    if (customConfigs.length === 0) return;

    let customToolDirsRepo: CustomToolSkillDirsRepository;
    try {
      customToolDirsRepo = new CustomToolSkillDirsRepository(
        this.userConfigPath(CUSTOM_TOOL_SKILL_DIRS_FILE),
      );
    } catch {
      logger
        .warn`Skipping custom tool global skill install: config directory not available`;
      return;
    }

    for (const config of customConfigs) {
      let home: string;
      try {
        home = this.userDirs.homeDir ?? homeDirectory();
      } catch {
        logger
          .warn`Skipping global skill install for ${config.name}: home directory not available`;
        continue;
      }

      const globalDir = resolve(
        join(home, config.skillsDir.slice(2)),
      );
      if (
        !globalDir.startsWith(home + SEPARATOR) && globalDir !== home
      ) {
        logger
          .warn`Skipping global skill install for ${config.name}: path escapes home directory`;
        continue;
      }

      try {
        await this.skillAssets.copySkillsTo(globalDir);
        await removeSupersededSkills(globalDir);
        logger.debug`Synced global skills to ${globalDir}`;
        await customToolDirsRepo.addDir(globalDir);
      } catch (err) {
        logger
          .warn`Failed to install global skills for custom tool ${config.name}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  /**
   * project-local directories that swamp update cannot discover, so they are
   * only synced during repo init and upgrade
   */
  private async installCustomToolLocalSkills(
    repoPath: RepoPath,
    configs: readonly ToolConfig[],
  ): Promise<string[]> {
    const localConfigs = configs.filter((c) =>
      !c.isBuiltIn && !c.skillsDir.startsWith("~/")
    );
    if (localConfigs.length === 0) return [];

    const seen = new Set<string>();
    let skillNames: string[] = [];

    for (const config of localConfigs) {
      const localDir = join(repoPath.value, config.skillsDir);
      if (seen.has(localDir)) continue;
      seen.add(localDir);

      try {
        await this.skillAssets.copySkillsTo(localDir);
        await removeSupersededSkills(localDir);
        skillNames = this.skillAssets.getSkillNames();
        logger
          .info`Installed local skills to ${localDir} for custom tool ${config.name}`;
      } catch (err) {
        logger
          .warn`Failed to install local skills for custom tool ${config.name}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    return skillNames;
  }

  /**
   * idempotent across calls; alreadyExists picks the update path over create:
   * true for upgrades and force-reinit, false for fresh init
   */
  private async applyToolScaffolding(
    repoPath: RepoPath,
    config: ToolConfig,
    alreadyExists: boolean,
  ): Promise<{
    instructionsFileChanged: boolean;
    settingsChanged: boolean;
    changedFiles: string[];
  }> {
    const changedFiles: string[] = [];

    if (config.name === "none") {
      return {
        instructionsFileChanged: false,
        settingsChanged: false,
        changedFiles,
      };
    }

    if (!config.isBuiltIn) {
      assertPathContained(repoPath.value, config.skillsDir, "skillsDir");
      if (config.instructionsFile) {
        assertPathContained(
          repoPath.value,
          config.instructionsFile,
          "instructionsFile",
        );
      }
    }

    const instructionsFileChanged = alreadyExists
      ? await this.updateInstructionsFile(repoPath, config)
      : await this.createInstructionsFileIfNotExists(repoPath, config);

    if (instructionsFileChanged && config.instructionsFile) {
      changedFiles.push(config.instructionsFile);
    }

    let settingsChanged = false;
    if (config.isBuiltIn) {
      const tool = config.name as AiTool;
      switch (tool) {
        case "claude": {
          const changed = alreadyExists
            ? await this.updateClaudeSettings(repoPath)
            : await this.createClaudeSettingsIfNotExists(repoPath);
          settingsChanged = changed;
          if (changed) changedFiles.push(".claude/settings.local.json");
          break;
        }
        case "cursor": {
          const changed = alreadyExists
            ? await this.updateCursorHooks(repoPath)
            : await this.createCursorHooksIfNotExists(repoPath);
          settingsChanged = changed;
          if (changed) changedFiles.push(".cursor/hooks.json");
          break;
        }
        case "kiro": {
          const s = alreadyExists &&
            await this.removeLegacyKiroIdeSettings(repoPath);
          const h = alreadyExists
            ? await this.updateKiroHooks(repoPath)
            : await this.createKiroHooksIfNotExists(repoPath);
          const a = alreadyExists
            ? await this.updateKiroAgentConfig(repoPath)
            : await this.createKiroAgentConfigIfNotExists(repoPath);
          const c = await this.ensureKiroCliDefaultAgent(repoPath);
          settingsChanged = s || h.length > 0 || a || c;
          if (s) changedFiles.push(".vscode/settings.local.json");
          for (const path of h) changedFiles.push(path);
          if (a) changedFiles.push(".kiro/agents/swamp.json");
          if (c) changedFiles.push(".kiro/settings/cli.json");
          break;
        }
        case "opencode": {
          const changed = alreadyExists
            ? await this.updateOpenCodePlugin(repoPath)
            : await this.createOpenCodePluginIfNotExists(repoPath);
          settingsChanged = changed;
          if (changed) changedFiles.push(".opencode/plugins/swamp-audit.ts");
          break;
        }
        case "copilot": {
          const changed = alreadyExists
            ? await this.updateCopilotHooks(repoPath)
            : await this.createCopilotHooksIfNotExists(repoPath);
          settingsChanged = changed;
          if (changed) changedFiles.push(".github/hooks/swamp-audit.json");
          break;
        }
        case "amp": {
          const p = alreadyExists
            ? await this.updateAmpPlugin(repoPath)
            : await this.createAmpPluginIfNotExists(repoPath);
          const s = alreadyExists &&
            await this.removeLegacyAmpCommands(repoPath);
          settingsChanged = p || s;
          if (p) changedFiles.push(".amp/plugins/swamp.ts");
          if (s) changedFiles.push(".amp/settings.json");
          break;
        }
        case "pi": {
          const changed = alreadyExists
            ? await this.updatePiExtension(repoPath)
            : await this.createPiExtensionIfNotExists(repoPath);
          settingsChanged = changed;
          if (changed) changedFiles.push(".pi/extensions/swamp-audit.ts");
          break;
        }
        case "antigravity": {
          const changed = alreadyExists
            ? await this.updateAntiGravityHooks(repoPath)
            : await this.createAntiGravityHooksIfNotExists(repoPath);
          settingsChanged = changed;
          if (changed) changedFiles.push(".agents/hooks.json");
          break;
        }
        case "codex":
        case "none":
          break;
        default:
          assertNever(tool);
      }
    }

    return { instructionsFileChanged, settingsChanged, changedFiles };
  }

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

  /** failures are swallowed: a missing or corrupt lockfile yields an empty list */
  private async detectUntrustedCollectives(
    repoPath: RepoPath,
    marker: RepoMarkerData,
    resolvedLockfilePath?: string | null,
  ): Promise<string[]> {
    if (resolvedLockfilePath === null) return [];
    const lockfilePath = resolvedLockfilePath ?? join(
      repoPath.value,
      marker.modelsDir ?? "extensions/models",
      "upstream_extensions.json",
    );
    let entries: Record<string, unknown>;
    try {
      entries = await readUpstreamExtensions(lockfilePath);
    } catch {
      return [];
    }

    // When trustMemberCollectives is on, all the user's membership
    // collectives are trusted at runtime. We don't have auth context
    // during upgrade to know which those are, so skip the warning
    // entirely to avoid false positives.
    if (marker.trustMemberCollectives === true) return [];

    const lockfileCollectives = new Set<string>();
    for (const name of Object.keys(entries)) {
      if (name.startsWith("@")) {
        const slash = name.indexOf("/", 1);
        if (slash !== -1) {
          lockfileCollectives.add(name.slice(1, slash));
        }
      }
    }

    if (lockfileCollectives.size === 0) return [];

    const trusted = new Set(
      marker.trustedCollectives ?? ["swamp"],
    );

    return [...lockfileCollectives]
      .filter((c) => !trusted.has(c))
      .sort();
  }

  getMarker(repoPath: RepoPath): Promise<RepoMarkerData | null> {
    return this.markerRepo.read(repoPath);
  }

  /**
   * taken once, before any tool writes, so the choice does not depend on the
   * order tools are listed in
   */
  private async readClaudeInstructionsState(
    repoPath: RepoPath,
  ): Promise<ClaudeInstructionsState> {
    const path = (relative: string) => join(repoPath.value, relative);
    // a file that cannot be read or stat'ed counts as absent, so the choice
    // falls back to CLAUDE.md rather than failing
    const readIfExists = async (relative: string): Promise<string | null> => {
      try {
        return await Deno.readTextFile(path(relative));
      } catch {
        return null;
      }
    };
    const lstatIfExists = async (
      relative: string,
    ): Promise<Deno.FileInfo | null> => {
      try {
        return await Deno.lstat(path(relative));
      } catch {
        return null;
      }
    };
    const claudeMd = await readIfExists("CLAUDE.md");
    const agentsMd = await readIfExists("AGENTS.md");
    // The marked section body contains the legacy signature too, so only
    // unmarked content counts as legacy.
    const isLegacy = (content: string) =>
      !content.includes(INSTRUCTIONS_SECTION_BEGIN) &&
      this.hasLegacyInstructionsContent(content);
    return {
      rulesFileExists: (await lstatIfExists(CLAUDE_RULES_FILE)) !== null,
      claudeMdExists: claudeMd !== null,
      claudeMdIsSymlink: (await lstatIfExists("CLAUDE.md"))?.isSymlink ??
        false,
      claudeMdHasSwampSection: claudeMd !== null &&
        (claudeMd.includes(INSTRUCTIONS_SECTION_BEGIN) || isLegacy(claudeMd)),
      claudeMdHasUserContent: claudeMd !== null &&
        this.hasContentOutsideManagedSection(claudeMd),
      agentsMdHasUserContent: agentsMd !== null && !isLegacy(agentsMd) &&
        this.hasContentOutsideManagedSection(agentsMd),
    };
  }

  /**
   * True when the file has non-whitespace text outside a complete swamp
   * managed section. A file with legacy (unmarked) swamp content or an
   * orphaned marker counts as having user content, so callers stay on the
   * conservative path.
   */
  private hasContentOutsideManagedSection(content: string): boolean {
    const begin = content.indexOf(INSTRUCTIONS_SECTION_BEGIN);
    const end = content.indexOf(INSTRUCTIONS_SECTION_END);
    if (begin === -1 || end === -1 || end < begin) {
      return content.trim().length > 0;
    }
    const outside = content.substring(0, begin) +
      content.substring(end + INSTRUCTIONS_SECTION_END.length);
    return outside.trim().length > 0;
  }

  private async createInstructionsFileIfNotExists(
    repoPath: RepoPath,
    config: ToolConfig,
  ): Promise<boolean> {
    if (!config.instructionsFile) return false;
    const filePath = join(repoPath.value, config.instructionsFile);

    if (config.instructionsMode === "shared") {
      return this.ensureInstructionsSection(filePath, config);
    }

    // For tool-specific files, only create if missing. The atomic write
    // replaces a dangling symlink instead of creating its target, which may
    // sit outside the repo.
    try {
      await Deno.stat(filePath);
      return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const parentDir = join(filePath, "..");
        await ensureDir(parentDir);
        await atomicWriteTextFile(
          filePath,
          this.generateInstructionsContent(config),
        );
        return true;
      }
      throw error;
    }
  }

  private updateInstructionsFile(
    repoPath: RepoPath,
    config: ToolConfig,
  ): Promise<boolean> {
    if (!config.instructionsFile) return Promise.resolve(false);
    const filePath = join(repoPath.value, config.instructionsFile);
    if (config.instructionsMode !== "shared") {
      return this.overwriteIfChanged(
        filePath,
        this.generateInstructionsContent(config),
      );
    }
    return this.ensureInstructionsSection(filePath, config);
  }

  private async ensureInstructionsSection(
    filePath: string,
    config: ToolConfig,
  ): Promise<boolean> {
    const newSection = this.buildInstructionsSection(config);

    let existingContent: string | null = null;
    try {
      existingContent = await Deno.readTextFile(filePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    if (existingContent === null) {
      await ensureDir(join(filePath, ".."));
      const prefix = config.frontmatter ?? "";
      await Deno.writeTextFile(filePath, prefix + newSection + "\n");
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

    if (this.hasLegacyInstructionsContent(existingContent)) {
      const updatedContent = this.migrateLegacyInstructions(
        existingContent,
        newSection,
      );
      await atomicWriteTextFile(filePath, updatedContent);
      return true;
    }

    const separator = existingContent.startsWith("\n") ? "" : "\n";
    await atomicWriteTextFile(
      filePath,
      newSection + "\n" + separator + existingContent,
    );
    return true;
  }

  private hasLegacyInstructionsContent(content: string): boolean {
    return content.includes(LEGACY_INSTRUCTIONS_SIGNATURE);
  }

  private migrateLegacyInstructions(
    content: string,
    newSection: string,
  ): string {
    const startPattern =
      /# Project\n\nThis repository is managed with \[swamp\]/;
    const startMatch = startPattern.exec(content);

    if (!startMatch) {
      const separator = content.startsWith("\n") ? "" : "\n";
      return newSection + "\n" + separator + content;
    }

    const endMarkers = [
      "scopes to a subtree.\n",
      "Use `swamp --help` to see available commands.\n",
    ];
    let endIndex = -1;
    let endMarker = "";
    for (const marker of endMarkers) {
      endIndex = content.indexOf(marker, startMatch.index);
      if (endIndex !== -1) {
        endMarker = marker;
        break;
      }
    }

    if (endIndex === -1) {
      // the user edited the template, so where it ends is unknown: prepend the
      // managed section to keep all existing content, even if some template
      // text is duplicated
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

  private generateInstructionsBody(config: ToolConfig): string {
    const skillsDir = config.skillsDir;
    const useSkillNames = config.skillReferenceStyle === "name";

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
      ? `If you were asked to read a task brief under \`tasks/\` (a file whose first
line is \`${BRIEF_HEADER}\`), read that brief, then invoke the
\`swamp-getting-started\` skill and follow it from its brief entry point.

If the user is new to swamp or asks to get started, or a swamp command you
run shows this repository has no behaviors yet, invoke the
\`swamp-getting-started\` skill. It checks for existing behaviors itself and walks
new users through an interactive onboarding tutorial.

Otherwise, use the \`swamp\` skill to work with swamp behaviors.`
      : `If you were asked to read a task brief under \`tasks/\` (a file whose first
line is \`${BRIEF_HEADER}\`), read that brief, then read
\`${skillsDir}/swamp-getting-started/SKILL.md\` and follow it from its brief
entry point.

If the user is new to swamp or asks to get started, or a swamp command you
run shows this repository has no behaviors yet, read
\`${skillsDir}/swamp-getting-started/SKILL.md\` and follow its instructions. It
checks for existing behaviors itself and walks new users through an interactive
onboarding tutorial.

Otherwise, read \`${skillsDir}/swamp/SKILL.md\` to work with swamp behaviors.`;

    return `# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search community extensions with \`swamp extension search <query>\` — prefer \`@swamp/*\` official extensions first, (b) search local/installed types with \`swamp behavior type search <query>\`, (c) if a community extension exists, install it with \`swamp extension pull <package>\` instead of building from scratch, (d) extend an existing type if it covers the domain but lacks the method you need, (e) only create a custom extension behavior in \`extensions/models/\` as a last resort. ${
      skillAction("swamp", "Use")
    } for guidance. The \`command/shell\` behavior is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a behavior covers the domain but lacks the method you need, extend it with \`export const extension\` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use \`swamp behavior type describe <type> --json\` to check available methods.
3. **Use the data model.** Once data exists in a behavior (via \`lookup\`, \`start\`, \`sync\`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire behaviors together with CEL expressions. Always prefer \`data.latest("<name>", "<dataName>").attributes.<field>\` over the deprecated \`model.<name>.resource.<spec>.<instance>.attributes.<field>\` pattern.
5. **Verify before destructive operations.** Always \`swamp behavior get <name> --json\` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate \`swamp behavior run\` calls against the same behavior. Multiple parallel calls against the same behavior contend on the per-behavior lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check \`swamp behavior type describe\` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled; pin them.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. When the extension has a \`deno.json\`, the \`deno.lock\` beside it decides which versions are bundled; otherwise the registry's current release does. Always pin explicit versions in \`npm:\` and \`jsr:\` import specifiers (e.g., \`npm:lodash-es@4.17.21\`) — \`swamp extension push\` warns on unpinned and range specifiers.
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze behavior output (security reports, cost analysis, compliance checks, summaries), create a report extension. ${
      skillAction("swamp", "Use")
    } for guidance.
9. **"Workflow" means a swamp workflow.** In this repository the word "workflow" (and "create/run/execute/validate/debug workflow", "automate", "orchestrate", "automated/nightly job") refers to a swamp workflow — a declarative YAML DAG of behavior-method steps authored via \`swamp workflow create\`. ${
      skillAction("swamp", "Load and follow")
    } for these requests. Do NOT interpret these as a request to build an agent task list, spin up worktrees, or schedule a cron/remote agent. Only use those orchestration mechanisms when the user explicitly names one (e.g. "task list", "subagent", "worktree", "cron", "remote agent") or explicitly asks you to do the work yourself step by step rather than author a swamp workflow.
10. **Use swamp, don't bypass it.** Always work through swamp commands — don't go around them with raw shell tools. Use \`swamp data query\` to find data, not \`grep\`/\`find\` on \`.swamp/\` files. Use behavior methods to interact with resources, not \`curl\`/\`aws\`/\`gcloud\`/\`kubectl\` when a behavior type already wraps that API — check with \`swamp behavior type search\`. Use \`swamp help\` for CLI discovery, not guesswork. Composing with swamp output is fine (e.g. piping \`--json\` through \`jq\`) — the anti-pattern is bypassing swamp entirely.
11. **Inspect reports after failures.** When a behavior method or workflow run fails, inspect its generated reports before retrying or changing definitions. Reports run even on failure and capture structured diagnostics — error messages, execution status, arguments, and data output pointers. Use \`swamp report get @swamp/method-summary --model <model> --json\` for method failures or \`swamp report get @swamp/workflow-summary --workflow <workflow> --json\` for workflow failures. Run \`swamp help report get\` to confirm current retrieval syntax.

## Skills

${skillsIntro}

${
      skillListEntry(
        "swamp",
        "Swamp CLI — behaviors, workflows, data, vaults, extensions, publishing, repos, reports, issues, and troubleshooting",
      )
    }
${
      skillListEntry(
        "swamp-getting-started",
        "Interactive onboarding for new swamp users",
      )
    }

## Getting Started

${gettingStarted}

## Commands

Use \`swamp --help\` to see available commands. For a machine-readable JSON
schema of the CLI (commands, options, arguments) intended for agent
consumption, run \`swamp help [<command>...]\` — e.g. \`swamp help\` returns
the full tree, and \`swamp help behavior run\` scopes to a subtree.

Behaviors (formerly models) are managed with \`swamp behavior\` — e.g.
\`swamp behavior run <name> <method>\` (or
\`swamp behavior run @<type> <method> <name>\` to run against a type
directly). Every \`swamp model …\` spelling remains supported.
`;
  }

  private buildInstructionsSection(config: ToolConfig): string {
    const body = this.generateInstructionsBody(config);
    const agentsImport = config.importAgentsMd ? "\n@AGENTS.md\n" : "";
    return INSTRUCTIONS_SECTION_BEGIN + "\n" + body + agentsImport +
      INSTRUCTIONS_SECTION_END;
  }

  private generateInstructionsContent(config: ToolConfig): string {
    const body = this.generateInstructionsBody(config);
    if (config.frontmatter) {
      return config.frontmatter + body;
    }
    return body;
  }

  private async ensureGitignoreSection(
    repoPath: RepoPath,
    configs: ToolConfig[],
  ): Promise<GitignoreAction> {
    const gitignorePath = join(repoPath.value, GITIGNORE_FILENAME);
    const newSection = this.buildGitignoreSection(configs);

    let existingContent: string | null = null;
    try {
      existingContent = await Deno.readTextFile(gitignorePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    if (existingContent === null) {
      await Deno.writeTextFile(gitignorePath, newSection + "\n");
      return "created";
    }

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

    if (existingContent.includes(GITIGNORE_LEGACY_HEADER)) {
      const updatedContent = this.migrateLegacyGitignore(
        existingContent,
        newSection,
      );
      await atomicWriteTextFile(gitignorePath, updatedContent);
      return "updated";
    }

    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    await atomicWriteTextFile(
      gitignorePath,
      existingContent + separator + newSection + "\n",
    );
    return "updated";
  }

  private buildGitignoreSection(configs: ToolConfig[]): string {
    const body = this.generateGitignoreSectionBody(configs);
    return GITIGNORE_SECTION_BEGIN + "\n" + body + GITIGNORE_SECTION_END;
  }

  private generateGitignoreSectionBody(configs: ToolConfig[]): string {
    const lines = [
      "",
      "# Runtime data (not needed in version control)",
      ".swamp/",
      "",
      "# Local extension sources (developer-specific, not shared)",
      ".swamp-sources.yaml",
    ];

    const seenEntries = new Set<string>();
    for (const config of configs) {
      const toolEntry = config.gitignoreEntries;
      if (toolEntry && !seenEntries.has(toolEntry)) {
        seenEntries.add(toolEntry);
        lines.push("", toolEntry);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

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

    const secondBegin = content.indexOf(beginMarker, beginIndex + 1);
    const secondEnd = content.indexOf(endMarker, endIndex + 1);
    if (secondBegin !== -1 || secondEnd !== -1) {
      throw new UserError(
        "Found multiple swamp managed sections in file. " +
          "Please remove the duplicate section and run the command again.",
      );
    }

    const endOfEndMarker = endIndex + endMarker.length;
    const nextChar = content[endOfEndMarker];
    const endSlice = nextChar === "\n" ? endOfEndMarker + 1 : endOfEndMarker;

    const before = content.substring(0, beginIndex);
    const after = content.substring(endSlice);

    return before + newSection + "\n" + after;
  }

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

  private getClaudeAllowedCommands(): string[] {
    return [
      // each preferred swamp behavior command follows its legacy swamp model
      // twin, and the British behaviour alias follows each, since a permission
      // pattern matches the typed words
      "Bash(swamp model type search:*)",
      "Bash(swamp behavior type search:*)",
      "Bash(swamp behaviour type search:*)",
      "Bash(swamp model type describe:*)",
      "Bash(swamp behavior type describe:*)",
      "Bash(swamp behaviour type describe:*)",
      "Bash(swamp model search:*)",
      "Bash(swamp behavior search:*)",
      "Bash(swamp behaviour search:*)",
      "Bash(swamp model create:*)",
      "Bash(swamp behavior create:*)",
      "Bash(swamp behaviour create:*)",
      "Bash(swamp model edit:*)",
      "Bash(swamp behavior edit:*)",
      "Bash(swamp behaviour edit:*)",
      "Bash(swamp model delete:*)",
      "Bash(swamp behavior delete:*)",
      "Bash(swamp behaviour delete:*)",
      "Bash(swamp model get:*)",
      "Bash(swamp behavior get:*)",
      "Bash(swamp behaviour get:*)",
      "Bash(swamp model validate:*)",
      "Bash(swamp behavior validate:*)",
      "Bash(swamp behaviour validate:*)",
      "Bash(swamp model output:*)",
      "Bash(swamp behavior output:*)",
      "Bash(swamp behaviour output:*)",
      "Bash(swamp model method history:*)",
      "Bash(swamp behavior history:*)",
      "Bash(swamp behaviour history:*)",
      "Bash(swamp workflow search:*)",
      "Bash(swamp workflow create:*)",
      "Bash(swamp workflow edit:*)",
      "Bash(swamp workflow delete:*)",
      "Bash(swamp workflow get:*)",
      "Bash(swamp workflow validate:*)",
      "Bash(swamp workflow schema:*)",
      "Bash(swamp workflow history:*)",
      // every vault subcommand except read-secret, which reveals a secret value
      // and must ask first
      "Bash(swamp vault type:*)",
      "Bash(swamp vault search:*)",
      "Bash(swamp vault list:*)",
      "Bash(swamp vault get:*)",
      "Bash(swamp vault describe:*)",
      "Bash(swamp vault inspect:*)",
      "Bash(swamp vault list-keys:*)",
      "Bash(swamp vault audit-trail:*)",
      "Bash(swamp vault create:*)",
      "Bash(swamp vault edit:*)",
      "Bash(swamp vault put:*)",
      "Bash(swamp vault write-secret:*)",
      "Bash(swamp vault delete:*)",
      "Bash(swamp vault annotate:*)",
      "Bash(swamp vault migrate:*)",
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

  private generateClaudeSettingsContent(): string {
    const settings = {
      permissions: {
        allow: this.getClaudeAllowedCommands(),
      },
      hooks: this.getClaudeHooks(),
    };
    return JSON.stringify(settings, null, 2) + "\n";
  }

  private getClaudeHooks(): Record<string, unknown[]> {
    return claudeAuditHooks();
  }

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

  private createClaudeSettingsIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const settingsPath = join(repoPath.value, ".claude", "settings.local.json");
    return this.createFileIfNotExists(
      settingsPath,
      this.generateClaudeSettingsContent(),
    );
  }

  private async updateClaudeSettings(repoPath: RepoPath): Promise<boolean> {
    const claudeDir = join(repoPath.value, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");

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
    }

    const ourCommands = this.getClaudeAllowedCommands();

    // merge with existing permissions, dropping the vault wildcard because it
    // pre-approves read-secret
    const existingAllow = existingSettings.permissions?.allow ?? [];
    const keptAllow = existingAllow.filter((cmd) =>
      cmd !== LEGACY_CLAUDE_VAULT_ALLOW
    );
    const mergedAllow = [...new Set([...keptAllow, ...ourCommands])];

    const ourHooks = this.getClaudeHooks();
    const mergedHooks = mergeAuditHooks(
      migrateLegacyClaudeAuditHooks(existingSettings.hooks ?? {}),
      ourHooks,
      CLAUDE_AUDIT_HOOK_SHAPE,
    );

    const permissionsChanged = mergedAllow.length !== existingAllow.length ||
      keptAllow.length !== existingAllow.length ||
      !ourCommands.every((cmd) => existingAllow.includes(cmd));
    const hooksChanged = JSON.stringify(existingSettings.hooks ?? {}) !==
      JSON.stringify(mergedHooks);
    const hasChanges = permissionsChanged || hooksChanged;

    if (!hasChanges && settingsExisted) {
      return false;
    }

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
   * Amp runs tools without asking by default and ignores amp.commands, so
   * command control goes through a plugin that asks before a shell command
   * reads a vault secret
   */
  private generateAmpPluginContent(): string {
    return `// Swamp permissions plugin for Amp
// Asks before running a shell command that reads a vault secret, and allows
// every other tool call (Amp's default).
// This is a managed file — it will be overwritten on swamp upgrade.

import type { PluginAPI } from "@ampcode/plugin";

export const description = "Asks before running swamp vault read-secret; allows every other tool call.";

export default function (amp: PluginAPI) {
  amp.on("tool.call", async (event, ctx) => {
    const shell = amp.helpers.shellCommandFromToolCall(event);
    if (!shell || !shell.command.includes("read-secret")) {
      return { action: "allow" };
    }
    try {
      const approved = await ctx.ui.confirm({
        title: "Allow swamp vault read-secret?",
        message: shell.command,
        confirmButtonText: "Allow",
        requireHuman: true,
        skipIfUnwatched: true,
      });
      if (approved) return { action: "allow" };
    } catch {
      // No one to ask (e.g. amp --execute): refuse rather than run it.
    }
    return {
      action: "reject-and-continue",
      message: "The user did not approve reading a vault secret: " +
        shell.command,
    };
  });
}
`;
  }

  private createAmpPluginIfNotExists(repoPath: RepoPath): Promise<boolean> {
    return this.createFileIfNotExists(
      join(repoPath.value, ".amp", "plugins", "swamp.ts"),
      this.generateAmpPluginContent(),
    );
  }

  private updateAmpPlugin(repoPath: RepoPath): Promise<boolean> {
    return this.overwriteIfChanged(
      join(repoPath.value, ".amp", "plugins", "swamp.ts"),
      this.generateAmpPluginContent(),
    );
  }

  /**
   * upgrade leaves an absent, non-regular or non-object file alone rather than
   * failing over a file swamp does not need; it warns unless quiet (the user's
   * own files)
   */
  private async readLegacyJsonFile(
    path: string,
    quiet = false,
  ): Promise<Record<string, unknown> | undefined> {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    if (!info.isFile) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(path));
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      if (!quiet) {
        logger.warn`Leaving ${path} unchanged: it does not hold a JSON object`;
      }
      return undefined;
    }
    return parsed as Record<string, unknown>;
  }

  private async writeOrRemoveSettingsFile(
    path: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(settings).length === 0) {
      await Deno.remove(path);
      return;
    }
    await atomicWriteTextFile(path, JSON.stringify(settings, null, 2) + "\n");
  }

  /**
   * keeps the user's own entries and settings; the block goes when only strict
   * is left in it, and the file goes when nothing is left
   */
  private async removeLegacyAmpCommands(repoPath: RepoPath): Promise<boolean> {
    const settingsPath = join(repoPath.value, ".amp", "settings.json");
    const settings = await this.readLegacyJsonFile(settingsPath);
    const commands = settings?.["amp.commands"];
    if (
      !settings || typeof commands !== "object" || commands === null ||
      Array.isArray(commands)
    ) {
      return false;
    }
    const block: Record<string, unknown> = { ...commands };
    const allowlist = block.allowlist;
    if (!Array.isArray(allowlist) || !allowlist.includes(LEGACY_AMP_ALLOW)) {
      return false;
    }

    const kept = allowlist.filter((entry) => entry !== LEGACY_AMP_ALLOW);
    if (kept.length === 0) delete block.allowlist;
    else block.allowlist = kept;
    if (Object.keys(block).every((key) => key === "strict")) {
      delete settings["amp.commands"];
    } else {
      settings["amp.commands"] = block;
    }
    await this.writeOrRemoveSettingsFile(settingsPath, settings);
    return true;
  }

  /**
   * keeps the user's own entries and settings; an emptied key is dropped, and
   * the file goes when nothing is left
   */
  private async removeLegacyKiroIdeSettings(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const settingsPath = join(repoPath.value, ".vscode", "settings.local.json");
    const settings = await this.readLegacyJsonFile(settingsPath);
    if (!settings) return false;

    let changed = false;
    for (const [key, entry] of Object.entries(LEGACY_KIRO_IDE_SETTINGS)) {
      const list = settings[key];
      if (!Array.isArray(list) || !list.includes(entry)) continue;
      const kept = list.filter((item) => item !== entry);
      if (kept.length === 0) delete settings[key];
      else settings[key] = kept;
      changed = true;
    }
    if (!changed) return false;

    await this.writeOrRemoveSettingsFile(settingsPath, settings);
    return true;
  }

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

  private createCursorHooksIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const hooksPath = join(repoPath.value, ".cursor", "hooks.json");
    return this.createFileIfNotExists(
      hooksPath,
      this.generateCursorHooksContent(),
    );
  }

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

    const mergedHooks = mergeAuditHooks(
      existingHooks.hooks ?? {},
      ourHooks,
      CURSOR_AUDIT_HOOK_SHAPE,
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
   * uses Kiro's v1 hook schema, since Kiro IDE 1.0 does not run legacy
   * .kiro.hook files
   */
  private generateKiroHookContent(): string {
    const hooks = {
      version: "v1",
      hooks: [
        {
          name: "swamp-audit",
          trigger: "PostToolUse",
          action: { type: "command", command: KIRO_AUDIT_COMMAND },
          timeout: 5,
        },
      ],
    };
    return JSON.stringify(hooks, null, 2) + "\n";
  }

  private async createKiroHooksIfNotExists(
    repoPath: RepoPath,
  ): Promise<string[]> {
    const created = await this.createFileIfNotExists(
      join(repoPath.value, ".kiro", "hooks", "swamp-audit.json"),
      this.generateKiroHookContent(),
    );
    return created ? [".kiro/hooks/swamp-audit.json"] : [];
  }

  /**
   * always overwrites, and removes the legacy swamp-audit.kiro.hook and
   * audit-hook copies in other v1 hook files, each of which would record every
   * tool call again
   */
  private async updateKiroHooks(repoPath: RepoPath): Promise<string[]> {
    const hooksDir = join(repoPath.value, ".kiro", "hooks");
    const changed: string[] = [];

    const written = await this.overwriteIfChanged(
      join(hooksDir, "swamp-audit.json"),
      this.generateKiroHookContent(),
    );
    if (written) changed.push(".kiro/hooks/swamp-audit.json");

    const legacyPath = join(hooksDir, "swamp-audit.kiro.hook");
    if (await this.removeLegacyKiroHookFile(legacyPath)) {
      changed.push(".kiro/hooks/swamp-audit.kiro.hook");
    }

    const otherHookFiles: string[] = [];
    for await (const entry of Deno.readDir(hooksDir)) {
      if (
        entry.isFile && entry.name.endsWith(".json") &&
        entry.name !== "swamp-audit.json"
      ) {
        otherHookFiles.push(entry.name);
      }
    }
    for (const name of otherHookFiles.sort()) {
      if (await this.removeKiroAuditHookCopies(join(hooksDir, name))) {
        changed.push(`.kiro/hooks/${name}`);
      }
    }
    return changed;
  }

  /**
   * deletes the Kiro IDE 0.x hook file only if it is still swamp's audit hook;
   * any other file at that path is left alone
   */
  private async removeLegacyKiroHookFile(path: string): Promise<boolean> {
    const hook = await this.readLegacyJsonFile(path);
    const then = hook?.then as { command?: unknown } | undefined;
    if (!isKiroAuditCommand(then?.command)) return false;
    await Deno.remove(path);
    return true;
  }

  /**
   * removes post-tool entries running swamp's audit hook command, however the
   * binary is spelled; the file is deleted only when no hooks and no other
   * settings are left
   */
  private async removeKiroAuditHookCopies(path: string): Promise<boolean> {
    // Any hook file can be swept, most of them the user's own, so one that
    // does not parse is skipped without a warning on every upgrade.
    const file = await this.readLegacyJsonFile(path, true);
    if (file?.version !== "v1" || !Array.isArray(file.hooks)) return false;

    const kept = file.hooks.filter((hook) => !isKiroAuditHookEntry(hook));
    if (kept.length === file.hooks.length) return false;

    const onlyHooks = Object.keys(file).every((key) =>
      key === "version" || key === "hooks"
    );
    if (kept.length === 0 && onlyHooks) {
      await Deno.remove(path);
    } else {
      await atomicWriteTextFile(
        path,
        JSON.stringify({ ...file, hooks: kept }, null, 2) + "\n",
      );
    }
    return true;
  }

  private generateCopilotHooksContent(): string {
    const hooks = {
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: "command",
            command: "swamp audit record --from-hook --tool copilot",
          },
        ],
        postToolUseFailure: [
          {
            type: "command",
            command: "swamp audit record --from-hook --tool copilot",
          },
        ],
      },
    };
    return JSON.stringify(hooks, null, 2) + "\n";
  }

  private createCopilotHooksIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const hooksPath = join(
      repoPath.value,
      ".github",
      "hooks",
      "swamp-audit.json",
    );
    return this.createFileIfNotExists(
      hooksPath,
      this.generateCopilotHooksContent(),
    );
  }

  private async updateCopilotHooks(repoPath: RepoPath): Promise<boolean> {
    const githubDir = join(repoPath.value, ".github", "hooks");
    const hooksPath = join(githubDir, "swamp-audit.json");

    await ensureDir(githubDir);

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
        {
          type: "command",
          command: "swamp audit record --from-hook --tool copilot",
        },
      ],
      postToolUseFailure: [
        {
          type: "command",
          command: "swamp audit record --from-hook --tool copilot",
        },
      ],
    };

    const mergedHooks = mergeAuditHooks(
      existingHooks.hooks ?? {},
      ourHooks,
      COPILOT_AUDIT_HOOK_SHAPE,
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
   * kiro-cli universal format: 2.x toolsSettings plus mirroring 3.0
   * permissions.rules; keep tools sorted and rule sets equivalent or kiro-cli
   * reports the profile out of sync; Kiro IDE ignores configs with hooks
   */
  private generateKiroAgentConfigContent(): string {
    const config = {
      name: "swamp",
      description: "Swamp automation agent with audit tracking",
      // kiro-cli's agent schema only accepts explicit tool names from its
      // built-in list. Using "*" silently fails parsing and kiro-cli falls
      // back to the default agent, skipping the postToolUse audit hook.
      tools: [
        "glob",
        "grep",
        "read",
        "shell",
        "thinking",
        "todo_list",
        "write",
      ],
      resources: [
        "file://.kiro/steering/**/*.md",
        "skill://~/.kiro/skills/**/SKILL.md",
      ],
      toolsSettings: {
        shell: {
          allowedCommands: ["swamp .*"],
          // denied wins over allowed: kiro-cli blocks a denied command rather
          // than asking, and its regex has no look-ahead to exclude read-secret
          // from the allow pattern
          deniedCommands: [".*read-secret.*"],
        },
      },
      // The 3.0 engine could ask before read-secret, but kiro-cli reports an
      // ask rule as out of sync with the 2.x deniedCommands, so both deny.
      permissions: {
        rules: [
          { capability: "shell", match: ["swamp *"], effect: "allow" },
          { capability: "shell", match: ["*read-secret*"], effect: "deny" },
        ],
      },
      hooks: [
        {
          name: "swamp-audit",
          trigger: "postToolUse",
          action: { type: "command", command: KIRO_AUDIT_COMMAND },
          timeout: 10,
        },
      ],
    };
    return JSON.stringify(config, null, 2) + "\n";
  }

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
      this.generateKiroAgentConfigContent(),
    );
  }

  private async updateKiroAgentConfig(repoPath: RepoPath): Promise<boolean> {
    const configPath = join(
      repoPath.value,
      ".kiro",
      "agents",
      "swamp.json",
    );
    return await this.overwriteIfChanged(
      configPath,
      this.generateKiroAgentConfigContent(),
    );
  }

  /**
   * without this, plain kiro-cli chat loads the built-in default agent and the
   * audit hook never fires; an existing non-swamp chat.defaultAgent wins with a
   * warning; unrelated settings are kept
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
   * one file serves OpenCode 1.3.4+ (default.server) and OpenCode 2 (default
   * object with id and setup); builds before 1.3.4 call every export as a
   * function and cannot load it
   */
  private generateOpenCodePluginContent(): string {
    return `// Swamp audit plugin for OpenCode
// Records shell tool invocations for the swamp audit timeline.
// Supports OpenCode 1.3.4 or later and OpenCode 2.
// This is a managed file — it will be overwritten on swamp upgrade.

import type { Plugin } from "@opencode-ai/plugin";

const pendingCommands = new Map();

async function record(command, cwd, sessionID) {
  try {
    const payload = JSON.stringify({
      tool_name: "bash",
      tool_input: { command },
      cwd,
      session_id: sessionID,
    });
    const proc = Bun.spawn(
      ["swamp", "audit", "record", "--from-hook", "--tool", "opencode"],
      { stdin: new Blob([payload]) },
    );
    await proc.exited;
  } catch {
    // Must never throw — this is a hook
  }
}

// OpenCode 1
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
      await record(command, directory, input.sessionID);
    },
  };
};

export default {
  id: "swamp.audit",
  // OpenCode 1.3.4+
  server: SwampAudit,
  // OpenCode 2, which names the tool "shell"
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "shell" && event.tool !== "bash") return;
      const command = event.input?.command;
      if (typeof command !== "string" || !command) return;
      await record(command, ctx.location.directory, event.sessionID);
    });
  },
};
`;
  }

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

  private generatePiExtensionContent(): string {
    return `// Swamp audit extension for Pi
// Records bash tool invocations for the swamp audit timeline.
// This is a managed file — it will be overwritten on swamp upgrade.

import { spawn } from "node:child_process";

const pendingCommands = new Map();

export default function swampAudit(pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.tool !== "bash") return;
    const command = event.input?.command;
    if (command && ctx.sessionId) {
      pendingCommands.set(ctx.sessionId, command);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.tool !== "bash") return;
    const command = pendingCommands.get(ctx.sessionId);
    pendingCommands.delete(ctx.sessionId);
    if (!command) return;

    try {
      const payload = JSON.stringify({
        tool_name: "bash",
        tool_input: { command },
        cwd: ctx.cwd || ".",
        session_id: ctx.sessionId,
      });
      const proc = spawn("swamp", ["audit", "record", "--from-hook", "--tool", "pi"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      proc.on("error", () => {});
      proc.stdin.end(payload);
    } catch {
      // Must never throw — this is a hook
    }
  });
}
`;
  }

  private createPiExtensionIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const extensionPath = join(
      repoPath.value,
      ".pi",
      "extensions",
      "swamp-audit.ts",
    );
    return this.createFileIfNotExists(
      extensionPath,
      this.generatePiExtensionContent(),
    );
  }

  private updatePiExtension(repoPath: RepoPath): Promise<boolean> {
    const extensionPath = join(
      repoPath.value,
      ".pi",
      "extensions",
      "swamp-audit.ts",
    );
    return this.overwriteIfChanged(
      extensionPath,
      this.generatePiExtensionContent(),
    );
  }

  private generateAntiGravityHooksContent(): string {
    const hooks = {
      "swamp-audit": {
        enabled: true,
        PostToolUse: [
          {
            matcher: "run_command",
            hooks: [
              {
                type: "command",
                command: "swamp audit record --from-hook --tool antigravity",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
    return JSON.stringify(hooks, null, 2) + "\n";
  }

  private createAntiGravityHooksIfNotExists(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const hooksPath = join(
      repoPath.value,
      ".agents",
      "hooks.json",
    );
    return this.createFileIfNotExists(
      hooksPath,
      this.generateAntiGravityHooksContent(),
    );
  }

  private async updateAntiGravityHooks(
    repoPath: RepoPath,
  ): Promise<boolean> {
    const hooksPath = join(repoPath.value, ".agents", "hooks.json");

    let existing: Record<string, unknown> = {};
    let hooksExisted = false;

    try {
      const content = await Deno.readTextFile(hooksPath);
      existing = JSON.parse(content);
      hooksExisted = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const generated = JSON.parse(this.generateAntiGravityHooksContent());
    const merged = { ...existing, ...generated };
    const mergedStr = JSON.stringify(merged, null, 2) + "\n";

    if (hooksExisted && JSON.stringify(existing) === JSON.stringify(merged)) {
      return false;
    }

    await ensureDir(join(repoPath.value, ".agents"));
    await atomicWriteTextFile(hooksPath, mergedStr);
    return true;
  }

  private async createDataDirectoryStructure(
    repoPath: RepoPath,
  ): Promise<void> {
    const topLevelDirs = ["models", "workflows", "vaults", "grants"];
    for (const dir of topLevelDirs) {
      await ensureDir(join(repoPath.value, dir));
    }

    const runtimeSubdirs = [
      SWAMP_SUBDIRS.data,
      SWAMP_SUBDIRS.outputs,
      SWAMP_SUBDIRS.workflowRuns,
      SWAMP_SUBDIRS.workflowsEvaluated,
      SWAMP_SUBDIRS.definitionsEvaluated,
      SWAMP_SUBDIRS.secrets,
      // Telemetry is user-global (~/.config/swamp/telemetry), not repo-local —
      // do not scaffold a repo-local telemetry directory.
      SWAMP_SUBDIRS.audit,
      SWAMP_SUBDIRS.vaultBundles,
    ];

    for (const subdir of runtimeSubdirs) {
      await ensureDir(swampPath(repoPath.value, subdir));
    }
  }

  /**
   * repos that opted out of telemetry are skipped so leftovers are never sent;
   * the repo-local directory is left orphaned, never deleted; best-effort, must
   * never fail an upgrade
   */
  private async migrateRepoLocalTelemetry(
    repoPath: RepoPath,
    marker: RepoMarkerData,
  ): Promise<void> {
    if (marker.telemetryDisabled === true) return;
    try {
      await migrateRepoTelemetryToGlobal(
        repoPath.value,
        this.userConfigPath(SWAMP_SUBDIRS.telemetry),
      );
    } catch {
      // Best-effort — never break an upgrade over telemetry.
    }
  }

  private async migrateFromSymlinks(repoPath: RepoPath): Promise<void> {
    const dataDir = swampPath(repoPath.value, SWAMP_SUBDIRS.data);
    await this.replaceLatestSymlinks(dataDir);

    for (const dir of ["models", "workflows", "vaults"]) {
      const dirPath = join(repoPath.value, dir);
      try {
        const stat = await Deno.lstat(dirPath);
        if (stat.isSymlink) {
          await Deno.remove(dirPath);
        } else if (stat.isDirectory) {
          await this.removeSymlinksRecursively(dirPath);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          // Non-fatal: continue
        }
      }
    }

    for (const dir of ["models", "workflows", "vaults"]) {
      await ensureDir(join(repoPath.value, dir));
    }

    await this.moveDirectoryContents(
      swampPath(repoPath.value, SWAMP_SUBDIRS.definitions),
      join(repoPath.value, "models"),
    );

    await this.moveDirectoryContents(
      swampPath(repoPath.value, SWAMP_SUBDIRS.workflows),
      join(repoPath.value, "workflows"),
    );

    await this.moveDirectoryContents(
      swampPath(repoPath.value, SWAMP_SUBDIRS.vault),
      join(repoPath.value, "vaults"),
    );
  }

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
          try {
            await Deno.remove(srcPath);
          } catch {
            // Non-fatal: directory may not be empty
          }
        } else if (entry.isFile) {
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

    try {
      await Deno.remove(srcDir);
    } catch {
      // Non-fatal: directory may not exist or may not be empty
    }
  }

  private async removeSymlinksRecursively(dir: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);
        const stat = await Deno.lstat(fullPath);

        if (stat.isSymlink) {
          await Deno.remove(fullPath);
        } else if (stat.isDirectory) {
          await this.removeSymlinksRecursively(fullPath);
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
