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

import { assertEquals } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  isSecretNotFoundError,
  SECRET_NOT_FOUND_CODE,
  SecretNotFoundError,
} from "./secret_not_found_error.ts";

Deno.test("SecretNotFoundError: carries the code, vault and key with a default message", () => {
  const error = new SecretNotFoundError("prod", "API_KEY");
  assertEquals(error.code, SECRET_NOT_FOUND_CODE);
  assertEquals(error.name, "SecretNotFoundError");
  assertEquals(error.vaultName, "prod");
  assertEquals(error.key, "API_KEY");
  assertEquals(error.message, "Secret 'API_KEY' not found in vault 'prod'");
  assertEquals(error instanceof UserError, true);
  assertEquals(error.cause, undefined);
});

Deno.test("SecretNotFoundError: keeps a message override and a cause", () => {
  const cause = new Error("store text");
  const error = new SecretNotFoundError("prod", "API_KEY", {
    message: "custom",
    cause,
  });
  assertEquals(error.message, "custom");
  assertEquals(error.cause, cause);
});

Deno.test("isSecretNotFoundError: matches the class and any error carrying the code", () => {
  assertEquals(isSecretNotFoundError(new SecretNotFoundError("v", "k")), true);
  const foreign = Object.assign(new Error("from another bundle"), {
    code: SECRET_NOT_FOUND_CODE,
  });
  assertEquals(isSecretNotFoundError(foreign), true);
  assertEquals(isSecretNotFoundError({ code: SECRET_NOT_FOUND_CODE }), true);
});

Deno.test("isSecretNotFoundError: ignores a code buried in the cause chain", () => {
  const otherSecretMissing = new SecretNotFoundError("login", "service-token");
  const wrapped = new Error("could not authenticate", {
    cause: otherSecretMissing,
  });
  assertEquals(isSecretNotFoundError(wrapped), false);
});

Deno.test("isSecretNotFoundError: rejects other errors and non-errors", () => {
  assertEquals(isSecretNotFoundError(new Error("Secret 'k' not found")), false);
  assertEquals(
    isSecretNotFoundError(new UserError("denied", "vault_access_denied")),
    false,
  );
  assertEquals(isSecretNotFoundError(undefined), false);
  assertEquals(isSecretNotFoundError(null), false);
  assertEquals(isSecretNotFoundError(SECRET_NOT_FOUND_CODE), false);
});
