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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { redactIssueContent } from "./content_redactor.ts";

// Key material: one unbroken run, always carrying a digit so it clears the
// gate for unrecognised labels.
const arbKeyPayload = fc.tuple(
  fc.stringOf(fc.constantFrom(..."ABCDEFghijkl".split("")), {
    minLength: 10,
    maxLength: 30,
  }),
  fc.stringOf(fc.constantFrom(..."0123456789".split("")), {
    minLength: 10,
    maxLength: 20,
  }),
).map(([letters, digits]) => letters + digits);

const arbLabel = fc.stringOf(fc.constantFrom(..."abcdeFGHIJ".split("")), {
  minLength: 2,
  maxLength: 12,
});

const arbJoiner = fc.constantFrom("_", "-");

// Identifier words, deliberately short: the gate separates words from key
// material by run length, so no generated word may reach the run threshold.
const arbWord = fc.stringOf(fc.constantFrom(..."abcdefghij".split("")), {
  minLength: 2,
  maxLength: 12,
});

Deno.test("redactIssueContent: a labelled key never leaves its payload behind", () => {
  fc.assert(
    fc.property(
      arbLabel,
      arbJoiner,
      arbKeyPayload,
      (label, joiner, payload) => {
        const result = redactIssueContent(
          `the key ${label}${joiner}${payload}`,
        );
        assert(
          !result.text.includes(payload),
          `payload survived in: ${result.text}`,
        );
        assert(result.summary.totalRedactions > 0);
      },
    ),
  );
});

Deno.test("redactIssueContent: word-structured identifiers pass through untouched", () => {
  fc.assert(
    fc.property(
      fc.array(arbWord, { minLength: 3, maxLength: 8 }),
      arbJoiner,
      (words, joiner) => {
        const identifier = words.join(joiner);
        const input = `saw ${identifier} in the log`;
        const result = redactIssueContent(input);
        assertEquals(result.text, input);
        assertEquals(result.summary.totalRedactions, 0);
      },
    ),
  );
});

Deno.test("redactIssueContent: redaction is idempotent", () => {
  fc.assert(
    fc.property(
      arbLabel,
      arbJoiner,
      arbKeyPayload,
      (label, joiner, payload) => {
        const once = redactIssueContent(`key ${label}${joiner}${payload}`);
        const twice = redactIssueContent(once.text);
        assertEquals(twice.text, once.text);
        assertEquals(twice.summary.totalRedactions, 0);
      },
    ),
  );
});

Deno.test("redactIssueContent: one raw value always maps to one placeholder", () => {
  fc.assert(
    fc.property(
      arbLabel,
      arbJoiner,
      arbKeyPayload,
      (label, joiner, payload) => {
        const token = `${label}${joiner}${payload}`;
        const result = redactIssueContent(`first ${token} second ${token}`);
        const placeholders = [
          ...result.text.matchAll(/\[REDACTED-SECRET-\d+\]/g),
        ]
          .map((m) => m[0]);
        assertEquals(placeholders.length, 2);
        assertEquals(placeholders[0], placeholders[1]);
      },
    ),
  );
});
