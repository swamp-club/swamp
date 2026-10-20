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

Deno.test("redactIssueContent: code paths ending in an identifier-like TLD survive in code spans", () => {
  fc.assert(
    fc.property(
      fc.array(arbWord, { minLength: 2, maxLength: 5 }),
      fc.constantFrom("name", "info", "run", "page", "site", "jobs"),
      (words, last) => {
        const input = `field \`${[...words, last].join(".")}\` is read`;
        const result = redactIssueContent(input);
        assertEquals(result.text, input);
        assertEquals(result.summary.totalRedactions, 0);
      },
    ),
  );
});

Deno.test("redactIssueContent: real hosts never survive in code spans", () => {
  fc.assert(
    fc.property(
      fc.array(arbWord, { minLength: 2, maxLength: 4 }),
      fc.constantFrom("com", "net", "org", "io", "it", "in", "no", "me", "id"),
      (labels, tld) => {
        const host = [...labels, tld].join(".");
        const result = redactIssueContent(`connect to \`${host}\``);
        assert(!result.text.includes(host), `host survived: ${result.text}`);
      },
    ),
  );
});

Deno.test("redactIssueContent: hosts in URL or port context never survive in code", () => {
  fc.assert(
    fc.property(
      fc.array(arbWord, { minLength: 2, maxLength: 4 }),
      fc.constantFrom("name", "info", "run", "page", "site", "jobs"),
      fc.constantFrom(
        (h: string) => `\`https://${h}/v1\``,
        (h: string) => `\`user@${h}\``,
        (h: string) => "```\nconnect " + h + ":5432\n```",
      ),
      (labels, tld, wrap) => {
        const host = [...labels, tld].join(".");
        const result = redactIssueContent(wrap(host));
        assert(!result.text.includes(host), `host survived: ${result.text}`);
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

// --- Git object ids and colon-separated runs (swamp-club#3686) ---

const HEX_CHARS = "0123456789abcdef".split("");

const arbHex = (minLength: number, maxLength: number) =>
  fc.stringOf(fc.constantFrom(...HEX_CHARS), { minLength, maxLength });

const arbGitId = fc.oneof(arbHex(40, 40), arbHex(64, 64));

const arbGitContext = fc.constantFrom(
  "at commit ",
  "commit id: ",
  "git checkout ",
  "rev=",
  "git show ",
  "https://github.com/o/r/commit/",
  "commit `",
);

const arbHexGroup = arbHex(1, 4);

// Eight groups, never the loopback or link-local addresses the redactor keeps
// on purpose, and never all zeros (which compresses to a bare "::").
const arbIpv6Groups = fc.array(arbHexGroup, { minLength: 8, maxLength: 8 })
  .filter((groups) =>
    groups.some((g) => parseInt(g, 16) !== 0) &&
    !groups.slice(0, 7).every((g) => parseInt(g, 16) === 0) &&
    groups[0].toLowerCase() !== "fe80"
  );

// The eight-group form, or a compressed form made by zeroing a run of groups
// and collapsing it to "::" (a run of all eight leaves a bare "::", which
// names no address).
const arbIpv6 = fc.oneof(
  arbIpv6Groups.map((groups) => groups.join(":")),
  fc.tuple(arbIpv6Groups, fc.nat(7), fc.nat(7)).map(([groups, a, b]) => {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const left = groups.slice(0, start);
    const right = groups.slice(end + 1);
    return `${left.join(":")}::${right.join(":")}`;
  }).filter((s) =>
    s !== "::" && s !== "::1" && !s.toLowerCase().startsWith("fe80:")
  ),
);

// What text puts around an address or a colon run: spaces, a label colon
// before it, a message colon after it, brackets and punctuation.
const arbBefore = fc.constantFrom(
  "addr ",
  "remote_addr:",
  "ipv6:",
  "ip=",
  "[",
  "(",
);
const arbAfter = fc.constantFrom(" end", ": no route", ":", ",", "]", ")", "");

Deno.test("redactIssueContent: a git object id after a git word survives", () => {
  fc.assert(
    fc.property(arbGitContext, arbGitId, (context, id) => {
      const input = `${context}${id} landed`;
      const result = redactIssueContent(input);
      assertEquals(result.text, input);
    }),
  );
});

Deno.test("redactIssueContent: long hex without git context never survives", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("", "token: ", "key=", "secret ", "commit token: "),
      arbHex(40, 128),
      (context, hex) => {
        const result = redactIssueContent(`saw ${context}${hex} here`);
        assert(!result.text.includes(hex), `hex survived in: ${result.text}`);
      },
    ),
  );
});

Deno.test("redactIssueContent: a colon run that is not an address survives", () => {
  fc.assert(
    fc.property(
      fc.array(arbHexGroup, { minLength: 3, maxLength: 7 }).filter((groups) =>
        !groups.join(":").match(/(?:^|:)(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?::|$)/)
      ),
      arbBefore,
      arbAfter,
      (groups, before, after) => {
        const input = `path ${before}${groups.join(":")}${after}`;
        const result = redactIssueContent(input);
        assertEquals(result.text, input);
      },
    ),
  );
});

Deno.test("redactIssueContent: an IPv6 address never survives in any form", () => {
  fc.assert(
    fc.property(arbBefore, arbIpv6, arbAfter, (before, address, after) => {
      const result = redactIssueContent(`${before}${address}${after}`);
      assertEquals(result.text, `${before}[IP-1]${after}`, address);
    }),
  );
});

Deno.test("redactIssueContent: redaction stays idempotent over git ids and addresses", () => {
  fc.assert(
    fc.property(arbGitContext, arbGitId, arbIpv6, (context, id, address) => {
      const once = redactIssueContent(
        `${context}${id} then ${address} and path 992:3:11:17:17:12`,
      );
      const twice = redactIssueContent(once.text);
      assertEquals(twice.text, once.text);
      assertEquals(twice.summary.totalRedactions, 0);
    }),
  );
});
