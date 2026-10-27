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
import { parseInboxMessage, sanitizeInboxBody } from "./inbox_schemas.ts";

// deno-lint-ignore no-control-regex
const ANY_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;
// deno-lint-ignore no-control-regex
const BODY_FORBIDDEN_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

/** Text dense in escapes and control characters. */
const arbHostileText = fc.array(
  fc.oneof(
    fc.string(),
    fc.constantFrom(
      "\x1b",
      "\x1b[31m",
      "\x1b]8;;https://x\x07",
      "\x1b\\",
      "\r",
      "\n",
      "\t",
      "\x07",
      "\x9b",
    ),
    fc.integer({ min: 0, max: 0x9f }).map((c) => String.fromCharCode(c)),
  ),
).map((parts) => parts.join(""));

Deno.test("sanitizeInboxBody: output holds no control character but newline and tab", () => {
  fc.assert(
    fc.property(arbHostileText, (text) => {
      assert(!BODY_FORBIDDEN_RE.test(sanitizeInboxBody(text)));
    }),
  );
});

Deno.test("parseInboxMessage: one-line fields never hold a control character", () => {
  fc.assert(
    fc.property(
      arbHostileText,
      arbHostileText,
      arbHostileText,
      arbHostileText,
      (kind, title, label, command) => {
        const parsed = parseInboxMessage({
          id: "01JBX5Q8ZK00000000000000Z8",
          kind,
          title,
          body: "",
          createdAt: "2026-10-26T09:00:00.000Z",
          action: { label, command: `swamp ${command}` },
          readAt: null,
        });
        if (!parsed) return;
        assert(!ANY_CONTROL_RE.test(parsed.kind));
        assert(!ANY_CONTROL_RE.test(parsed.title));
        if (parsed.action) {
          assert(!ANY_CONTROL_RE.test(parsed.action.label));
          assert(!ANY_CONTROL_RE.test(parsed.action.command));
          assert(
            /^swamp( [A-Za-z0-9@%+,./:=_-]+)+$/.test(parsed.action.command),
          );
        }
      },
    ),
  );
});

/** Words mixing plain characters with shell syntax. */
const arbShellishCommand = fc.array(
  fc.oneof(
    fc.stringMatching(/^[a-z0-9-]{1,8}$/),
    fc.constantFrom(
      ";",
      "|",
      "&&",
      "&",
      "$(",
      ")",
      "`",
      ">",
      "<",
      "'",
      '"',
      "*",
      "~",
      "\\",
    ),
  ),
  { minLength: 1, maxLength: 8 },
).map((parts) => `swamp ${parts.join(" ")}`);

Deno.test("parseInboxMessage: a kept command never holds a shell metacharacter", () => {
  fc.assert(
    fc.property(arbShellishCommand, (command) => {
      const parsed = parseInboxMessage({
        id: "01JBX5Q8ZK00000000000000Z8",
        kind: "announcement",
        title: "t",
        body: "",
        createdAt: "2026-10-26T09:00:00.000Z",
        action: { label: "Run", command },
        readAt: null,
      });
      assert(parsed);
      if (parsed.action) {
        assert(!/[;|&$`<>'"*~\\()]/.test(parsed.action.command), command);
      }
    }),
  );
});

Deno.test("sanitizeInboxBody: is idempotent", () => {
  fc.assert(
    fc.property(arbHostileText, (text) => {
      const once = sanitizeInboxBody(text);
      assertEquals(sanitizeInboxBody(once), once);
    }),
  );
});
