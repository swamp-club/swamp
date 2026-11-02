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
 * reads every grant file serve reads at startup and reports what it found
 * without deciding anything, so serve startup and serve check-config judge the
 * same files
 */

import { join } from "@std/path";
import {
  type ConditionValidator,
  type GrantFileParseResult,
  parseGrantFile,
  readGrantFiles,
  resolveExternalGrantsDir,
  resolveExternalGrantsFile,
} from "./grant_file.ts";
import type { ConditionTypeLiteralReader } from "./grant_spelling.ts";
import {
  grantFileUsernames,
  type GrantUsernameResolver,
  type ParsedGrantSource,
  resolveGrantFileUsernames,
} from "./grant_username_resolution.ts";
import { grantsDirSourceName } from "./grant_source.ts";

export interface ExternalGrantFile {
  readonly path: string;
  readonly result: GrantFileParseResult | null;
}

export interface GrantsDirFile extends ExternalGrantFile {
  readonly name: string;
  readonly sourceName: string;
  readonly readError?: unknown;
}

export type GrantsFileLoad =
  | {
    readonly status: "loaded";
    readonly path: string;
    readonly file: ExternalGrantFile;
  }
  | {
    readonly status: "missing";
    readonly path: string;
    readonly cause: unknown;
  }
  | {
    readonly status: "unreadable";
    readonly path: string;
    readonly cause: unknown;
  };

export type GrantsDirLoad =
  | {
    readonly status: "loaded";
    readonly path: string;
    readonly files: readonly GrantsDirFile[];
  }
  | { readonly status: "same-as-repo"; readonly configured: string }
  | {
    readonly status: "missing";
    readonly path: string;
    readonly cause: unknown;
  }
  | {
    readonly status: "unreadable";
    readonly path: string;
    readonly cause: unknown;
  };

export interface ServeGrantFiles {
  readonly repo: Map<string, GrantFileParseResult>;
  /**
   * set when grants/ exists but cannot be listed; repo is then empty and serve
   * startup rethrows the cause
   */
  readonly repoUnreadable?: { readonly path: string; readonly cause: unknown };
  readonly grantsFile?: GrantsFileLoad;
  readonly grantsDir?: GrantsDirLoad;
}

export interface ServeGrantFileOptions {
  readonly grantsFile?: string;
  readonly grantsDir?: string;
  readonly validateCondition?: ConditionValidator;
  readonly readTypeLiterals?: ConditionTypeLiteralReader;
}

/**
 * dotfiles are skipped here but not in the repository grants/ directory; the
 * poller hashes each directory the same way, so change both together
 */
function isGrantsDirFile(entry: Deno.DirEntry): boolean {
  return (entry.isFile || entry.isSymlink) &&
    (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
    !entry.name.startsWith(".");
}

export async function readGrantsFileSource(
  path: string,
  options: ServeGrantFileOptions,
): Promise<GrantsFileLoad> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (cause) {
    return cause instanceof Deno.errors.NotFound
      ? { status: "missing", path, cause }
      : { status: "unreadable", path, cause };
  }
  return {
    status: "loaded",
    path,
    file: {
      path,
      result: content.trim().length === 0 ? null : parseGrantFile(
        path,
        content,
        options.validateCondition,
        options.readTypeLiterals,
      ),
    },
  };
}

export async function readGrantsDirSource(
  path: string,
  options: ServeGrantFileOptions,
): Promise<GrantsDirLoad> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(path)) entries.push(entry);
  } catch (cause) {
    return cause instanceof Deno.errors.NotFound
      ? { status: "missing", path, cause }
      : { status: "unreadable", path, cause };
  }
  const files: GrantsDirFile[] = [];
  const yamlFiles = entries.filter(isGrantsDirFile)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of yamlFiles) {
    const filePath = join(path, entry.name);
    const base = {
      name: entry.name,
      sourceName: grantsDirSourceName(entry.name),
      path: filePath,
    };
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch (readError) {
      files.push({ ...base, result: null, readError });
      continue;
    }
    files.push({
      ...base,
      result: content.trim().length === 0 ? null : parseGrantFile(
        filePath,
        content,
        options.validateCondition,
        options.readTypeLiterals,
      ),
    });
  }
  return { status: "loaded", path, files };
}

export async function readServeGrantFiles(
  repoDir: string,
  options: ServeGrantFileOptions,
): Promise<ServeGrantFiles> {
  const repoGrantsDir = join(repoDir, "grants");
  let repo = new Map<string, GrantFileParseResult>();
  let repoUnreadable: ServeGrantFiles["repoUnreadable"];
  try {
    repo = await readGrantFiles(
      repoGrantsDir,
      options.validateCondition,
      options.readTypeLiterals,
    );
  } catch (cause) {
    repoUnreadable = { path: repoGrantsDir, cause };
  }
  const grantsFilePath = resolveExternalGrantsFile(
    repoDir,
    options.grantsFile,
  );
  const grantsFile = grantsFilePath
    ? await readGrantsFileSource(grantsFilePath, options)
    : undefined;
  let grantsDir: GrantsDirLoad | undefined;
  if (options.grantsDir) {
    const grantsDirPath = await resolveExternalGrantsDir(
      repoDir,
      options.grantsDir,
    );
    grantsDir = grantsDirPath
      ? await readGrantsDirSource(grantsDirPath, options)
      : { status: "same-as-repo", configured: options.grantsDir };
  }
  return {
    repo,
    ...(repoUnreadable ? { repoUnreadable } : {}),
    grantsFile,
    grantsDir,
  };
}

export function serveGrantFileUsernames(files: ServeGrantFiles): string[] {
  const results: GrantFileParseResult[] = [...files.repo.values()];
  if (files.grantsFile?.status === "loaded" && files.grantsFile.file.result) {
    results.push(files.grantsFile.file.result);
  }
  if (files.grantsDir?.status === "loaded") {
    for (const file of files.grantsDir.files) {
      if (file.result) results.push(file.result);
    }
  }
  return grantFileUsernames(results.flatMap((result) => result.entries));
}

export type GrantFileCheckReason =
  | "invalid"
  | "unreadable"
  | "missing-source"
  | "spelling";

export interface GrantFileCheckIssue {
  readonly reason: GrantFileCheckReason;
  readonly file: string;
  readonly entry?: number;
  readonly message: string;
}

export interface GrantFileCheck {
  readonly filesChecked: number;
  readonly errors: readonly GrantFileCheckIssue[];
  readonly warnings: readonly GrantFileCheckIssue[];
}

/**
 * a repository grants file is named grants/<name> with a forward slash on every
 * platform, since it names the file within the repository; external files are
 * named by native path
 */
export function repoGrantFileName(name: string): string {
  return `grants/${name}`;
}

function resultIssues(
  result: GrantFileParseResult,
  errors: GrantFileCheckIssue[],
  warnings: GrantFileCheckIssue[],
  locate: (filename: string) => string = (filename) => filename,
): void {
  for (const e of result.errors) {
    errors.push({
      reason: e.unreadable ? "unreadable" : "invalid",
      file: locate(e.filename),
      ...(e.entryIndex !== undefined ? { entry: e.entryIndex + 1 } : {}),
      message: e.message,
    });
  }
  for (const w of result.warnings) {
    warnings.push({
      reason: "spelling",
      file: locate(w.filename),
      entry: w.entryIndex + 1,
      message: w.message,
    });
  }
}

/**
 * anything that refuses startup is an error; an absent --grants-file or
 * --grants-dir is only a warning, since it may exist only where serve runs,
 * which refuses to start without it
 */
export function checkServeGrantFiles(files: ServeGrantFiles): GrantFileCheck {
  const errors: GrantFileCheckIssue[] = [];
  const warnings: GrantFileCheckIssue[] = [];
  if (files.repoUnreadable) {
    errors.push({
      reason: "unreadable",
      file: "grants",
      message: `Failed to read grants directory: ${files.repoUnreadable.cause}`,
    });
  }
  // Repository grant files are parsed under their bare names; name the
  // directory too, since external sources are listed beside them.
  for (const result of files.repo.values()) {
    resultIssues(result, errors, warnings, repoGrantFileName);
  }
  const grantsFile = files.grantsFile;
  if (grantsFile?.status === "missing") {
    warnings.push({
      reason: "missing-source",
      file: grantsFile.path,
      message:
        "Grants file not found on this machine; swamp serve refuses to start if it is missing where serve runs",
    });
  } else if (grantsFile?.status === "unreadable") {
    errors.push({
      reason: "unreadable",
      file: grantsFile.path,
      message: `Failed to read grants file: ${grantsFile.cause}`,
    });
  } else if (grantsFile?.status === "loaded" && grantsFile.file.result) {
    resultIssues(grantsFile.file.result, errors, warnings);
  }
  const grantsDir = files.grantsDir;
  if (grantsDir?.status === "missing") {
    warnings.push({
      reason: "missing-source",
      file: grantsDir.path,
      message:
        "Grants directory not found on this machine; swamp serve refuses to start if it is missing where serve runs",
    });
  } else if (grantsDir?.status === "unreadable") {
    errors.push({
      reason: "unreadable",
      file: grantsDir.path,
      message: `Failed to read grants directory: ${grantsDir.cause}`,
    });
  } else if (grantsDir?.status === "loaded") {
    for (const file of grantsDir.files) {
      if (file.readError !== undefined) {
        errors.push({
          reason: "unreadable",
          file: file.path,
          message: `Failed to read grants file: ${file.readError}`,
        });
      } else if (file.result) {
        resultIssues(file.result, errors, warnings);
      }
    }
  }
  // Files that loaded, whatever they hold; a file that could not be read is
  // an error, not a checked file, from every source alike.
  const repoChecked =
    [...files.repo.values()].filter((result) =>
      !result.errors.some((e) => e.unreadable)
    ).length;
  const filesChecked = repoChecked +
    (grantsFile?.status === "loaded" ? 1 : 0) +
    (grantsDir?.status === "loaded"
      ? grantsDir.files.filter((file) => file.readError === undefined).length
      : 0);
  return { filesChecked, errors, warnings };
}

export async function checkServeGrantFileUsernames(
  files: ServeGrantFiles,
  resolver: GrantUsernameResolver,
): Promise<GrantFileCheckIssue[]> {
  const sources = new Map<string, ParsedGrantSource>();
  for (const [name, result] of files.repo) {
    sources.set(`repo:${name}`, {
      filename: repoGrantFileName(name),
      entries: result.entries,
    });
  }
  if (files.grantsFile?.status === "loaded" && files.grantsFile.file.result) {
    sources.set("grants-file", {
      filename: files.grantsFile.path,
      entries: files.grantsFile.file.result.entries,
    });
  }
  if (files.grantsDir?.status === "loaded") {
    for (const file of files.grantsDir.files) {
      if (!file.result) continue;
      sources.set(`grants-dir:${file.name}`, {
        filename: file.path,
        entries: file.result.entries,
      });
    }
  }
  if (
    grantFileUsernames([...sources.values()].flatMap((s) => s.entries))
      .length === 0
  ) {
    return [];
  }
  // Not complete: a check must never make a resolver forget anything.
  const resolution = await resolveGrantFileUsernames(sources, resolver, {
    complete: false,
  });
  return [...resolution.sources.values()].flatMap((source) =>
    source.errors.map((e) => ({
      reason: "invalid" as const,
      file: e.filename,
      message: e.message,
    }))
  );
}
