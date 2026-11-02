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

import type {
  ExtensionAcceptance,
  ExtensionAcceptances,
} from "./extension_content.ts";

/**
 * the registry stores at most this many; the cap is enforced again so an
 * unbounded response cannot flood an installer's terminal
 */
export const MAX_REGISTRY_ACCEPTANCES = 500;

const SOURCES: ReadonlySet<string> = new Set([
  "inline",
  "sidecar",
  "generated",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(raw: unknown): ExtensionAcceptance | undefined {
  if (!isRecord(raw)) return undefined;
  const { rule, file, line, reason, source } = raw;
  if (typeof rule !== "string" || rule.length === 0) return undefined;
  if (typeof source !== "string" || !SOURCES.has(source)) return undefined;
  return {
    rule,
    ...(typeof file === "string" && file.length > 0 ? { file } : {}),
    ...(Number.isInteger(line) && (line as number) > 0
      ? { line: line as number }
      : {}),
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
    source: source as ExtensionAcceptance["source"],
  };
}

function parseGenerated(
  raw: unknown,
): ExtensionAcceptances["generated"] | undefined {
  if (!isRecord(raw)) return undefined;
  const { by, source, commit } = raw;
  if (
    typeof by !== "string" || typeof source !== "string" ||
    typeof commit !== "string"
  ) {
    return undefined;
  }
  return { by, source, commit };
}

/**
 * nulls become absent fields, malformed entries are dropped, at most
 * MAX_REGISTRY_ACCEPTANCES are kept and total is never less than the entries
 * read; undefined when nothing usable is declared
 */
export function parseRegistryAcceptances(
  raw: unknown,
): ExtensionAcceptances | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.accepted)) return undefined;
  const entries: ExtensionAcceptance[] = [];
  for (const item of raw.accepted) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  const generated = parseGenerated(raw.generated);
  if (entries.length === 0 && !generated) return undefined;
  const accepted = entries.slice(0, MAX_REGISTRY_ACCEPTANCES);
  const total = Number.isInteger(raw.total) &&
      (raw.total as number) >= entries.length
    ? raw.total as number
    : entries.length;
  return {
    accepted,
    ...(generated ? { generated } : {}),
    total,
  };
}
