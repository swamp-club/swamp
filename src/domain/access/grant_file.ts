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

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { type Action, ActionSchema } from "./action.ts";
import { type Effect, EffectSchema } from "./effect.ts";
import type { Subject } from "./subject.ts";
import { parseSubject } from "./subject.ts";
import {
  parseResourceSelector,
  type ResourceKind,
  type ResourceSelector,
} from "./resource_selector.ts";

const GrantFileEntryRawSchema = z.object({
  subject: z.string().min(1),
  effect: EffectSchema,
  actions: z.array(ActionSchema).min(1),
  resource: z.string().min(1),
  condition: z.string().optional(),
});

const GrantFileRawSchema = z.object({
  grants: z.array(GrantFileEntryRawSchema).min(1),
});

export interface GrantFileEntry {
  subject: Subject;
  effect: Effect;
  actions: Action[];
  resource: ResourceSelector;
  condition?: string;
}

export interface GrantFileError {
  filename: string;
  entryIndex?: number;
  message: string;
}

export interface GrantFileParseResult {
  entries: GrantFileEntry[];
  errors: GrantFileError[];
}

export interface ConditionValidator {
  (condition: string, resourceKind: ResourceKind): {
    valid: boolean;
    error?: string;
  };
}

function entryIdentityKey(entry: GrantFileEntry): string {
  const subject = `${entry.subject.kind}:${entry.subject.name}`;
  const actions = [...entry.actions].sort().join(",");
  const resource = `${entry.resource.kind}:${entry.resource.pattern}`;
  const condition = entry.condition?.trim() ?? "";
  return `${subject}|${entry.effect}|${actions}|${resource}|${condition}`;
}

export function parseGrantFile(
  filename: string,
  content: string,
  validateCondition?: ConditionValidator,
): GrantFileParseResult {
  const entries: GrantFileEntry[] = [];
  const errors: GrantFileError[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    errors.push({ filename, message: "Invalid YAML syntax" });
    return { entries, errors };
  }

  const result = GrantFileRawSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      errors.push({
        filename,
        message: `Schema error at ${path}: ${issue.message}`,
      });
    }
    return { entries, errors };
  }

  const seenKeys = new Map<string, number>();

  for (let i = 0; i < result.data.grants.length; i++) {
    const raw = result.data.grants[i];

    let subject: Subject;
    try {
      subject = parseSubject(raw.subject);
    } catch (e) {
      errors.push({
        filename,
        entryIndex: i,
        message: (e as Error).message,
      });
      continue;
    }

    let resource: ResourceSelector;
    try {
      resource = parseResourceSelector(raw.resource);
    } catch (e) {
      errors.push({
        filename,
        entryIndex: i,
        message: (e as Error).message,
      });
      continue;
    }

    if (raw.condition && validateCondition) {
      const validation = validateCondition(raw.condition, resource.kind);
      if (!validation.valid) {
        errors.push({
          filename,
          entryIndex: i,
          message: `CEL condition invalid: ${validation.error}`,
        });
        continue;
      }
    }

    const entry: GrantFileEntry = {
      subject,
      effect: raw.effect,
      actions: raw.actions,
      resource,
      condition: raw.condition,
    };

    const key = entryIdentityKey(entry);
    const existingIndex = seenKeys.get(key);
    if (existingIndex !== undefined) {
      errors.push({
        filename,
        entryIndex: i,
        message: `Duplicate grant entry (same as entry ${existingIndex + 1})`,
      });
      continue;
    }

    seenKeys.set(key, i);
    entries.push(entry);
  }

  return { entries, errors };
}

function isGrantFileExtension(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

export async function readGrantFiles(
  grantsDir: string,
  validateCondition?: ConditionValidator,
): Promise<Map<string, GrantFileParseResult>> {
  const results = new Map<string, GrantFileParseResult>();

  let dirEntries: Deno.DirEntry[];
  try {
    dirEntries = [];
    for await (const entry of Deno.readDir(grantsDir)) {
      dirEntries.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return results;
    }
    throw error;
  }

  const files = dirEntries
    .filter((e) => e.isFile && isGrantFileExtension(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const file of files) {
    const path = join(grantsDir, file.name);
    const content = await Deno.readTextFile(path);
    results.set(
      file.name,
      parseGrantFile(file.name, content, validateCondition),
    );
  }

  return results;
}

export function collectErrors(
  results: Map<string, GrantFileParseResult>,
): GrantFileError[] {
  const allErrors: GrantFileError[] = [];
  for (const result of results.values()) {
    allErrors.push(...result.errors);
  }
  return allErrors;
}
