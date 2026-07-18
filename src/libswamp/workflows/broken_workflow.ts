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
 * Raw-file scan for workflow files that fail schema parsing.
 *
 * The workflow repository skips unparseable files with a logged warning,
 * so a schema-rejected workflow (e.g. one carrying an unknown key,
 * swamp-club#1240) would otherwise surface as "Workflow not found" in
 * `workflow validate` and `workflow run`. This helper re-reads the raw
 * YAML the same way the doctor flow does, so those callers can surface
 * the actual parse error inline.
 */

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  Workflow,
  type WorkflowInput,
} from "../../domain/workflows/workflow.ts";

/** A workflow file that failed YAML parsing or schema validation. */
export interface BrokenWorkflow {
  /** Absolute path of the offending file. */
  file: string;
  /** Raw `name` from the YAML, when readable. */
  name: string | null;
  /** Raw `id` from the YAML, when readable. */
  id: string | null;
  /** The parse or schema error message. */
  error: string;
}

/** Returns the workflows directory for a repo. */
export function workflowsDirFor(repoDir: string): string {
  return join(repoDir, "workflows");
}

/**
 * Scans the workflows directory for `workflow-*.yaml` files (the set the
 * repository loader reads) that fail to load, returning one entry per
 * broken file. A missing directory yields an empty list.
 */
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
    .filter((e) =>
      e.isFile && e.name.startsWith("workflow-") && e.name.endsWith(".yaml")
    )
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

/**
 * Finds the broken workflow file whose raw `name` or `id` matches the
 * given identifier, or null when every file loads (or none matches).
 */
export async function findBrokenWorkflow(
  workflowsDir: string,
  idOrName: string,
): Promise<BrokenWorkflow | null> {
  const broken = await listBrokenWorkflows(workflowsDir);
  return broken.find((b) => b.name === idOrName || b.id === idOrName) ?? null;
}
