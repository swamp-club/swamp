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

// The field selection and file rendering are pure so they can be pinned
// without a 1Password account, an unlock prompt or a home directory. These
// tests are the only automated coverage this script has: `scripts/` is
// excluded from `deno fmt` and `deno lint` in deno.json, and `deno run check`
// only type-checks the main.ts graph.

import { assertEquals } from "@std/assert";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  type OpItem,
  renderEnvFile,
  selectSecretValue,
  VERIFY_KEYS,
  verifyEnvPath,
} from "./setup_verify_env.ts";

// -- selectSecretValue ------------------------------------------------------

Deno.test("selectSecretValue: an API Credential item uses its credential field", () => {
  const item: OpItem = {
    title: "TESSL_TOKEN",
    category: "API_CREDENTIAL",
    fields: [
      { id: "username", type: "STRING", value: "someone" },
      { id: "credential", type: "CONCEALED", value: "tsk-abc" },
    ],
  };
  assertEquals(selectSecretValue(item), "tsk-abc");
});

Deno.test("selectSecretValue: a Login item uses its password field", () => {
  const item: OpItem = {
    category: "LOGIN",
    fields: [
      { id: "username", type: "STRING", value: "someone" },
      { id: "password", type: "CONCEALED", value: "sk-ant-xyz" },
    ],
  };
  assertEquals(selectSecretValue(item), "sk-ant-xyz");
});

Deno.test("selectSecretValue: falls back to purpose, then to any concealed field", () => {
  // Items people create by hand often carry the secret in a custom field with
  // a name of their own choosing. Requiring one category would make the setup
  // script itself a second setup task.
  assertEquals(
    selectSecretValue({
      fields: [{ id: "odd", purpose: "PASSWORD", value: "by-purpose" }],
    }),
    "by-purpose",
  );
  assertEquals(
    selectSecretValue({
      fields: [{ id: "token", type: "CONCEALED", value: "by-type" }],
    }),
    "by-type",
  );
});

Deno.test("selectSecretValue: an empty or absent value is not a secret", () => {
  assertEquals(selectSecretValue({ fields: [] }), null);
  assertEquals(selectSecretValue({}), null);
  // An empty string would otherwise be written to the env file and look set,
  // which fails later and further away than reporting it missing here.
  assertEquals(
    selectSecretValue({ fields: [{ id: "credential", value: "" }] }),
    null,
  );
});

Deno.test("selectSecretValue: prefers credential over an unrelated concealed field", () => {
  const item: OpItem = {
    fields: [
      { id: "recovery", type: "CONCEALED", value: "not-this" },
      { id: "credential", type: "CONCEALED", value: "this-one" },
    ],
  };
  assertEquals(selectSecretValue(item), "this-one");
});

// -- renderEnvFile ----------------------------------------------------------

Deno.test("renderEnvFile: writes keys into an empty file", () => {
  const out = renderEnvFile("", new Map([["TESSL_TOKEN", "tsk-abc"]]));
  assertEquals(out, "TESSL_TOKEN='tsk-abc'\n");
});

Deno.test("renderEnvFile: replaces an existing value in place", () => {
  const existing = "TESSL_TOKEN=replace-me-from-1p-value\n";
  const out = renderEnvFile(existing, new Map([["TESSL_TOKEN", "tsk-real"]]));
  assertEquals(out, "TESSL_TOKEN='tsk-real'\n");
});

Deno.test("renderEnvFile: keeps keys and comments it does not manage", () => {
  const existing = [
    "# set up by hand on 2026-01-02",
    "SOMETHING_ELSE=keep-me",
    "TESSL_TOKEN=old",
    "",
  ].join("\n");

  const out = renderEnvFile(existing, new Map([["TESSL_TOKEN", "new"]]));

  // A setup helper that silently dropped a line somebody added would be a
  // worse failure than not running at all.
  assertEquals(out, [
    "# set up by hand on 2026-01-02",
    "SOMETHING_ELSE=keep-me",
    "TESSL_TOKEN='new'",
    "",
  ].join("\n"));
});

Deno.test("renderEnvFile: appends a key the file does not have yet", () => {
  const out = renderEnvFile(
    "TESSL_TOKEN=old\n",
    new Map([["TESSL_TOKEN", "new"], ["ANTHROPIC_API_KEY", "sk-ant"]]),
  );
  assertEquals(out, "TESSL_TOKEN='new'\nANTHROPIC_API_KEY='sk-ant'\n");
});

Deno.test("renderEnvFile: quotes values so the file survives being sourced", () => {
  // The documented format was bare `KEY=value`, which works until a credential
  // contains a space, a `$` or a quote.
  const out = renderEnvFile(
    "",
    new Map([["TESSL_TOKEN", "has space $VAR and 'quote'"]]),
  );
  assertEquals(out, `TESSL_TOKEN='has space $VAR and '\\''quote'\\'''\n`);
});

Deno.test("renderEnvFile: is idempotent", () => {
  const updates = new Map([["TESSL_TOKEN", "tsk-abc"]]);
  const once = renderEnvFile("", updates);
  assertEquals(renderEnvFile(once, updates), once);
});

// -- verifyEnvPath ----------------------------------------------------------

Deno.test("verifyEnvPath: prefers XDG_CONFIG_HOME, falls back to HOME", () => {
  // assertPathEquals rather than assertEquals: `join` yields backslashes on
  // Windows, and `deno run test` does pick up scripts/ test files.
  assertPathEquals(
    verifyEnvPath({ XDG_CONFIG_HOME: "/x/cfg", HOME: "/home/someone" })!,
    "/x/cfg/swamp/verify.env",
  );
  assertPathEquals(
    verifyEnvPath({ HOME: "/home/someone" })!,
    "/home/someone/.config/swamp/verify.env",
  );
  assertEquals(verifyEnvPath({}), null);
});

// -- VERIFY_KEYS ------------------------------------------------------------

Deno.test("VERIFY_KEYS: records which absence is loud and which is quiet", () => {
  const tessl = VERIFY_KEYS.find((k) => k.name === "TESSL_TOKEN");
  const anthropic = VERIFY_KEYS.find((k) => k.name === "ANTHROPIC_API_KEY");

  // The distinction is the reason the table carries a consequence at all: a
  // missing TESSL_TOKEN stops the run, while a missing ANTHROPIC_API_KEY lets
  // the gate go green having checked less than it appears to have checked.
  assertEquals(tessl?.required, true);
  assertEquals(anthropic?.required, false);
  assertEquals(VERIFY_KEYS.every((k) => k.consequence.length > 0), true);
});
