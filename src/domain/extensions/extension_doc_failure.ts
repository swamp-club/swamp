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
 * Why `deno doc` could not analyse an extension's source, in a short
 * sentence that names only what failed to resolve. Mirrors swamp-club's
 * `lib/domain/scorecard/doc-failure.ts` (swamp-club#3370), so the CLI's
 * quality run and the registry's scorecard describe a failure the same way.
 */

/** Longest description returned. */
export const MAX_DOC_FAILURE_CHARS = 300;

const MAX_NAMED_PER_KIND = 3;

const MAX_SPECIFIER_CHARS = 80;

/** The description when deno's output names nothing recognisable. */
export const DOC_FAILURE_FALLBACK =
  "deno doc could not analyse this version's source.";

// deno doc's own wording; anything it rewords falls through to the fixed sentence
const BARE_IMPORT_RE = /Import "([^"]+)" not a dependency/;
const MODULE_NOT_FOUND_RE = /Module not found "file:\/\/([^"]+)"/;
const IMPORTED_AT_RE = /^\s*at file:\/\/(.+?):\d+:\d+\s*$/;
const IMPORT_ACCESS_RE = /Requires import access to "([^"]+)"/;

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

function clean(text: string): string {
  return text.replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

function quoteSpecifier(specifier: string): string {
  const s = clean(specifier).replace(/["`]/g, "");
  return s.length > MAX_SPECIFIER_CHARS
    ? `${s.slice(0, MAX_SPECIFIER_CHARS - 1)}…`
    : s;
}

function redactPaths(message: string): string {
  return message.replace(/\/[^\s:]*/g, "<redacted>");
}

function relativeTo(roots: string[], path: string): string {
  const decoded = safeDecode(path);
  for (const root of roots) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (decoded.startsWith(prefix)) {
      return quoteSpecifier(decoded.slice(prefix.length));
    }
  }
  return redactPaths(decoded);
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function listed(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED_PER_KIND);
  const more = names.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

function cap(text: string): string {
  return text.length > MAX_DOC_FAILURE_CHARS
    ? `${text.slice(0, MAX_DOC_FAILURE_CHARS - 1)}…`
    : text;
}

/**
 * Describe a failed `deno doc` run from its combined output. Raw deno
 * output never leaves this function: the result names the bare imports
 * that did not resolve, the modules missing from the archive (relative to
 * the extraction root; any other path is redacted), and the hosts imports
 * may not be fetched from, or {@link DOC_FAILURE_FALLBACK}.
 *
 * @param roots the extraction root as it appears in deno's `file://` URLs,
 *   with forward slashes; several when the root has more than one spelling
 *   (resolved and real path)
 */
export function describeDocFailure(output: string, roots: string[]): string {
  const lines = clean(output).split("\n");
  const bare: string[] = [];
  const missing: string[] = [];
  const hosts: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bareMatch = BARE_IMPORT_RE.exec(line);
    if (bareMatch) {
      const name = `"${quoteSpecifier(bareMatch[1])}"`;
      if (!bare.includes(name)) bare.push(name);
      continue;
    }
    const missingMatch = MODULE_NOT_FOUND_RE.exec(line);
    if (missingMatch) {
      const module = relativeTo(roots, missingMatch[1]);
      const at = IMPORTED_AT_RE.exec(lines[i + 1] ?? "");
      const entry = at
        ? `${module} (imported from ${relativeTo(roots, at[1])})`
        : module;
      if (!missing.includes(entry)) missing.push(entry);
      continue;
    }
    const accessMatch = IMPORT_ACCESS_RE.exec(line);
    if (accessMatch) {
      const host = quoteSpecifier(accessMatch[1]);
      if (!hosts.includes(host)) hosts.push(host);
    }
  }

  const sentences: string[] = [];
  if (bare.length > 0) {
    const zodHint = bare.includes('"zod"') ? " (npm:zod@4 for zod)" : "";
    sentences.push(
      `The registry cannot resolve the bare ${
        bare.length === 1 ? "import" : "imports"
      } ${listed(bare)}; use an explicit npm: or jsr: specifier${zodHint}.`,
    );
  }
  if (missing.length > 0) {
    sentences.push(`Not in the published archive: ${listed(missing)}.`);
  }
  if (hosts.length > 0) {
    sentences.push(`The scorer may not fetch imports from ${listed(hosts)}.`);
  }

  return sentences.length > 0 ? cap(sentences.join(" ")) : DOC_FAILURE_FALLBACK;
}
