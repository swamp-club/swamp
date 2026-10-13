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

import { isAbsolute, relative, SEPARATOR } from "@std/path";
import {
  dirname as posixDirname,
  join as posixJoin,
  normalize as posixNormalize,
  relative as posixRelative,
} from "@std/path/posix";
import { markErrorPaths, UserError } from "../errors.ts";
import { QUALITY_SIDECAR_FILENAME } from "./extension_quality_sidecar.ts";
import type {
  LocalEdge,
  SourceModuleGraph,
  SpecifierSpan,
} from "./extension_source_graph.ts";

/** The archive directory each content kind's sources are copied under. */
export type SourceArchiveKind =
  | "models"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks";

/** The modules one content kind reaches, and the directory its archive paths are relative to. */
export interface SourceArchiveKindInput {
  kind: SourceArchiveKind;
  /** Absolute path of the kind's directory (its archive directory's source). */
  dir: string;
  /** Absolute paths of every local module the kind's entry points reach, entry points included. */
  modules: readonly string[];
}

export interface PlanSourceArchiveInput {
  /** Kinds in a fixed order; the first kind to place a shared module decides its path. */
  kinds: readonly SourceArchiveKindInput[];
  graph: SourceModuleGraph;
  /** Anchor for `_shared/` paths: the extensions root the content hash is relative to. */
  extensionsRoot: string;
  /** Directories every module must lie inside (the repository and the extensions root). */
  allowedRoots: readonly string[];
}

/** Replace the specifier inside `span` with `to`. */
export interface SpecifierRewrite {
  span: SpecifierSpan;
  from: string;
  to: string;
}

/** One file in the archive's source copy. */
export interface SourceArchiveEntry {
  sourcePath: string;
  /** Forward-slash path under `extension/`. */
  archivePath: string;
  /** Empty when the file is copied byte for byte. */
  rewrites: SpecifierRewrite[];
}

export interface SourceArchivePlan {
  entries: SourceArchiveEntry[];
}

/** Archive directory for shared modules no mirrored path can hold. */
export const SHARED_ARCHIVE_DIR = "_shared";

/** Stands in for a `..` segment under {@link SHARED_ARCHIVE_DIR}; the registry rejects `..` in archive paths. */
const UP_SEGMENT = "_up";

/**
 * Top-level archive names a mirrored shared module may not take: push writes
 * them itself, pull installs them as a kind's sources or bundles, or they are
 * reserved for shared modules.
 */
const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  "manifest.yaml",
  QUALITY_SIDECAR_FILENAME,
  "models",
  "bundles",
  "workflows",
  "vaults",
  "vault-bundles",
  "datastores",
  "datastore-bundles",
  "reports",
  "report-bundles",
  "webhooks",
  "webhook-bundles",
  "skills",
  "files",
  SHARED_ARCHIVE_DIR,
]);

function toForwardSlashes(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

/** `path` relative to `dir` with forward slashes, or undefined when `path` is on another root. */
function relativeForward(dir: string, path: string): string | undefined {
  const rel = relative(dir, path);
  if (isAbsolute(rel)) return undefined;
  return toForwardSlashes(rel);
}

function isInside(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith("../");
}

/**
 * The archive path a module one level above the kind's directory would have
 * if the archive root stood in for that parent directory, so the kind's
 * relative imports reach it unchanged; undefined for any other module.
 */
function mirroredRootPath(kindDir: string, path: string): string | undefined {
  const rel = relativeForward(kindDir, path);
  if (rel === undefined || !rel.startsWith("../")) return undefined;
  const rest = rel.slice(3);
  return isInside(rest) && !rest.split("/").includes("..") ? rest : undefined;
}

/**
 * Where a module outside its kind's directory goes: mirrored at the archive
 * root when it sits one level above the kind's directory under a name the
 * archive does not reserve, else under `_shared/`.
 */
function sharedPlacement(
  kindDir: string,
  extensionsRoot: string,
  path: string,
): string {
  const mirrored = mirroredRootPath(kindDir, path);
  if (
    mirrored !== undefined && !RESERVED_ROOT_NAMES.has(mirrored.split("/")[0])
  ) {
    return mirrored;
  }
  const fromRoot = relativeForward(extensionsRoot, path);
  if (fromRoot === undefined) {
    throw markErrorPaths(
      new Error(`Cannot place ${path} relative to ${extensionsRoot}`),
      [path, extensionsRoot],
    );
  }
  const segments = fromRoot.split("/").map((s) => s === ".." ? UP_SEGMENT : s);
  return `${SHARED_ARCHIVE_DIR}/${segments.join("/")}`;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function relativeSpecifier(fromArchivePath: string, to: string): string {
  const rel = posixRelative(posixDirname(fromArchivePath), to);
  return rel.startsWith("../") ? rel : `./${rel}`;
}

function assertContained(
  path: string,
  allowedRoots: readonly string[],
  importer: string | undefined,
): void {
  for (const root of allowedRoots) {
    const rel = relativeForward(root, path);
    if (rel !== undefined && isInside(rel)) return;
  }
  const by = importer ? ` (imported from ${importer})` : "";
  throw markErrorPaths(
    new UserError(
      `Local module ${path}${by} is outside the repository and the ` +
        `extensions root, so push cannot include it in the archive. Move it ` +
        `inside the repository.`,
    ),
    importer ? [path, importer] : [path],
  );
}

/**
 * Plans the archive's source copy: an archive path for every local module
 * each kind reaches, and the specifier rewrites that keep every local import
 * resolving inside the archive.
 *
 * - A module inside its kind's directory keeps the path it has always had,
 *   `<kind>/<path relative to the kind directory>`; each kind gets its own
 *   copy, as before.
 * - A module outside it that lies inside another kind's directory uses that
 *   kind's copy (a report importing `../models/_lib/x.ts` reaches
 *   `models/_lib/x.ts` unchanged).
 * - Any other module outside it is placed once: at its mirrored path at the archive
 *   root when it is one level above the kind directory (`../lib/x.ts` ->
 *   `lib/x.ts`), else under `_shared/` by its path from the extensions root.
 * - An import whose specifier, read from the importer's archive path, does
 *   not reach the target's archive path is rewritten. Files whose imports all
 *   resolve as written are copied byte for byte.
 *
 * Throws a UserError when a module lies outside every allowed root or two
 * different files would share an archive path.
 */
export function planSourceArchive(
  input: PlanSourceArchiveInput,
): SourceArchivePlan {
  const importerOf = new Map<string, string>();
  for (const e of input.graph.edges) {
    if (!importerOf.has(e.target)) importerOf.set(e.target, e.importer);
  }

  // In-kind copies, per kind: module path -> archive path.
  const inKind = new Map<SourceArchiveKind, Map<string, string>>();
  // Shared placements, once per module.
  const shared = new Map<string, string>();
  const occupant = new Map<string, string>();
  const claim = (archivePath: string, sourcePath: string) => {
    const existing = occupant.get(archivePath);
    if (existing !== undefined && existing !== sourcePath) {
      throw markErrorPaths(
        new UserError(
          `${existing} and ${sourcePath} would both be packaged as ` +
            `${archivePath}. Rename or move one of them so each local ` +
            `module has its own archive path.`,
        ),
        [existing, sourcePath, archivePath],
      );
    }
    occupant.set(archivePath, sourcePath);
  };

  for (const k of input.kinds) {
    const placed = new Map<string, string>();
    inKind.set(k.kind, placed);
    for (const path of k.modules) {
      assertContained(path, input.allowedRoots, importerOf.get(path));
      const rel = relativeForward(k.dir, path);
      if (rel === undefined || !isInside(rel)) continue;
      const archivePath = posixNormalize(`${k.kind}/${rel}`);
      claim(archivePath, path);
      placed.set(path, archivePath);
    }
  }
  // A module inside another kind's directory already has a copy there; a
  // kind that imports it from outside its own directory uses that copy,
  // preferring the one its relative imports reach unchanged.
  const copiesOf = new Map<string, string[]>();
  for (const placed of inKind.values()) {
    for (const [path, archivePath] of placed) {
      copiesOf.set(path, [...(copiesOf.get(path) ?? []), archivePath]);
    }
  }
  const borrowed = new Map<SourceArchiveKind, Map<string, string>>();
  for (const k of input.kinds) {
    const placed = inKind.get(k.kind)!;
    const fromOtherKinds = new Map<string, string>();
    borrowed.set(k.kind, fromOtherKinds);
    for (const path of k.modules) {
      if (placed.has(path)) continue;
      const copies = copiesOf.get(path);
      if (copies) {
        const mirrored = mirroredRootPath(k.dir, path);
        fromOtherKinds.set(
          path,
          mirrored !== undefined && copies.includes(mirrored)
            ? mirrored
            : copies[0],
        );
        continue;
      }
      if (shared.has(path)) continue;
      const archivePath = sharedPlacement(k.dir, input.extensionsRoot, path);
      claim(archivePath, path);
      shared.set(path, archivePath);
    }
  }

  const edgesByImporter = new Map<string, LocalEdge[]>();
  for (const e of input.graph.edges) {
    const list = edgesByImporter.get(e.importer) ?? [];
    list.push(e);
    edgesByImporter.set(e.importer, list);
  }

  const entries = new Map<string, SourceArchiveEntry>();
  const addEntry = (
    sourcePath: string,
    archivePath: string,
    locate: (target: string) => string | undefined,
  ) => {
    if (entries.has(archivePath)) return;
    const rewrites: SpecifierRewrite[] = [];
    for (const e of edgesByImporter.get(sourcePath) ?? []) {
      const targetPath = locate(e.target);
      if (targetPath === undefined) {
        throw markErrorPaths(
          new UserError(
            `Not in the archive: ${e.target} (imported from ${sourcePath} ` +
              `as ${e.specifier}).`,
          ),
          [e.target, sourcePath],
        );
      }
      const asWritten = isRelativeSpecifier(e.specifier)
        ? posixNormalize(posixJoin(posixDirname(archivePath), e.specifier))
        : undefined;
      if (asWritten === targetPath) continue;
      rewrites.push({
        span: e.span,
        from: e.specifier,
        to: relativeSpecifier(archivePath, targetPath),
      });
    }
    rewrites.sort((a, b) =>
      a.span.start.line - b.span.start.line ||
      a.span.start.character - b.span.start.character
    );
    entries.set(archivePath, { sourcePath, archivePath, rewrites });
  };

  for (const k of input.kinds) {
    const placed = inKind.get(k.kind)!;
    const fromOtherKinds = borrowed.get(k.kind)!;
    const locate = (target: string) =>
      placed.get(target) ?? fromOtherKinds.get(target) ?? shared.get(target);
    for (const path of k.modules) {
      // A copy borrowed from another kind is written by that kind.
      if (fromOtherKinds.has(path)) continue;
      addEntry(path, placed.get(path) ?? shared.get(path)!, locate);
    }
  }

  return {
    entries: [...entries.values()].sort((a, b) =>
      a.archivePath < b.archivePath ? -1 : a.archivePath > b.archivePath ? 1 : 0
    ),
  };
}

/**
 * Applies specifier rewrites to a module's text. Spans are zero-based lines
 * and code-point columns, quotes included; each must cover the quoted
 * specifier it names, or this throws rather than corrupt the file.
 */
export function applySpecifierRewrites(
  text: string,
  rewrites: readonly SpecifierRewrite[],
): string {
  if (rewrites.length === 0) return text;
  const lines = text.split("\n");
  const ordered = [...rewrites].sort((a, b) =>
    b.span.start.line - a.span.start.line ||
    b.span.start.character - a.span.start.character
  );
  for (const r of ordered) {
    const { start, end } = r.span;
    if (start.line !== end.line || lines[start.line] === undefined) {
      throw new Error(
        `Import specifier span does not fit the file: ${JSON.stringify(r)}`,
      );
    }
    const chars = Array.from(lines[start.line]);
    const quoted = chars.slice(start.character, end.character).join("");
    const quote = quoted[0];
    if (
      quoted.length < 2 || quoted !== `${quote}${r.from}${quote}` ||
      !["'", '"', "`"].includes(quote)
    ) {
      throw new Error(
        `Import specifier span does not cover ${r.from}: found ${quoted}`,
      );
    }
    lines[start.line] = [
      ...chars.slice(0, start.character),
      `${quote}${r.to}${quote}`,
      ...chars.slice(end.character),
    ].join("");
  }
  return lines.join("\n");
}
