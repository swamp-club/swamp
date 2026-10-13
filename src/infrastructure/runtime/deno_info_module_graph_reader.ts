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

import { fromFileUrl } from "@std/path";
import { stripAnsiCode } from "@std/fmt/colors";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { denoProjectArgs } from "../../domain/models/bundle.ts";
import type {
  LocalEdge,
  LocalModule,
  MissingLocalModule,
  ModuleGraphProject,
  ModuleGraphReader,
  SourceModuleGraph,
  SpecifierSpan,
} from "../../domain/extensions/extension_source_graph.ts";

/** Upper bound on one `deno info` run; it fetches remote modules on a cold cache. */
const DENO_INFO_TIMEOUT_MS = 5 * 60 * 1000;

const CODE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "JavaScript",
  "Jsx",
  "Mjs",
  "Cjs",
  "TypeScript",
  "Mts",
  "Cts",
  "Dts",
  "Dmts",
  "Dcts",
  "Tsx",
]);

interface DenoInfoDependencyTarget {
  specifier?: string;
  span?: SpecifierSpan;
}

interface DenoInfoDependency {
  specifier?: string;
  code?: DenoInfoDependencyTarget;
  type?: DenoInfoDependencyTarget;
}

interface DenoInfoModule {
  specifier?: string;
  kind?: string;
  mediaType?: string | null;
  error?: string;
  dependencies?: DenoInfoDependency[];
}

function isLocal(specifier: string | undefined): specifier is string {
  return typeof specifier === "string" && specifier.startsWith("file:");
}

/**
 * Reads the local part of `deno info --json` output. `exists` decides
 * whether a module deno did not load itself (a text or bytes import, which
 * deno reports as external) is on disk.
 */
export async function parseDenoInfoGraph(
  json: unknown,
  exists: (path: string) => Promise<boolean>,
): Promise<SourceModuleGraph> {
  const raw = (json as { modules?: DenoInfoModule[] })?.modules;
  if (!Array.isArray(raw)) {
    throw new Error("deno info output has no modules list");
  }
  const modules: LocalModule[] = [];
  const edges: LocalEdge[] = [];
  const missingReasons = new Map<string, string>();

  for (const m of raw) {
    if (!isLocal(m.specifier)) continue;
    const path = fromFileUrl(m.specifier);
    if (m.error) {
      missingReasons.set(path, m.error);
      continue;
    }
    if (m.kind === "esm" && CODE_MEDIA_TYPES.has(m.mediaType ?? "")) {
      modules.push({ path, kind: "code" });
    } else if (m.kind === "external" && !await exists(path)) {
      missingReasons.set(path, `Module not found "${m.specifier}".`);
      continue;
    } else {
      modules.push({ path, kind: "data" });
    }
    for (const dep of m.dependencies ?? []) {
      for (const target of [dep.code, dep.type]) {
        if (!target || !isLocal(target.specifier) || !target.span) continue;
        if (typeof dep.specifier !== "string") continue;
        edges.push({
          importer: path,
          target: fromFileUrl(target.specifier),
          specifier: dep.specifier,
          span: target.span,
        });
      }
    }
  }

  const missing: MissingLocalModule[] = [];
  for (const [path, reason] of missingReasons) {
    const importer = edges.find((e) => e.target === path)?.importer;
    missing.push(importer ? { path, importer, reason } : { path, reason });
  }
  // A module a code import and a type import both reach appears once.
  const seen = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.importer}\0${e.span.start.line}:${e.span.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { modules, edges: uniqueEdges, missing };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Reads an entry point's module graph with `deno info --json`, run with the
 * same project flags, working directory and environment as `deno bundle`, so
 * the graph is the one the bundle is built from.
 */
export class DenoInfoModuleGraphReader implements ModuleGraphReader {
  constructor(
    private readonly denoPath: string,
    private readonly env?: Record<string, string>,
  ) {}

  async read(
    entryPoint: string,
    project: ModuleGraphProject,
  ): Promise<SourceModuleGraph> {
    const command = new Deno.Command(this.denoPath, {
      args: ["info", "--json", ...denoProjectArgs(project), entryPoint],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(DENO_INFO_TIMEOUT_MS),
      ...(project.packageJsonDir ? { cwd: project.packageJsonDir } : {}),
      ...(this.env ? { env: this.env } : {}),
    });
    const output = await command.output();
    if (!output.success) {
      const details = stripAnsiCode(
        new TextDecoder().decode(output.stderr).trim(),
      ) || `deno info exited with code ${output.code}`;
      throw markErrorPaths(
        new UserError(
          `Could not read the module graph of ${entryPoint}, so push cannot ` +
            `tell which local modules to include: ${details}`,
        ),
        [entryPoint],
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(output.stdout));
    } catch (error) {
      throw new Error(
        `deno info returned invalid JSON for ${entryPoint}: ${error}`,
      );
    }
    return await parseDenoInfoGraph(json, fileExists);
  }
}
