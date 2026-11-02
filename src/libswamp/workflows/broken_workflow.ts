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

/**
 * the repository skips unparseable workflow files with a warning, which would
 * read as Workflow not found; this re-reads the raw YAML so callers can show
 * the real parse error
 */

import { basename, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  Workflow,
  type WorkflowInput,
} from "../../domain/workflows/workflow.ts";
import { isWorkflowDocument } from "../../domain/workflows/workflow_document.ts";
import { resolveEffectiveWorkflowsDir } from "../../infrastructure/persistence/paths.ts";
import { isPrimaryWorkflowFileName } from "../../infrastructure/persistence/yaml_workflow_repository.ts";

export interface BrokenWorkflow {
  file: string;
  name: string | null;
  id: string | null;
  error: string;
}

export interface MisnamedWorkflow {
  file: string;
  name: string | null;
  id: string | null;
  /**
   * Why the file is not loaded. It names the file by its base name only, so
   * no absolute path reaches a `swamp serve` client, which withholds those.
   */
  message: string;
}

export function workflowsDirFor(repoDir: string): string {
  return resolveEffectiveWorkflowsDir(repoDir);
}

export async function listBrokenWorkflows(
  workflowsDir: string,
): Promise<BrokenWorkflow[]> {
  const broken: BrokenWorkflow[] = [];

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(workflowsDir)) {
      entries.push(entry);
    }
  } catch {
    return broken;
  }

  const yamlFiles = entries
    .filter((e) => e.isFile && isPrimaryWorkflowFileName(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of yamlFiles) {
    const file = join(workflowsDir, entry.name);
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch (readError) {
      broken.push({
        file,
        name: null,
        id: null,
        error: readError instanceof Error
          ? readError.message
          : String(readError),
      });
      continue;
    }

    let raw: { name?: unknown; id?: unknown } | null = null;
    try {
      const parsed = parseYaml(content);
      raw = parsed !== null && typeof parsed === "object"
        ? parsed as { name?: unknown; id?: unknown }
        : null;
      Workflow.fromData(parsed as WorkflowInput);
    } catch (parseError) {
      broken.push({
        file,
        name: typeof raw?.name === "string" ? raw.name : null,
        id: typeof raw?.id === "string" ? raw.id : null,
        error: parseError instanceof Error
          ? parseError.message
          : String(parseError),
      });
    }
  }

  return broken;
}

export async function findBrokenWorkflow(
  workflowsDir: string,
  idOrName: string,
): Promise<BrokenWorkflow | null> {
  const broken = await listBrokenWorkflows(workflowsDir);
  return broken.find((b) => b.name === idOrName || b.id === idOrName) ?? null;
}

export function workflowNotLoadedMessage(
  file: string,
  dir: string,
  parsed: unknown,
): string {
  const rule = `swamp only reads files named workflow-<name>.yaml in ${dir}.`;
  return isWorkflowDocument(parsed)
    ? `Not loaded: ${rule} Rename ${file} to workflow-<name>.yaml, ` +
      `or remove it if it is a stale copy of a workflow that already loads.`
    : `Not loaded: ${rule} ${file} is not a workflow; move it out of ` +
      `that directory, or rename it to workflow-<name>.yaml if it is ` +
      `meant to be one.`;
}

export async function findMisnamedWorkflow(
  workflowsDir: string,
  idOrName: string,
): Promise<MisnamedWorkflow | null> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(workflowsDir)) {
      if (
        entry.isFile && /\.ya?ml$/.test(entry.name) &&
        !isPrimaryWorkflowFileName(entry.name)
      ) {
        names.push(entry.name);
      }
    }
  } catch {
    return null;
  }

  for (const fileName of names.sort((a, b) => a.localeCompare(b))) {
    const file = join(workflowsDir, fileName);
    let parsed: unknown;
    try {
      parsed = parseYaml(await Deno.readTextFile(file));
    } catch {
      continue;
    }
    const raw = parsed !== null && typeof parsed === "object"
      ? parsed as { name?: unknown; id?: unknown }
      : null;
    const name = typeof raw?.name === "string" ? raw.name : null;
    const id = typeof raw?.id === "string" ? raw.id : null;
    if (name !== idOrName && id !== idOrName) continue;
    return {
      file,
      name,
      id,
      message: workflowNotLoadedMessage(
        basename(file),
        "the workflows directory",
        parsed,
      ),
    };
  }
  return null;
}
