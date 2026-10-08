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
 * Reads every grant file `swamp serve` reads at startup — the repository
 * `grants/` directory, `--grants-file` and `--grants-dir` — and reports what
 * it found without deciding anything, so serve startup and
 * `swamp serve check-config` judge the same files (swamp-club#3130).
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
import { grantsDirSourceName } from "./grant_source.ts";

/** One grant file outside the repository grants/ directory. */
export interface ExternalGrantFile {
  readonly path: string;
  /** Null for a file that is empty or only whitespace. */
  readonly result: GrantFileParseResult | null;
}

/** A `--grants-dir` file, under its grant source name. */
export interface GrantsDirFile extends ExternalGrantFile {
  readonly name: string;
  readonly sourceName: string;
  /** Set when the listed file could not be read; result is then null. */
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
  /** The configured directory is the repository grants/ directory. */
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
  /** The repository grants/ directory, by file name. */
  readonly repo: Map<string, GrantFileParseResult>;
  /**
   * Set when grants/ exists but cannot be listed; `repo` is then empty.
   * Serve startup rethrows the cause, as it always has.
   */
  readonly repoUnreadable?: { readonly path: string; readonly cause: unknown };
  readonly grantsFile?: GrantsFileLoad;
  readonly grantsDir?: GrantsDirLoad;
}

export interface ServeGrantFileOptions {
  /** `--grants-file`, relative to the repository when not absolute. */
  readonly grantsFile?: string;
  /** `--grants-dir`, relative to the repository when not absolute. */
  readonly grantsDir?: string;
  readonly validateCondition?: ConditionValidator;
  readonly readTypeLiterals?: ConditionTypeLiteralReader;
}

/**
 * A `--grants-dir` file. Dotfiles are skipped here and not in the repository
 * grants/ directory (readGrantFiles): that difference predates this loader
 * and the poller hashes each directory the same way, so change both together.
 */
function isGrantsDirFile(entry: Deno.DirEntry): boolean {
  return (entry.isFile || entry.isSymlink) &&
    (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
    !entry.name.startsWith(".");
}

/** Reads one `--grants-file`, at an already resolved path. */
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

/** Reads one `--grants-dir` and its grant files, at an already resolved path. */
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

/** Reads every grant file serve reads, resolved as serve resolves them. */
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

/**
 * Why a grant file was reported: it fails to load (`invalid`), cannot be
 * read (`unreadable`), is absent where the check ran (`missing-source`), or
 * spells a type no type is stored as (`spelling`).
 */
export type GrantFileCheckReason =
  | "invalid"
  | "unreadable"
  | "missing-source"
  | "spelling";

/** One grant-file finding, located by file and, when known, entry. */
export interface GrantFileCheckIssue {
  readonly reason: GrantFileCheckReason;
  readonly file: string;
  /** 1-based entry number within the file. */
  readonly entry?: number;
  readonly message: string;
}

export interface GrantFileCheck {
  /** How many grant files were read, empty ones included. */
  readonly filesChecked: number;
  /** What would stop serve starting. */
  readonly errors: readonly GrantFileCheckIssue[];
  /** Advisory: spellings that match no type, and sources absent here. */
  readonly warnings: readonly GrantFileCheckIssue[];
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
 * Judges grant files the way serve startup does: anything that refuses
 * startup is an error. A `--grants-file` or `--grants-dir` that is absent
 * here is only a warning, since it may exist only where serve runs; serve
 * refuses to start if it is absent there.
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
    resultIssues(result, errors, warnings, (name) => join("grants", name));
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
