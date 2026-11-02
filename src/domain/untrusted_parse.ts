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

import { z } from "zod";

/**
 * zod's abortEarly stops each container at its first failing child, so a huge
 * bad array cannot allocate an issue per element; records ignore it and are
 * bounded with boundedRecord instead
 */

type ParseContext = z.core.ParseContextInternal<z.core.$ZodIssue>;

const ABORT_EARLY: ParseContext = { abortEarly: true };

export function parseUntrusted<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.ZodSafeParseResult<z.output<S>> {
  return schema.safeParse(input, ABORT_EARLY);
}

export function parseUntrustedOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = parseUntrusted(schema, input);
  if (!result.success) throw result.error;
  return result.data;
}

export const MAX_UNTRUSTED_RECORD_ENTRIES = 1000;

const recordGuards = new WeakSet<z.ZodType>();

/**
 * refuses more than maxEntries entries with one issue before any entry is
 * parsed
 */
export function boundedRecord<
  K extends z.core.$ZodRecordKey,
  V extends z.ZodType,
>(key: K, value: V, maxEntries: number = MAX_UNTRUSTED_RECORD_ENTRIES) {
  const guard = z.custom<Record<string, unknown>>(
    (input) =>
      typeof input !== "object" || input === null ||
      Object.keys(input).length <= maxEntries,
    { message: `Too many entries (max ${maxEntries})`, abort: true },
  );
  recordGuards.add(guard);
  return guard.pipe(z.record(key, value));
}

export function isBoundedRecordGuard(schema: unknown): boolean {
  return schema instanceof z.ZodType && recordGuards.has(schema);
}

/**
 * for swamp's own static schemas only: a schema with sensitive fields formats
 * maskRefusedIssues instead
 */
export function formatUntrustedIssues(
  issues: readonly z.core.$ZodIssue[],
  max: number,
): string {
  const shown = issues.slice(0, max).map((issue) =>
    `${issue.path.map(String).join(".")}: ${issue.message}`
  );
  const omitted = issues.length - shown.length;
  if (omitted > 0) shown.push(`and ${omitted} more`);
  return shown.join("; ");
}

/**
 * untrusted stops at the first failing element of each container, for runs
 * carrying values a remote client chose; trusted reports every failure
 */
export type ArgumentParsePolicy = "trusted" | "untrusted";

let processArgumentParsePolicy: ArgumentParsePolicy = "trusted";

/**
 * reaches only runs executed in this process, so a run moved into a subprocess
 * would need the policy passed along
 */
export function setProcessArgumentParsePolicy(
  policy: ArgumentParsePolicy,
): () => void {
  const previous = processArgumentParsePolicy;
  processArgumentParsePolicy = policy;
  return () => {
    processArgumentParsePolicy = previous;
  };
}

export function stopsAtFirstFailingArgument(): boolean {
  return processArgumentParsePolicy === "untrusted";
}

// Each issue carries what its failing check received, so a refusal under a
// transform can register the transformed spelling before it is shown.
const TRUSTED_ARGUMENTS: ParseContext = { reportInput: true };
const UNTRUSTED_ARGUMENTS: ParseContext = {
  reportInput: true,
  abortEarly: true,
};

export function argumentParseContext(): ParseContext {
  return stopsAtFirstFailingArgument()
    ? UNTRUSTED_ARGUMENTS
    : TRUSTED_ARGUMENTS;
}
