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
import { detectSecretDocs, type SecretDocsForm } from "./detector.ts";

const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const form = fc.constantFrom<SecretDocsForm>("markdown", "plain", "source");

Deno.test("detectSecretDocs: a vault expression for a secret argument is never flagged", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("apiToken", "password", "secret_key", "accessKey"),
      name,
      name,
      fc.constantFrom("'", '"', ""),
      (arg, vault, key, quote) => {
        const line =
          `--global-arg ${quote}${arg}=\${{ vault.get(${vault}, ${key}) }}${quote}`;
        assertEquals(
          detectSecretDocs(["```", line, "```"].join("\n"), "markdown"),
          [],
        );
      },
    ),
  );
});

Deno.test("detectSecretDocs: a finding names the line it was found on", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("", "Some prose.", "    indented", "- item"), {
        maxLength: 30,
      }),
      fc.array(fc.constantFrom("", "echo hi", "ls -la"), { maxLength: 30 }),
      (before, inside) => {
        const lines = [
          ...before,
          "```bash",
          ...inside,
          "swamp vault set my-vault key",
          "```",
        ];
        const findings = detectSecretDocs(lines.join("\n"), "markdown");
        assertEquals(findings.map((f) => f.line), [lines.length - 1]);
      },
    ),
  );
});

Deno.test("detectSecretDocs: any text yields findings on lines that exist, in order", () => {
  const piece = fc.constantFrom(
    "--global-arg ",
    "token=",
    "${{",
    "vault://",
    "swamp vault put ",
    "export API_KEY=",
    "Bearer ",
    "a:",
    "://",
    "@",
    "\\",
    "\n",
    "```",
    '"',
    "'",
    " ",
    "x",
    ".describe(",
    "ghp_",
  );
  fc.assert(
    fc.property(
      fc.array(piece, { maxLength: 400 }).map((parts) => parts.join("")),
      form,
      (text, kind) => {
        const lineCount = text.split("\n").length;
        const lines = detectSecretDocs(text, kind).map((f) => f.line);
        for (const line of lines) {
          assert(
            line >= 1 && line <= lineCount,
            `line ${line} of ${lineCount}`,
          );
        }
        assertEquals(lines, [...lines].sort((a, b) => a - b));
      },
    ),
  );
});
