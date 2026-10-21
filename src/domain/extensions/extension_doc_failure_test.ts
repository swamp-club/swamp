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
import {
  describeDocFailure,
  describeUnpublishedSpecifiers,
  DOC_FAILURE_FALLBACK,
  MAX_DOC_FAILURE_CHARS,
} from "./extension_doc_failure.ts";

const ROOT = "/tmp/scorecard_abc123/extract/extension";
const ESC = "\x1b";

function yellow(word: string): string {
  return `${ESC}[0m${ESC}[1m${ESC}[33m${word}${ESC}[0m`;
}

Deno.test("describeDocFailure: bare zod import gets the CLI's remedy", () => {
  const output = [
    `${yellow("Warning")} Import "zod" not a dependency`,
    "  hint: If you want to use the npm package, try running `deno add npm:zod`",
    `    at file://${ROOT}/models/launchd_daemon.ts:2:19`,
    `${ESC}[1m${ESC}[31merror${ESC}[0m: Failed resolving 'zod' from 'file://${ROOT}/models/launchd_daemon.ts'.`,
  ].join("\n");

  assertEquals(
    describeDocFailure(output, [ROOT]),
    'The registry cannot resolve the bare import "zod"; use an explicit npm: or jsr: specifier (npm:zod@4 for zod).',
  );
});

Deno.test("describeDocFailure: several bare imports are listed once each", () => {
  const output = [
    'Warning Import "zod" not a dependency',
    `    at file://${ROOT}/models/a/driver.ts:20:19`,
    'Warning Import "@opentelemetry/api" not a dependency',
    `    at file://${ROOT}/models/a/shared.ts:19:36`,
    'Warning Import "zod" not a dependency',
    `    at file://${ROOT}/models/a/shared.ts:18:19`,
    'Warning Import "@std/yaml" not a dependency',
    'Warning Import "@linear/sdk" not a dependency',
  ].join("\n");

  const reason = describeDocFailure(output, [ROOT]);
  assertStringIncludes(
    reason,
    'bare imports "zod", "@opentelemetry/api", "@std/yaml" and 1 more',
  );
  assertStringIncludes(reason, "(npm:zod@4 for zod)");
});

Deno.test("describeDocFailure: the zod hint is omitted when zod is not among them", () => {
  const reason = describeDocFailure(
    'Warning Import "@std/yaml" not a dependency',
    [ROOT],
  );
  assertEquals(reason.includes("zod"), false);
});

Deno.test("describeDocFailure: a missing module names it and its importer, root-relative", () => {
  const output = [
    `Warning Module not found "file://${ROOT}/models/_lib/acme.ts".`,
    `    at file://${ROOT}/models/letsencrypt_certificate.ts:9:8`,
    `error: Failed resolving './_lib/acme.ts' from 'file://${ROOT}/models/letsencrypt_certificate.ts'.`,
  ].join("\n");

  const reason = describeDocFailure(output, [ROOT]);
  assertEquals(
    reason,
    "Not in the published archive: models/_lib/acme.ts (imported from models/letsencrypt_certificate.ts).",
  );
  assertEquals(reason.includes("/tmp"), false);
});

Deno.test("describeDocFailure: a module outside the root is redacted, not printed", () => {
  const output = [
    `Warning Module not found "file:///home/runner/secret/_lib/op.ts".`,
    `    at file://${ROOT}/models/item.ts:13:41`,
  ].join("\n");

  const reason = describeDocFailure(output, [ROOT]);
  assertEquals(reason.includes("/home"), false);
  assertEquals(reason.includes("secret"), false);
  assertStringIncludes(reason, "<redacted>");
  assertStringIncludes(reason, "models/item.ts");
});

Deno.test("describeDocFailure: any of several roots relativises (realpath vs resolved)", () => {
  const output = `Warning Module not found "file:///private${ROOT}/lib/x.ts".`;
  assertEquals(
    describeDocFailure(output, [ROOT, `/private${ROOT}`]),
    "Not in the published archive: lib/x.ts.",
  );
});

Deno.test("describeDocFailure: an import from a host outside the allow-list names the host", () => {
  const output = [
    'Warning Requires import access to "example.com:443", run again with the --allow-import flag',
    `    at file://${ROOT}/models/m.ts:1:19`,
  ].join("\n");

  assertEquals(
    describeDocFailure(output, [ROOT]),
    "The scorer may not fetch imports from example.com:443.",
  );
});

Deno.test("describeDocFailure: unrecognised output falls back to a fixed sentence", () => {
  assertEquals(
    describeDocFailure(
      `error: The module's source code could not be parsed at file://${ROOT}/x.ts`,
      [ROOT],
    ),
    DOC_FAILURE_FALLBACK,
  );
  assertEquals(describeDocFailure("", [ROOT]), DOC_FAILURE_FALLBACK);
});

Deno.test("describeDocFailure: the reason is capped and control characters are stripped", () => {
  const long = "x".repeat(200);
  const output = [
    `Warning Import "${long}\x07a" not a dependency`,
    `Warning Module not found "file://${ROOT}/${long}.ts".`,
    `Warning Requires import access to "${long}.example:443"`,
  ].join("\n");

  const reason = describeDocFailure(output, [ROOT]);
  assert(reason.length <= MAX_DOC_FAILURE_CHARS, `length ${reason.length}`);
  assertEquals(reason.includes("\x07"), false);
  assert(reason.endsWith("…"));
});

Deno.test("describeUnpublishedSpecifiers: names the specifiers npm publishes no version for", () => {
  assertEquals(
    describeUnpublishedSpecifiers(["npm:ms@99.0.0"]),
    "npm publishes no version matching npm:ms@99.0.0, so deno doc could not resolve the extension's npm imports.",
  );
  assertEquals(
    describeUnpublishedSpecifiers([
      "npm:a@9",
      "npm:b@9",
      "npm:c@9",
      'npm:"d@9',
    ]),
    "npm publishes no version matching npm:a@9, npm:b@9, npm:c@9 and 1 more, so deno doc could not resolve the extension's npm imports.",
  );
});
