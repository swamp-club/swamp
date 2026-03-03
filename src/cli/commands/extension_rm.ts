// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { Command } from "@cliffy/command";
import { dirname, join, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import {
  parseExtensionRef,
  readUpstreamExtensions,
  removeUpstreamExtension,
} from "./extension_pull.ts";
import { parseExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import {
  renderExtensionRm,
  renderExtensionRmCancelled,
  renderExtensionRmDependencyWarning,
  renderExtensionRmFileDelete,
} from "../../presentation/output/extension_rm_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+$/;

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

/**
 * Finds installed extensions that depend on the given extension name
 * by scanning manifest.yaml files tracked in upstream_extensions.json.
 */
async function findDependents(
  repoDir: string,
  upstreamData: Record<string, { version: string; files?: string[] }>,
  targetName: string,
): Promise<string[]> {
  const dependents: string[] = [];

  for (const [extName, entry] of Object.entries(upstreamData)) {
    if (extName === targetName) continue;
    if (!entry.files) continue;

    // Look for manifest.yaml among this extension's tracked files
    const manifestFile = entry.files.find((f) => f.endsWith("manifest.yaml"));
    if (!manifestFile) continue;

    try {
      const manifestPath = join(repoDir, manifestFile);
      const content = await Deno.readTextFile(manifestPath);
      const manifest = parseExtensionManifest(content);
      if (manifest.dependencies.includes(targetName)) {
        dependents.push(extName);
      }
    } catch {
      // If manifest can't be read or parsed, skip
    }
  }

  return dependents;
}

/**
 * Removes empty parent directories up to (but not including) the stop directory.
 * Returns the number of directories removed.
 */
async function pruneEmptyDirs(
  dirs: string[],
  stopDir: string,
): Promise<number> {
  let removed = 0;
  const resolvedStop = resolve(stopDir);

  // Sort directories deepest-first so children are pruned before parents
  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);

  for (const dir of sorted) {
    let current = resolve(dir);
    while (current.length > resolvedStop.length && current !== resolvedStop) {
      try {
        const entries = [];
        for await (const entry of Deno.readDir(current)) {
          entries.push(entry);
        }
        if (entries.length === 0) {
          await Deno.remove(current);
          removed++;
          current = dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  return removed;
}

export const extensionRemoveCommand = new Command()
  .name("rm")
  .alias("remove")
  .description("Remove a pulled extension and its files")
  .arguments("<extension:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-f, --force", "Skip confirmation prompt")
  .action(async function (options: AnyOptions, extension: string) {
    const ctx = createContext(options as GlobalOptions, ["extension", "rm"]);
    ctx.logger.debug`Starting extension remove`;

    const repoDir = options.repoDir ?? ".";
    await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // Parse extension reference (ignore version if provided)
    const ref = parseExtensionRef(extension);

    // Validate name format
    if (!SCOPED_NAME_PATTERN.test(ref.name)) {
      throw new UserError(
        `Invalid extension name: "${ref.name}". Must match @namespace/name pattern (lowercase, alphanumeric, hyphens, underscores).`,
      );
    }

    // Resolve models dir from .swamp.yaml
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);

    // Read upstream_extensions.json
    const upstreamData = await readUpstreamExtensions(absoluteModelsDir);

    const entry = upstreamData[ref.name];
    if (!entry) {
      throw new UserError(
        `Extension ${ref.name} is not installed.`,
      );
    }

    // Check if entry has a files array (required for clean removal)
    if (!entry.files) {
      throw new UserError(
        `Extension ${ref.name} was pulled before file tracking was added. Re-pull with --force to populate the file list, then retry rm.`,
      );
    }

    // Check for dependents
    const dependents = await findDependents(
      repoDir,
      upstreamData,
      ref.name,
    );
    if (dependents.length > 0) {
      renderExtensionRmDependencyWarning(dependents, ctx.outputMode);
    }

    // Confirmation prompt (log mode only, unless --force)
    if (ctx.outputMode === "log" && !options.force) {
      const confirmed = await promptConfirmation(
        `Remove ${ref.name} (v${entry.version})? This will delete ${entry.files.length} file(s).`,
      );
      if (!confirmed) {
        renderExtensionRmCancelled(ctx.outputMode);
        return;
      }
    }

    // Delete files
    const verbose = ctx.verbosity === "verbose";
    let filesDeleted = 0;
    let filesSkipped = 0;
    const parentDirs: string[] = [];

    for (const filePath of entry.files) {
      const absolutePath = join(repoDir, filePath);
      try {
        await Deno.remove(absolutePath);
        filesDeleted++;
        parentDirs.push(dirname(absolutePath));
        if (verbose) {
          renderExtensionRmFileDelete(filePath, "deleted", ctx.outputMode);
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          filesSkipped++;
          if (verbose) {
            renderExtensionRmFileDelete(filePath, "missing", ctx.outputMode);
          }
        } else {
          throw error;
        }
      }
    }

    // Prune empty parent directories
    const dirsRemoved = await pruneEmptyDirs(parentDirs, repoDir);

    // Remove entry from upstream_extensions.json
    await removeUpstreamExtension(absoluteModelsDir, ref.name);

    // Render success
    renderExtensionRm(
      {
        name: ref.name,
        version: entry.version,
        filesDeleted,
        filesSkipped,
        dirsRemoved,
      },
      ctx.outputMode,
    );

    ctx.logger.debug("Extension remove command completed");
  });
