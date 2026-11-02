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

import { redactPaths, stripAnsi } from "./text.ts";

export const MAX_DOC_FAILURE_CHARS = 300;

const MAX_NAMED_PER_KIND = 3;

const MAX_SPECIFIER_CHARS = 80;

export const DOC_FAILURE_FALLBACK =
  "deno doc could not analyse this version's source.";

// deno doc's own wording; anything it rewords falls through to the fixed sentence
const BARE_IMPORT_RE = /Import "([^"]+)" not a dependency/;
const MODULE_NOT_FOUND_RE = /Module not found "file:\/\/([^"]+)"/;
const IMPORTED_AT_RE = /^\s*at file:\/\/(.+?):\d+:\d+\s*$/;
const IMPORT_ACCESS_RE = /Requires import access to "([^"]+)"/;

// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

function clean(text: string): string {
  return stripAnsi(text).replace(CONTROL_RE, "");
}

function quoteSpecifier(specifier: string): string {
  const s = clean(specifier).replace(/["`]/g, "");
  return s.length > MAX_SPECIFIER_CHARS
    ? `${s.slice(0, MAX_SPECIFIER_CHARS - 1)}…`
    : s;
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
 * raw deno output never leaves this function; paths are relative to the
 * extraction root, any other path is redacted. roots are the root as it appears
 * in file:// URLs, several when it has more than one spelling
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

/**
 * npm publishing no version matching these specifiers fails deno's whole npm
 * resolution, so deno's own output names whichever import it was resolving;
 * only the CLI consults the audit before scoring
 */
export function describeUnpublishedSpecifiers(specifiers: string[]): string {
  return cap(
    `npm publishes no version matching ${
      listed(specifiers.map(quoteSpecifier))
    }, so deno doc could not resolve the extension's npm imports.`,
  );
}
