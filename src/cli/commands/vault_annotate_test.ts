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

import { assertEquals, assertThrows } from "@std/assert";
import { buildVaultAnnotateInput, parseLabels } from "./vault_annotate.ts";
import { UserError } from "../../domain/errors.ts";
import { validateServerRequest } from "../../serve/connection.ts";

Deno.test("parseLabels: undefined input returns undefined", () => {
  const result = parseLabels(undefined);
  assertEquals(result, undefined);
});

Deno.test("parseLabels: empty array returns undefined", () => {
  const result = parseLabels([]);
  assertEquals(result, undefined);
});

Deno.test("parseLabels: single label parses correctly", () => {
  const result = parseLabels(["env=prod"]);
  assertEquals(result, { env: "prod" });
});

Deno.test("parseLabels: multiple labels parse correctly", () => {
  const result = parseLabels(["env=prod", "team=infra", "region=us-east-1"]);
  assertEquals(result, { env: "prod", team: "infra", region: "us-east-1" });
});

Deno.test("parseLabels: label with multiple = signs keeps value intact", () => {
  const result = parseLabels(["key=val=ue"]);
  assertEquals(result, { key: "val=ue" });
});

Deno.test("parseLabels: empty key throws UserError", () => {
  assertThrows(
    () => parseLabels(["=value"]),
    UserError,
    "key cannot be empty",
  );
});

Deno.test("parseLabels: missing = sign throws UserError", () => {
  assertThrows(
    () => parseLabels(["noequalssign"]),
    UserError,
    "Expected key=value",
  );
});

Deno.test("parseLabels: empty value is allowed", () => {
  const result = parseLabels(["key="]);
  assertEquals(result, { key: "" });
});

Deno.test("buildVaultAnnotateInput: labels become a key-value map the server accepts", () => {
  const input = buildVaultAnnotateInput("my-vault", "API_KEY", {
    label: ["team=infra", "env=prod"],
    notes: "a note",
  });
  assertEquals(input, {
    vaultName: "my-vault",
    key: "API_KEY",
    url: undefined,
    notes: "a note",
    labels: { team: "infra", env: "prod" },
    removeLabels: undefined,
    clear: false,
  });
  // The --server path sends this input as the vault.annotate payload.
  assertEquals(
    typeof validateServerRequest({
      type: "vault.annotate",
      id: "req-1",
      payload: input,
    }),
    "object",
  );
});

Deno.test("buildVaultAnnotateInput: --clear alone is accepted", () => {
  const input = buildVaultAnnotateInput("my-vault", "API_KEY", {
    clear: true,
  });
  assertEquals(input.clear, true);
  assertEquals(input.labels, undefined);
});

Deno.test("buildVaultAnnotateInput: --clear combined with --label throws UserError", () => {
  assertThrows(
    () =>
      buildVaultAnnotateInput("my-vault", "API_KEY", {
        clear: true,
        label: ["team=infra"],
      }),
    UserError,
    "--clear cannot be combined",
  );
});

Deno.test("buildVaultAnnotateInput: --clear combined with --notes throws UserError", () => {
  assertThrows(
    () =>
      buildVaultAnnotateInput("my-vault", "API_KEY", {
        clear: true,
        notes: "a note",
      }),
    UserError,
    "--clear cannot be combined",
  );
});

Deno.test("buildVaultAnnotateInput: no annotation fields throws UserError", () => {
  assertThrows(
    () => buildVaultAnnotateInput("my-vault", "API_KEY", {}),
    UserError,
    "No annotation fields specified",
  );
});
