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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { UserError } from "../errors.ts";
import { VaultAccessDeniedError } from "./run_vault_access.ts";
import {
  isSecretNotFoundError,
  SECRET_NOT_FOUND_CODE,
  SecretNotFoundError,
} from "./secret_not_found_error.ts";
import {
  secretReferenceError,
  SecretReferenceUnavailableError,
} from "./secret_reference_errors.ts";

const REFERENCE = { vaultName: "erp", key: "token" };

Deno.test("secretReferenceError: a missing key keeps its code, names the reference and keeps the store error as cause", () => {
  const storeError = Object.assign(
    new Error("item 'token' isn't in vault\nsee docs"),
    { code: SECRET_NOT_FOUND_CODE },
  );
  const error = secretReferenceError("Failed to load", storeError, REFERENCE);
  assertEquals(error instanceof SecretNotFoundError, true);
  const notFound = error as SecretNotFoundError;
  assertEquals(notFound.code, SECRET_NOT_FOUND_CODE);
  assertEquals(notFound.vaultName, "erp");
  assertEquals(notFound.key, "token");
  assertEquals(
    notFound.message,
    "Failed to load: item 'token' isn't in vault — see docs",
  );
  assertStrictEquals(notFound.cause, storeError);
});

Deno.test("secretReferenceError: an access refusal keeps vault_access_denied and is not a missing key", () => {
  const denied = new VaultAccessDeniedError({
    vaultName: "erp",
    action: "read",
    reason: "not allowed",
  });
  const error = secretReferenceError("Failed to load", denied, REFERENCE);
  assertEquals(error instanceof UserError, true);
  assertEquals((error as UserError).code, "vault_access_denied");
  assertEquals(isSecretNotFoundError(error), false);
});

Deno.test("secretReferenceError: any other error stays a plain one-line Error without the code", () => {
  const error = secretReferenceError(
    "Failed to load",
    new Error("token expired\nlog in again"),
    REFERENCE,
  );
  assertEquals(error.constructor, Error);
  assertEquals(error.message, "Failed to load: token expired — log in again");
  assertEquals(isSecretNotFoundError(error), false);
});

Deno.test("secretReferenceError: a store failure whose cause is some other secret's absence is not a missing key", () => {
  const error = secretReferenceError(
    "Failed to load",
    new Error("could not authenticate", {
      cause: new SecretNotFoundError("login", "service-token"),
    }),
    REFERENCE,
  );
  assertEquals(error.constructor, Error);
  assertEquals(isSecretNotFoundError(error), false);
});

Deno.test("SecretReferenceUnavailableError: passes through unchanged and is not relabelled", () => {
  const error = new SecretReferenceUnavailableError(REFERENCE, "call", "loc");
  assertEquals(error.code, "secret_reference_unavailable");
  assertStrictEquals(secretReferenceError("ctx", error, REFERENCE), error);
});
