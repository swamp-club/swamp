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
 * Parsing input that crosses a trust boundary without letting its size decide
 * how much a refusal costs (swamp-club#3862).
 *
 * A failed zod parse builds one issue per failing element, so an array of a
 * million non-strings under `z.array(z.string())` allocates a million issues:
 * a 7.6 MiB serve message held 4.4 GB of heap. zod's `abortEarly` parse option
 * stops an array, object, map, set or union at its first failing child. zod
 * marks the option internal (it is set by `validate()`), but `safeParse`
 * spreads the context it is given and the type is exported, so it is passed
 * here without a cast. untrusted_parse_test.ts pins the behaviour, so a zod
 * release that drops it fails CI instead of bringing the amplification back.
 *
 * Records ignore `abortEarly` and have no `.max()` in zod 4.6.7, so a record
 * whose values can fail is bounded with {@link boundedRecord} instead.
 */

type ParseContext = z.core.ParseContextInternal<z.core.$ZodIssue>;

const ABORT_EARLY: ParseContext = { abortEarly: true };

/** `schema.safeParse(input)`, stopping each container at its first failure. */
export function parseUntrusted<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.ZodSafeParseResult<z.output<S>> {
  return schema.safeParse(input, ABORT_EARLY);
}

/**
 * As {@link parseUntrusted}, returning the data or throwing the same
 * `ZodError` `schema.parse` throws.
 */
export function parseUntrustedOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = parseUntrusted(schema, input);
  if (!result.success) throw result.error;
  return result.data;
}

/** Most entries a {@link boundedRecord} accepts unless told otherwise. */
export const MAX_UNTRUSTED_RECORD_ENTRIES = 1000;

const recordGuards = new WeakSet<z.ZodType>();

/**
 * `z.record(key, value)` refusing more than `maxEntries` entries with one
 * issue, before any entry is parsed. A value that is not an object passes the
 * count and is refused by the record as before.
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

/**
 * Whether `schema` is the entry-count guard of a {@link boundedRecord}, for
 * the fitness test that walks the ingress schemas.
 */
export function isBoundedRecordGuard(schema: unknown): boolean {
  return schema instanceof z.ZodType && recordGuards.has(schema);
}

/**
 * At most `max` issues as `path: message`, joined with `; `, then how many
 * were left out. For swamp's own static schemas only: a schema with sensitive
 * fields formats `maskRefusedIssues(schema, input, issues)` instead.
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
 * How a process parses run arguments and inputs. `"untrusted"` stops at the
 * first failing element of each container, for a process whose runs carry
 * values a remote client chose; `"trusted"` reports every failure, for a user
 * running their own definitions.
 */
export type ArgumentParsePolicy = "trusted" | "untrusted";

let processArgumentParsePolicy: ArgumentParsePolicy = "trusted";

/**
 * Sets the process's {@link ArgumentParsePolicy}; serve sets `"untrusted"` at
 * startup. It reaches only runs executed in this process, so a run moved into
 * a subprocess would need the policy passed along. Returns a function that
 * restores the previous policy, for tests.
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

/** Whether run arguments and inputs stop at their first failing element. */
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

/** The parse context for a run-argument schema under the process's policy. */
export function argumentParseContext(): ParseContext {
  return stopsAtFirstFailingArgument()
    ? UNTRUSTED_ARGUMENTS
    : TRUSTED_ARGUMENTS;
}
