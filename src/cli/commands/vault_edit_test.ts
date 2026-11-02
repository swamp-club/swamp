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

import { assert, assertStrictEquals, assertStringIncludes } from "@std/assert";
import { LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS } from "../../domain/vaults/local_encryption_key_source.ts";
import { serveSaveError, vaultEditCommand } from "./vault_edit.ts";
import { ServerResponseError } from "../remote_run.ts";
import { UserError } from "../../domain/errors.ts";
import { VaultSaveOutcomeUnknownError } from "../../libswamp/vaults/edit.ts";

Deno.test("vaultEditCommand: help says --server keeps local_encryption key-source fields and repairs with server defaults (swamp-club#2737)", () => {
  const description = vaultEditCommand.getDescription();
  assertStringIncludes(description, "--server");
  assertStringIncludes(description, "stored values");
  assertStringIncludes(description, "no longer parses");
  for (const field of LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS) {
    assertStringIncludes(description, field);
  }
});

Deno.test("serveSaveError: serve's own refusal stays a refusal, so the secrets move back", () => {
  const refusal = new ServerResponseError({
    code: "vault_edit_failed",
    message: "Cannot change base_dir",
  });
  assertStrictEquals(
    serveSaveError(refusal, "old-vault", "new-vault"),
    refusal,
  );
});

Deno.test("serveSaveError: a lost reply leaves the outcome unknown and names where the secrets are", () => {
  const error = serveSaveError(
    new UserError("Connection closed before a response was received"),
    "old-vault",
    "new-vault",
  );
  assert(error instanceof VaultSaveOutcomeUnknownError);
  assertStringIncludes(error.message, "Connection closed");
  assertStringIncludes(error.message, "secrets for it are under 'new-vault'");
  assertStringIncludes(error.message, "if the vault is still 'old-vault'");
});
