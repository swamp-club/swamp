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
import type { AiTool } from "./ai_tool.ts";
import { markErrorPaths, UserError } from "../errors.ts";

export interface CustomToolDefinition {
  name: string;
  skillsDir: string;
  instructionsFile: string;
  instructionsMode: "shared" | "owned";
  frontmatter?: string;
  skillReferenceStyle: "name" | "path";
  gitignoreEntries?: string;
}

export interface ToolConfig {
  name: string;
  isBuiltIn: boolean;
  skillsDir: string;
  instructionsFile: string;
  instructionsMode: "shared" | "owned";
  frontmatter?: string;
  skillReferenceStyle: "name" | "path";
  gitignoreEntries?: string;
  /** Adds an `@AGENTS.md` import to the managed instructions section. */
  importAgentsMd?: boolean;
}

export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "amp",
  "claude",
  "cursor",
  "opencode",
  "codex",
  "copilot",
  "kiro",
  "pi",
  "antigravity",
  "none",
];

const BUILT_IN_TOOLS: ReadonlySet<string> = new Set<string>(
  BUILT_IN_TOOL_NAMES,
);

export function isBuiltInTool(name: string): name is AiTool {
  return BUILT_IN_TOOLS.has(name);
}

const CUSTOM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function validateCustomToolName(name: string): void {
  if (isBuiltInTool(name.toLowerCase())) {
    throw new UserError(
      `"${name}" conflicts with a built-in tool and cannot be used as a custom tool name.`,
    );
  }
  if (!CUSTOM_TOOL_NAME_PATTERN.test(name)) {
    throw new UserError(
      `Invalid custom tool name "${name}". ` +
        "Names must be alphanumeric with hyphens (e.g. windsurf, Pi, my-tool).",
    );
  }
}

export function assertPathContained(
  repoRoot: string,
  relativePath: string,
  label: string,
): void {
  const resolved = resolve(join(repoRoot, relativePath));
  const normalizedRoot = resolve(repoRoot);
  if (
    !resolved.startsWith(normalizedRoot + SEPARATOR) &&
    resolved !== normalizedRoot
  ) {
    throw markErrorPaths(
      new UserError(
        `${label} "${relativePath}" escapes the repository root.`,
      ),
      [relativePath],
    );
  }
}

export function builtInToolConfig(tool: AiTool): ToolConfig {
  switch (tool) {
    case "amp":
      return {
        name: "amp",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
      };
    case "claude":
      return {
        name: "claude",
        isBuiltIn: true,
        skillsDir: ".claude/skills",
        instructionsFile: "CLAUDE.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
        gitignoreEntries:
          "# Claude Code configuration (managed by swamp)\n.claude/worktrees/\n.claude/settings.local.json\n.claude/scheduled_tasks.lock\n.claude/scheduled_tasks.json",
      };
    case "cursor":
      return {
        name: "cursor",
        isBuiltIn: true,
        skillsDir: ".cursor/skills",
        instructionsFile: ".cursor/rules/swamp.mdc",
        instructionsMode: "shared",
        frontmatter:
          "---\ndescription: Swamp automation rules\nalwaysApply: true\n---\n",
        skillReferenceStyle: "name",
      };
    case "opencode":
      return {
        name: "opencode",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
      };
    case "codex":
      return {
        name: "codex",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
      };
    case "copilot":
      return {
        name: "copilot",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
      };
    case "kiro":
      return {
        name: "kiro",
        isBuiltIn: true,
        skillsDir: ".kiro/skills",
        instructionsFile: ".kiro/steering/swamp-rules.md",
        instructionsMode: "shared",
        frontmatter: "---\ninclusion: always\n---\n",
        skillReferenceStyle: "name",
      };
    case "pi":
      return {
        name: "pi",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
      };
    case "antigravity":
      return {
        name: "antigravity",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "name",
      };
    case "none":
      return {
        name: "none",
        isBuiltIn: true,
        skillsDir: ".swamp/pulled-extensions/skills",
        instructionsFile: "",
        instructionsMode: "owned",
        skillReferenceStyle: "path",
      };
  }
}

/** Swamp's Claude rules file when the repo keeps its own rules in AGENTS.md. */
export const CLAUDE_RULES_FILE = ".claude/rules/swamp.md";

/** What the claude tool needs to know about a repo's instruction files. */
export interface ClaudeInstructionsState {
  /** `.claude/rules/swamp.md` exists. */
  rulesFileExists: boolean;
  /** Root `CLAUDE.md` exists. */
  claudeMdExists: boolean;
  /** Root `CLAUDE.md` is a symlink (e.g. to `AGENTS.md`); never write through it. */
  claudeMdIsSymlink: boolean;
  /** Root `CLAUDE.md` carries swamp's managed section (marked or legacy). */
  claudeMdHasSwampSection: boolean;
  /** Root `CLAUDE.md` has content outside swamp's managed section. */
  claudeMdHasUserContent: boolean;
  /** Root `AGENTS.md` has content outside swamp's managed section. */
  agentsMdHasUserContent: boolean;
}

/**
 * Picks where the claude tool writes swamp's instructions. Claude Code reads
 * `AGENTS.md` only when no `CLAUDE.md` exists, so swamp never creates a
 * `CLAUDE.md` next to a repo's own `AGENTS.md`, and never writes through a
 * symlinked `CLAUDE.md`: it writes a rules file, which Claude Code loads
 * alongside `AGENTS.md`. A repo keeps whichever target it already has, so
 * upgrades never move swamp's section between files.
 */
export function claudeToolConfigFor(
  state: ClaudeInstructionsState,
): ToolConfig {
  const config = builtInToolConfig("claude");
  const rulesFile: ToolConfig = {
    ...config,
    instructionsFile: CLAUDE_RULES_FILE,
    instructionsMode: "owned",
  };
  if (state.rulesFileExists || state.claudeMdIsSymlink) {
    return rulesFile;
  }
  if (state.claudeMdHasSwampSection) {
    // A CLAUDE.md that holds only swamp's section hides the repo's AGENTS.md
    // from Claude Code, so import it.
    return {
      ...config,
      importAgentsMd: state.agentsMdHasUserContent &&
        !state.claudeMdHasUserContent,
    };
  }
  if (state.agentsMdHasUserContent && !state.claudeMdExists) {
    return rulesFile;
  }
  return config;
}

export function customToolConfig(def: CustomToolDefinition): ToolConfig {
  return {
    name: def.name,
    isBuiltIn: false,
    skillsDir: def.skillsDir,
    instructionsFile: def.instructionsFile,
    instructionsMode: def.instructionsMode,
    frontmatter: def.frontmatter,
    skillReferenceStyle: def.skillReferenceStyle,
    gitignoreEntries: def.gitignoreEntries,
  };
}

const ROOT_LEVEL_SHARED_FILES = new Set([
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "CONVENTIONS.md",
]);

export function deriveDefaults(
  name: string,
  instructionsPath: string,
  detectedConfigDir?: string,
  detectedSkillsDir?: string,
): CustomToolDefinition {
  const isRootFile = !instructionsPath.includes("/") &&
    !instructionsPath.includes("\\");
  const isShared = isRootFile && ROOT_LEVEL_SHARED_FILES.has(instructionsPath);

  let skillsDir: string;
  if (detectedSkillsDir) {
    skillsDir = detectedSkillsDir;
  } else if (!isRootFile) {
    const topDir = instructionsPath.split("/")[0];
    if (topDir.startsWith(".")) {
      skillsDir = `${topDir}/skills`;
    } else {
      skillsDir = `.${name.toLowerCase()}/skills`;
    }
  } else if (detectedConfigDir) {
    skillsDir = `${detectedConfigDir}/skills`;
  } else {
    skillsDir = `.${name.toLowerCase()}/skills`;
  }

  const gitignoreComment = isBuiltInTool(name)
    ? name
    : name.charAt(0).toUpperCase() + name.slice(1);

  return {
    name,
    skillsDir,
    instructionsFile: instructionsPath,
    instructionsMode: isShared ? "shared" : "owned",
    skillReferenceStyle: "path",
    gitignoreEntries:
      `# ${gitignoreComment} skills (managed by swamp)\n${skillsDir}/`,
  };
}

export interface DetectionResult {
  configDir?: string;
  subdirs: string[];
  rootFiles: string[];
  skillsDir?: string;
}

const KNOWN_SUBDIRS = ["rules", "guidelines", "steering"];
const KNOWN_ROOT_FILES = ["AGENTS.md", "AGENT.md", "CONVENTIONS.md"];

export async function detectToolConfig(
  repoDir: string,
  toolName: string,
): Promise<DetectionResult> {
  const result: DetectionResult = { subdirs: [], rootFiles: [] };

  const configDirName = `.${toolName}`;
  const configDirPath = join(repoDir, configDirName);
  try {
    const stat = await Deno.stat(configDirPath);
    if (stat.isDirectory) {
      result.configDir = configDirName;

      for (const subdir of KNOWN_SUBDIRS) {
        try {
          const subStat = await Deno.stat(join(configDirPath, subdir));
          if (subStat.isDirectory) {
            result.subdirs.push(subdir);
          }
        } catch {
          // subdir doesn't exist
        }
      }
    }
  } catch {
    // config dir doesn't exist
  }

  for (const file of KNOWN_ROOT_FILES) {
    try {
      const stat = await Deno.stat(join(repoDir, file));
      if (stat.isFile) {
        result.rootFiles.push(file);
      }
    } catch {
      // file doesn't exist
    }
  }

  // Check for a bare skills/ directory (e.g. deepAgents convention)
  try {
    const stat = await Deno.stat(join(repoDir, "skills"));
    if (stat.isDirectory) {
      result.skillsDir = "skills";
    }
  } catch {
    // skills dir doesn't exist
  }

  return result;
}

export function buildInstructionsChoices(
  detection: DetectionResult,
  _toolName: string,
): string[] {
  const choices: string[] = [];

  for (const rootFile of detection.rootFiles) {
    choices.push(rootFile);
  }

  if (detection.configDir) {
    for (const subdir of detection.subdirs) {
      choices.push(`${detection.configDir}/${subdir}/swamp.md`);
    }
    if (detection.subdirs.length === 0) {
      choices.push(`${detection.configDir}/rules/swamp.md`);
    }
  }

  if (choices.length === 0) {
    choices.push("AGENTS.md");
  }

  return choices;
}

export function buildSkillsDirChoices(
  detection: DetectionResult,
  derivedDefault: string,
): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];

  choices.push(derivedDefault);
  seen.add(derivedDefault);

  if (detection.skillsDir && !seen.has(detection.skillsDir)) {
    choices.push(detection.skillsDir);
    seen.add(detection.skillsDir);
  }

  if (detection.configDir) {
    const configSkills = `${detection.configDir}/skills`;
    if (!seen.has(configSkills)) {
      choices.push(configSkills);
    }
  }

  return choices;
}
