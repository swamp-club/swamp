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
import { UserError } from "../errors.ts";

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
}

export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "claude",
  "cursor",
  "opencode",
  "codex",
  "copilot",
  "kiro",
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
    throw new UserError(
      `${label} "${relativePath}" escapes the repository root.`,
    );
  }
}

export function builtInToolConfig(tool: AiTool): ToolConfig {
  switch (tool) {
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
        instructionsMode: "owned",
        frontmatter:
          "---\ndescription: Swamp automation rules\nalwaysApply: true\n---\n",
        skillReferenceStyle: "path",
      };
    case "opencode":
      return {
        name: "opencode",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "path",
      };
    case "codex":
      return {
        name: "codex",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "path",
      };
    case "copilot":
      return {
        name: "copilot",
        isBuiltIn: true,
        skillsDir: ".agents/skills",
        instructionsFile: "AGENTS.md",
        instructionsMode: "shared",
        skillReferenceStyle: "path",
      };
    case "kiro":
      return {
        name: "kiro",
        isBuiltIn: true,
        skillsDir: ".kiro/skills",
        instructionsFile: ".kiro/steering/swamp-rules.md",
        instructionsMode: "owned",
        frontmatter: "---\ninclusion: always\n---\n",
        skillReferenceStyle: "path",
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
