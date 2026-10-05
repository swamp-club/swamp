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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  evaluateReviewRules,
  type ReviewSource,
} from "./extension_review_rules.ts";

/** Secret stems as segments, so camelCase and snake_case spellings are built the same way. */
const STEMS: string[][] = [
  ["password"],
  ["passwd"],
  ["secret"],
  ["token"],
  ["api", "key"],
  ["access", "key"],
  ["credential"],
  ["private", "key"],
];

/** Reference suffixes as segments, mirroring REFERENCE_SUFFIX in the rule. */
const STOP_SUFFIXES: string[][] = [
  ["name"],
  ["id"],
  ["reference"],
  ["ref"],
  ["arn"],
  ["uri"],
  ["url"],
  ["endpoint"],
  ["link"],
  ["version"],
  ["type"],
  ["kind"],
  ["count"],
  ["ttl"],
  ["timeout"],
  ["expire", "time"],
  ["source"],
];

/** Lists mirror REFERENCE_SUFFIX and REFERENCE_WORD in the rule by hand; keep them in step. */
const STOP_SEGMENTS = new Set(STOP_SUFFIXES.flat());

/** Whole identifiers that are pagination or idempotency tokens, as segments. */
const STOP_WORDS: string[][] = [
  ["next", "token"],
  ["page", "token"],
  ["next", "page", "token"],
  ["client", "token"],
  ["sync", "token"],
];

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Joins segments as camelCase (first segment lowercase) or snake_case. */
function spell(segments: string[], style: "camel" | "snake"): string {
  if (style === "snake") return segments.join("_");
  return segments.map((s, i) => (i === 0 ? s : capitalize(s))).join("");
}

const arbStyle = fc.constantFrom("camel", "snake") as fc.Arbitrary<
  "camel" | "snake"
>;

/**
 * A lowercase alphanumeric segment that is neither a stop segment, a stem
 * segment, nor a segment of a stop word (so a `next` prefix cannot turn the
 * `token` stem into `nextToken`).
 */
const arbPlainSegment = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/).filter(
  (s) =>
    !STOP_SEGMENTS.has(s) && !STEMS.flat().includes(s) &&
    !STOP_WORDS.flat().includes(s),
);

/** Zero or one prefix segments, so stems appear both leading and inside identifiers. */
const arbPrefix = fc.option(arbPlainSegment, { nil: undefined }).map((p) =>
  p === undefined ? [] : [p]
);

function fieldLine(identifier: string): string {
  return `  ${identifier}: z.string().optional(),`;
}

function sensitiveFindingCount(content: string): number {
  const src: ReviewSource = {
    path: "/ext/models/m.ts",
    kind: "model",
    content,
    isEntryPoint: false,
    hasSiblingTest: true,
  };
  return evaluateReviewRules([src]).warnings.filter((w) =>
    w.ruleId === "credentials-sensitive-field"
  ).length;
}

Deno.test("credentials-sensitive-field property: a stem followed by a reference suffix never warns", () => {
  fc.assert(
    fc.property(
      arbPrefix,
      fc.constantFrom(...STEMS),
      fc.constantFrom(...STOP_SUFFIXES),
      arbStyle,
      (prefix, stem, suffix, style) => {
        const identifier = spell([...prefix, ...stem, ...suffix], style);
        assertEquals(
          sensitiveFindingCount(fieldLine(identifier)),
          0,
          `${identifier} should not warn`,
        );
      },
    ),
  );
});

Deno.test("credentials-sensitive-field property: pagination and idempotency tokens never warn", () => {
  fc.assert(
    fc.property(fc.constantFrom(...STOP_WORDS), arbStyle, (word, style) => {
      const identifier = spell(word, style);
      assertEquals(
        sensitiveFindingCount(fieldLine(identifier)),
        0,
        `${identifier} should not warn`,
      );
    }),
  );
});

Deno.test("credentials-sensitive-field property: a stem at the end, or followed by any other segment, always warns", () => {
  fc.assert(
    fc.property(
      arbPrefix,
      fc.constantFrom(...STEMS),
      fc.option(arbPlainSegment, { nil: undefined }),
      arbStyle,
      (prefix, stem, suffix, style) => {
        const segments = suffix === undefined
          ? [...prefix, ...stem]
          : [...prefix, ...stem, suffix];
        const identifier = spell(segments, style);
        assertEquals(
          sensitiveFindingCount(fieldLine(identifier)),
          1,
          `${identifier} should warn`,
        );
      },
    ),
  );
});

Deno.test("credentials-sensitive-field property: the sensitive marker suppresses any warning line", () => {
  fc.assert(
    fc.property(
      arbPrefix,
      fc.constantFrom(...STEMS),
      arbStyle,
      (prefix, stem, style) => {
        const identifier = spell([...prefix, ...stem], style);
        const marked = `  ${identifier}: z.string().meta({ sensitive: true }),`;
        assertEquals(
          sensitiveFindingCount(marked),
          0,
          `${marked} should not warn`,
        );
      },
    ),
  );
});

Deno.test("credentials-sensitive-field property: never throws on any input", () => {
  fc.assert(
    fc.property(fc.string(), (content) => {
      sensitiveFindingCount(content);
    }),
  );
});
