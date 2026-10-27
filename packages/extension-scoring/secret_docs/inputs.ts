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
 * Which files in an extension archive the secret-safe-docs check reads,
 * and how. Push and the registry both decide with these, from the archive
 * paths the files have (relative to the manifest root, forward slashes).
 */

import { isAuditedCodeFile } from "../dependency_audit/specifiers.ts";
import { importedSpecifiers } from "../source/imports.ts";
import type { SecretDocsForm } from "./detector.ts";
import {
  MAX_SECRET_DOCS_FILE_BYTES,
  MAX_SECRET_DOCS_FILES,
} from "./detector.ts";

/** A file in the archive. */
export interface ArchiveFile {
  /** Relative to the manifest root, forward slashes. */
  path: string;
  /** Bytes. */
  size: number;
}

/** A file the check reads, and how. */
export interface SecretDocsTarget {
  path: string;
  form: SecretDocsForm;
}

/**
 * Archive paths that are packaged but are not the extension's own docs:
 * `binaries:` entries (under `files/`) and `include:` entries (under
 * `models/`).
 */
export function nonDocumentationPaths(manifest: {
  binaries?: readonly string[];
  include?: readonly string[];
}): Set<string> {
  const out = new Set<string>();
  const fwd = (p: string) => p.replaceAll("\\", "/").replace(/^\.\//, "");
  for (const b of manifest.binaries ?? []) out.add(`files/${fwd(b)}`);
  for (const i of manifest.include ?? []) out.add(`models/${fwd(i)}`);
  return out;
}

/** Joins a relative specifier onto its importer's directory; null when it climbs out. */
function resolveRelative(importer: string, specifier: string): string | null {
  const parts = importer.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/**
 * The Markdown files a code module imports (as data, not docs), resolved
 * against its archive path.
 */
export function markdownImports(path: string, source: string): string[] {
  const out: string[] = [];
  for (const specifier of importedSpecifiers(source, { path })) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    if (!specifier.toLowerCase().endsWith(".md")) continue;
    const resolved = resolveRelative(path, specifier);
    if (resolved !== null) out.push(resolved);
  }
  return out;
}

/**
 * The files the check reads: every Markdown file except binaries, include
 * files and those a code module imports as data; and every code module
 * that is not a test, in `source` form, wherever it sits, so include files
 * and modules outside the kind directories are read too. A file over
 * {@link MAX_SECRET_DOCS_FILE_BYTES}, or more than
 * {@link MAX_SECRET_DOCS_FILES} files, is not read and marks the scan
 * truncated, which fails the factor. The manifest description is read
 * separately, as `plain` text.
 *
 * @param importedMarkdown the archive paths {@link markdownImports} found
 *   across the archive's code modules
 * @returns the targets, and the documentation left unread (`unread`, with
 *   `truncated` set when there is any)
 */
export function secretDocsTargets(
  files: readonly ArchiveFile[],
  manifest: { binaries?: readonly string[]; include?: readonly string[] },
  importedMarkdown: ReadonlySet<string>,
): { targets: SecretDocsTarget[]; truncated: boolean; unread: string[] } {
  const excluded = nonDocumentationPaths(manifest);
  const targets: SecretDocsTarget[] = [];
  const unread: string[] = [];
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  for (const file of sorted) {
    const isMarkdown = file.path.toLowerCase().endsWith(".md");
    const form: SecretDocsForm | null = isMarkdown
      ? excluded.has(file.path) || importedMarkdown.has(file.path)
        ? null
        : "markdown"
      : file.path.toLowerCase().endsWith(".ts") && isAuditedCodeFile(file.path)
      ? "source"
      : null;
    if (form === null) continue;
    if (
      file.size > MAX_SECRET_DOCS_FILE_BYTES ||
      targets.length >= MAX_SECRET_DOCS_FILES
    ) {
      unread.push(file.path);
      continue;
    }
    targets.push({ path: file.path, form });
  }
  return { targets, truncated: unread.length > 0, unread };
}
