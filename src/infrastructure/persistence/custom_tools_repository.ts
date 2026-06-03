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

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { CustomToolDefinition } from "../../domain/repo/custom_tool.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { swampCustomToolsPath } from "./paths.ts";
import { UserError } from "../../domain/errors.ts";

interface CustomToolsFileData {
  tools?: CustomToolDefinitionData[];
}

interface CustomToolDefinitionData {
  name: string;
  skillsDir: string;
  instructionsFile: string;
  instructionsMode: string;
  frontmatter?: string;
  skillReferenceStyle: string;
  gitignoreEntries?: string;
}

function validateMode(
  mode: string,
): asserts mode is "shared" | "owned" {
  if (mode !== "shared" && mode !== "owned") {
    throw new UserError(
      `Invalid instructionsMode "${mode}" — must be "shared" or "owned".`,
    );
  }
}

function validateRefStyle(
  style: string,
): asserts style is "name" | "path" {
  if (style !== "name" && style !== "path") {
    throw new UserError(
      `Invalid skillReferenceStyle "${style}" — must be "name" or "path".`,
    );
  }
}

function validateRequiredString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !value) {
    throw new UserError(
      `Missing or empty "${field}" in .swamp-custom-tools.yaml.`,
    );
  }
}

function toDefinition(data: CustomToolDefinitionData): CustomToolDefinition {
  validateRequiredString(data.name, "name");
  validateRequiredString(data.skillsDir, "skillsDir");
  validateRequiredString(data.instructionsFile, "instructionsFile");
  validateMode(data.instructionsMode);
  validateRefStyle(data.skillReferenceStyle);
  return {
    name: data.name,
    skillsDir: data.skillsDir,
    instructionsFile: data.instructionsFile,
    instructionsMode: data.instructionsMode,
    frontmatter: data.frontmatter,
    skillReferenceStyle: data.skillReferenceStyle,
    gitignoreEntries: data.gitignoreEntries,
  };
}

export async function readCustomTools(
  repoDir: string,
): Promise<CustomToolDefinition[]> {
  const path = swampCustomToolsPath(repoDir);
  try {
    const content = await Deno.readTextFile(path);
    const data = parseYaml(content) as CustomToolsFileData | null;
    if (!data?.tools || !Array.isArray(data.tools)) {
      return [];
    }
    return data.tools.map(toDefinition);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }
}

export async function writeCustomTools(
  repoDir: string,
  tools: CustomToolDefinition[],
): Promise<void> {
  const path = swampCustomToolsPath(repoDir);
  const data: CustomToolsFileData = { tools };
  const cleanData = JSON.parse(JSON.stringify(data));
  const content = stringifyYaml(cleanData as Record<string, unknown>);
  await atomicWriteTextFile(path, content);
}

export async function addCustomTool(
  repoDir: string,
  tool: CustomToolDefinition,
): Promise<void> {
  const existing = await readCustomTools(repoDir);
  if (existing.some((t) => t.name === tool.name)) {
    throw new UserError(
      `Custom tool "${tool.name}" already exists in .swamp-custom-tools.yaml.`,
    );
  }
  existing.push(tool);
  await writeCustomTools(repoDir, existing);
}

export async function removeCustomTool(
  repoDir: string,
  name: string,
): Promise<boolean> {
  const existing = await readCustomTools(repoDir);
  const filtered = existing.filter((t) => t.name !== name);
  if (filtered.length === existing.length) {
    return false;
  }
  await writeCustomTools(repoDir, filtered);
  return true;
}

export async function findCustomTool(
  repoDir: string,
  name: string,
): Promise<CustomToolDefinition | undefined> {
  const tools = await readCustomTools(repoDir);
  return tools.find((t) => t.name === name);
}
