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

import { getLogger } from "@logtape/logtape";
import { join, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { type Action, ActionSchema } from "./action.ts";
import { type Effect, EffectSchema } from "./effect.ts";
import {
  type ConditionTypeLiteralReader,
  findGrantSpellingIssues,
} from "./grant_spelling.ts";
import type { Subject } from "./subject.ts";
import { parseSubject } from "./subject.ts";
import {
  parseResourceSelector,
  type ResourceKind,
  type ResourceSelector,
} from "./resource_selector.ts";

const MAX_RESOURCES_PER_ENTRY = 100;
const MAX_SUBJECTS_PER_ENTRY = 100;

const GrantFileEntryRawSchema = z.object({
  subject: z.string().min(1).optional(),
  subjects: z.array(z.string().min(1)).min(1).max(MAX_SUBJECTS_PER_ENTRY)
    .optional(),
  effect: EffectSchema,
  actions: z.array(ActionSchema).min(1),
  resource: z.string().min(1).optional(),
  resources: z.array(z.string().min(1)).min(1).max(MAX_RESOURCES_PER_ENTRY)
    .optional(),
  condition: z.string().optional(),
  methods: z.array(z.string().min(1)).optional(),
}).superRefine((data, ctx) => {
  if (data.subject !== undefined && data.subjects !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Cannot specify both 'subject' and 'subjects' — use one or the other",
      path: ["subjects"],
    });
  } else if (data.subject === undefined && data.subjects === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Must specify either 'subject' (single) or 'subjects' (array)",
      path: ["subject"],
    });
  }
  if (data.resource !== undefined && data.resources !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Cannot specify both 'resource' and 'resources' — use one or the other",
      path: ["resources"],
    });
  } else if (data.resource === undefined && data.resources === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Must specify either 'resource' (single) or 'resources' (array)",
      path: ["resource"],
    });
  }
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
  methods?: string[];
}

export interface GrantFileError {
  filename: string;
  entryIndex?: number;
  message: string;
  /** Set when the file could not be read at all, rather than parsed. */
  unreadable?: true;
}

/**
 * A grant-file entry that loads but spells a type no type is stored in
 * (swamp-club#3130). Never an error: a file with errors stops serve starting
 * and is held back from auto-reload, which must not happen to a working
 * grant over its spelling.
 */
export interface GrantFileWarning {
  filename: string;
  entryIndex: number;
  message: string;
}

export interface GrantFileParseResult {
  entries: GrantFileEntry[];
  errors: GrantFileError[];
  warnings: GrantFileWarning[];
}

export interface ConditionValidator {
  (condition: string, resourceKind: ResourceKind): {
    valid: boolean;
    error?: string;
  };
}

export function entryIdentityKey(entry: GrantFileEntry): string {
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
  readTypeLiterals?: ConditionTypeLiteralReader,
): GrantFileParseResult {
  const entries: GrantFileEntry[] = [];
  const errors: GrantFileError[] = [];
  const warnings: GrantFileWarning[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    errors.push({ filename, message: "Invalid YAML syntax" });
    return { entries, errors, warnings };
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
    return { entries, errors, warnings };
  }

  const seenKeys = new Map<string, number>();

  for (let i = 0; i < result.data.grants.length; i++) {
    const raw = result.data.grants[i];

    const subjectStrings: string[] = raw.subject
      ? [raw.subject]
      : raw.subjects!;

    if (raw.subjects) {
      const seen = new Set<string>();
      let hasDuplicate = false;
      for (const s of raw.subjects) {
        if (seen.has(s)) {
          errors.push({
            filename,
            entryIndex: i,
            message: `Duplicate subject in subjects array: "${s}"`,
          });
          hasDuplicate = true;
          break;
        }
        seen.add(s);
      }
      if (hasDuplicate) continue;
    }

    const subjects: Subject[] = [];
    for (const subjectStr of subjectStrings) {
      try {
        subjects.push(parseSubject(subjectStr));
      } catch (e) {
        errors.push({
          filename,
          entryIndex: i,
          message: (e as Error).message,
        });
      }
    }
    if (subjects.length === 0) continue;

    const resourceStrings: string[] = raw.resource
      ? [raw.resource]
      : raw.resources!;

    if (raw.resources) {
      const seen = new Set<string>();
      let hasDuplicate = false;
      for (const r of raw.resources) {
        if (seen.has(r)) {
          errors.push({
            filename,
            entryIndex: i,
            message: `Duplicate resource in resources array: "${r}"`,
          });
          hasDuplicate = true;
          break;
        }
        seen.add(r);
      }
      if (hasDuplicate) continue;
    }

    for (const resourceStr of resourceStrings) {
      let resource: ResourceSelector;
      try {
        resource = parseResourceSelector(resourceStr);
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
            message:
              `CEL condition invalid for resource "${resourceStr}": ${validation.error}`,
          });
          continue;
        }
      }

      for (
        const finding of findGrantSpellingIssues(
          { effect: raw.effect, resource, condition: raw.condition },
          readTypeLiterals,
        )
      ) {
        warnings.push({ filename, entryIndex: i, message: finding.message });
      }

      // The resource is parsed and its condition validated once, before the
      // subjects loop, so a bad resource reports one error however many
      // subjects the entry lists.
      for (const subject of subjects) {
        const entry: GrantFileEntry = {
          subject,
          effect: raw.effect,
          actions: raw.actions,
          resource,
          condition: raw.condition,
          methods: raw.methods,
        };

        const key = entryIdentityKey(entry);
        const existingIndex = seenKeys.get(key);
        if (existingIndex !== undefined) {
          errors.push({
            filename,
            entryIndex: i,
            message: `Duplicate grant entry (same as entry ${
              existingIndex + 1
            })`,
          });
          continue;
        }

        seenKeys.set(key, i);
        entries.push(entry);
      }
    }
  }

  return { entries, errors, warnings };
}

function isGrantFileExtension(name: string): boolean {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

export async function readGrantFiles(
  grantsDir: string,
  validateCondition?: ConditionValidator,
  readTypeLiterals?: ConditionTypeLiteralReader,
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
    .filter((e) => (e.isFile || e.isSymlink) && isGrantFileExtension(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const logger = getLogger(["swamp", "access", "grant-file"]);
  for (const file of files) {
    const path = join(grantsDir, file.name);
    let content: string;
    try {
      content = await Deno.readTextFile(path);
    } catch (error) {
      logger.warn`Skipping grant file ${file.name}: ${error}`;
      results.set(file.name, {
        entries: [],
        errors: [{
          filename: file.name,
          message: `Failed to read: ${error}`,
          unreadable: true,
        }],
        warnings: [],
      });
      continue;
    }
    results.set(
      file.name,
      parseGrantFile(file.name, content, validateCondition, readTypeLiterals),
    );
  }

  return results;
}

// A relative grants-file or grants-dir resolves against the repository
// directory, whether it came from a flag, an env var or serve.yaml, so the
// same configuration loads the same grants wherever serve was started from.
export function resolveExternalGrantsFile(
  repoDir: string,
  configuredGrantsFile: string | undefined,
): string | undefined {
  if (!configuredGrantsFile) return undefined;
  return resolve(repoDir, configuredGrantsFile);
}

// The repository grants directory is always read, so a grants-dir that is the
// same directory is dropped: reading it again would reconcile each file under
// two sources, `file:<name>` and `file:<full path>`.
export async function resolveExternalGrantsDir(
  repoDir: string,
  configuredGrantsDir: string | undefined,
): Promise<string | undefined> {
  if (!configuredGrantsDir) return undefined;
  const externalGrantsDir = resolve(repoDir, configuredGrantsDir);
  if (await isSameDirectory(join(repoDir, "grants"), externalGrantsDir)) {
    return undefined;
  }
  return externalGrantsDir;
}

async function isSameDirectory(a: string, b: string): Promise<boolean> {
  let statA: Deno.FileInfo;
  let statB: Deno.FileInfo;
  try {
    [statA, statB] = await Promise.all([Deno.stat(a), Deno.stat(b)]);
  } catch {
    // A directory that cannot be read is not the same as one that can; the
    // caller's own read reports the real error.
    return false;
  }
  // dev/ino identify a directory through symlinks and case-insensitive
  // filesystems; they are null on some Windows builds, so fall back to paths.
  if (statA.ino !== null && statB.ino !== null) {
    return statA.dev === statB.dev && statA.ino === statB.ino;
  }
  const [realA, realB] = await Promise.all([
    Deno.realPath(a),
    Deno.realPath(b),
  ]);
  return Deno.build.os === "windows"
    ? realA.toLowerCase() === realB.toLowerCase()
    : realA === realB;
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
