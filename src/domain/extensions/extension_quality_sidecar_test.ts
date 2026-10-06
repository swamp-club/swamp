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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  generatedReason,
  MAX_SIDECAR_BYTES,
  MAX_SIDECAR_ENTRIES,
  parseQualitySidecar,
  QUALITY_SIDECAR_FILENAME,
  type QualitySidecar,
  qualitySidecarPath,
  sidecarDirectives,
} from "./extension_quality_sidecar.ts";

const DIR = resolve("/ext");
const SIDECAR = join(DIR, QUALITY_SIDECAR_FILENAME);

function errorsOf(raw: string): string[] {
  const result = parseQualitySidecar(raw);
  assert(!result.ok, "expected a parse failure");
  return result.errors;
}

Deno.test("parseQualitySidecar: a full sidecar parses to the value object", () => {
  const result = parseQualitySidecar(`
version: 1
generated:
  by: swamp-extensions/codegen
  source: https://api.example.com/openapi.yaml
  commit: 0123abcd
accept:
  - rule: bare-specifiers
    reason: scored locally
  - rule: ipv4-address-literals
    file: docs/hosts.txt
    reason: documented lab addresses
`);
  assert(result.ok);
  assertEquals(result.sidecar, {
    version: 1,
    generated: {
      by: "swamp-extensions/codegen",
      source: "https://api.example.com/openapi.yaml",
      commit: "0123abcd",
    },
    accept: [
      { rule: "bare-specifiers", reason: "scored locally" },
      {
        rule: "ipv4-address-literals",
        file: "docs/hosts.txt",
        reason: "documented lab addresses",
      },
    ],
  });
});

Deno.test("parseQualitySidecar: version alone is a valid, empty sidecar", () => {
  const result = parseQualitySidecar("version: 1\n");
  assert(result.ok);
  assertEquals(result.sidecar, { version: 1, accept: [] });
});

Deno.test("parseQualitySidecar: unknown keys, a missing version and a wrong version are refused", () => {
  assertStringIncludes(
    errorsOf("version: 1\nignore: [x]\n").join("\n"),
    "ignore",
  );
  assertStringIncludes(errorsOf("accept: []\n").join("\n"), "version");
  assertStringIncludes(errorsOf("version: 2\n").join("\n"), "version");
});

Deno.test("parseQualitySidecar: an entry without a reason, a traversal path and an absolute path are refused", () => {
  assertStringIncludes(
    errorsOf("version: 1\naccept:\n  - rule: bare-specifiers\n").join("\n"),
    "reason",
  );
  assertStringIncludes(
    errorsOf(
      "version: 1\naccept:\n  - rule: ipv4-address-literals\n    file: ../hosts.txt\n    reason: r\n",
    ).join("\n"),
    "relative",
  );
  assertStringIncludes(
    errorsOf(
      "version: 1\naccept:\n  - rule: ipv4-address-literals\n    file: /etc/hosts.txt\n    reason: r\n",
    ).join("\n"),
    "relative",
  );
});

Deno.test("parseQualitySidecar: too many entries, an oversize file and invalid YAML are refused", () => {
  const entries = Array.from(
    { length: MAX_SIDECAR_ENTRIES + 1 },
    () => "  - rule: bare-specifiers\n    reason: r\n",
  ).join("");
  assertStringIncludes(
    errorsOf(`version: 1\naccept:\n${entries}`).join("\n"),
    "accept",
  );
  assertStringIncludes(
    errorsOf("version: 1\n" + "#".repeat(MAX_SIDECAR_BYTES)).join("\n"),
    "larger than",
  );
  assertStringIncludes(errorsOf("version: [\n").join("\n"), "not valid YAML");
});

Deno.test("qualitySidecarPath: quality.yaml beside the manifest", () => {
  assertPathEquals(qualitySidecarPath(DIR), join(DIR, "quality.yaml"));
});

function sidecar(overrides: Partial<QualitySidecar>): QualitySidecar {
  return { version: 1, accept: [], ...overrides };
}

Deno.test("sidecarDirectives: an extension-scoped entry becomes an extension directive declared at its index", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({
      accept: [{ rule: "bare-specifiers", reason: "scored locally" }],
    }),
    SIDECAR,
    DIR,
  );
  assertEquals(invalid, []);
  assertEquals(directives, [{
    ruleId: "bare-specifiers",
    reason: "scored locally",
    target: { kind: "extension" },
    source: "sidecar",
    declaredAt: { file: SIDECAR, line: 1 },
  }]);
});

Deno.test("sidecarDirectives: a generated declaration accepts testing-completeness for the package", () => {
  const generated = { by: "codegen", source: "spec.yaml", commit: "abc" };
  const { directives } = sidecarDirectives(
    sidecar({ generated }),
    SIDECAR,
    DIR,
  );
  assertEquals(directives, [{
    ruleId: "testing-completeness",
    reason: generatedReason(generated),
    target: { kind: "extension" },
    source: "generated",
    declaredAt: { file: SIDECAR, line: 0 },
  }]);
  assertStringIncludes(directives[0].reason, "codegen");
});

Deno.test("sidecarDirectives: a .txt file entry for a site-scoped rule becomes a file directive inside the manifest dir", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({
      accept: [{
        rule: "ipv4-address-literals",
        file: "docs/hosts.txt",
        reason: "lab",
      }],
    }),
    SIDECAR,
    DIR,
  );
  assertEquals(invalid, []);
  assertEquals(directives[0].target.kind, "file");
  if (directives[0].target.kind === "file") {
    assertPathEquals(directives[0].target.file, join(DIR, "docs", "hosts.txt"));
  }
});

Deno.test("sidecarDirectives: a site-scoped rule without a file is refused", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({ accept: [{ rule: "credentials-sensitive-field", reason: "r" }] }),
    SIDECAR,
    DIR,
  );
  assertEquals(directives, []);
  assertStringIncludes(invalid[0].problem, "site-scoped");
  assertEquals(invalid[0].file, SIDECAR);
  assertEquals(invalid[0].line, 1);
});

Deno.test("sidecarDirectives: a site-scoped rule naming a file with a comment form is refused", () => {
  for (const file of ["models/thing.ts", "README.md"]) {
    const { directives, invalid } = sidecarDirectives(
      sidecar({
        accept: [{ rule: "ipv4-address-literals", file, reason: "r" }],
      }),
      SIDECAR,
      DIR,
    );
    assertEquals(directives, [], file);
    assertStringIncludes(invalid[0].problem, "comment on the line");
  }
});

Deno.test("sidecarDirectives: testing-completeness with a file is refused; it belongs in the file or the generated declaration", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({
      accept: [{
        rule: "testing-completeness",
        file: "models/foo.ts",
        reason: "r",
      }],
    }),
    SIDECAR,
    DIR,
  );
  assertEquals(directives, []);
  assertStringIncludes(invalid[0].problem, "file-scoped");
});

Deno.test("sidecarDirectives: testing-completeness without a file is refused in favour of the generated declaration", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({ accept: [{ rule: "testing-completeness", reason: "r" }] }),
    SIDECAR,
    DIR,
  );
  assertEquals(directives, []);
  assertStringIncludes(invalid[0].problem, "generated declaration");
});

Deno.test("sidecarDirectives: an error-level rule, an unknown rule and an extension rule with a file are refused", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({
      accept: [
        { rule: "dynamic-code", reason: "r" },
        { rule: "no-such-rule", reason: "r" },
        { rule: "bare-specifiers", file: "docs/x.txt", reason: "r" },
      ],
    }),
    SIDECAR,
    DIR,
  );
  assertEquals(directives, []);
  assertEquals(invalid.map((i) => i.line), [1, 2, 3]);
  assertStringIncludes(invalid[0].problem, "cannot be accepted");
  assertStringIncludes(invalid[1].problem, "not a rule id");
  assertStringIncludes(invalid[2].problem, "takes no file");
});

Deno.test("sidecarDirectives: a file that resolves outside the manifest directory is refused", () => {
  const { directives, invalid } = sidecarDirectives(
    sidecar({
      accept: [{
        rule: "ipv4-address-literals",
        file: "docs/../../hosts.txt",
        reason: "r",
      }],
    }),
    SIDECAR,
    DIR,
  );
  assertEquals(directives, []);
  assertStringIncludes(invalid[0].problem, "outside");
});
