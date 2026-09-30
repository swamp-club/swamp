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
import { redactErrorMessage } from "./error_message_redaction.ts";

const segment = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,11}$/);
const segments = fc.array(segment, { minLength: 1, maxLength: 5 });

const absolutePath = fc.oneof(
  segments.map((s) => `/${s.join("/")}`),
  segments.map((s) => `~/${s.join("/")}`),
  segments.map((s) => `C:\\${s.join("\\")}`),
  segments.map((s) => `D:/${s.join("/")}`),
);

const prefix = fc.constantFrom(
  "Not a swamp repository: ",
  "Cannot read ",
  "Failed: '",
  "at ",
  "",
);

Deno.test("redactErrorMessage (property): no path segment survives", () => {
  fc.assert(
    fc.property(prefix, segments, absolutePath, (p, marker, path) => {
      const canary = `rdx${marker.join("")}`;
      const message = `${p}${path}/${canary}`;
      const redacted = redactErrorMessage(message);
      assert(!redacted.includes(canary), `${message} -> ${redacted}`);
    }),
  );
});

Deno.test("redactErrorMessage (property): type names and model names are preserved", () => {
  const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
  fc.assert(
    fc.property(name, name, name, (collective, a, b) => {
      const message =
        `Model not found: ${a} (type @${collective}/${a}/${b}, command/${b})`;
      assertEquals(redactErrorMessage(message), message);
    }),
  );
});
