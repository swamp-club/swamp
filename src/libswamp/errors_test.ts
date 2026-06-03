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
import {
  alreadyExists,
  cancelled,
  invalidApiKey,
  notAuthenticated,
  notFound,
  validationFailed,
} from "./errors.ts";

Deno.test("notAuthenticated returns correct error", () => {
  const err = notAuthenticated();
  assertEquals(err.code, "not_authenticated");
  assertEquals(
    err.message,
    "Not authenticated. Run 'swamp auth login' to sign in.",
  );
});

Deno.test("invalidApiKey returns correct error", () => {
  const err = invalidApiKey();
  assertEquals(err.code, "invalid_api_key");
});

Deno.test("cancelled returns correct error", () => {
  const cause = new Error("abort");
  const err = cancelled(cause);
  assertEquals(err.code, "cancelled");
  assertEquals(err.cause, cause);
});

Deno.test("notFound returns correct error with details", () => {
  const err = notFound("Model", "my-model");
  assertEquals(err.code, "not_found");
  assertEquals(err.message, "Model not found: my-model");
  assertEquals(err.details, { entityType: "Model", idOrName: "my-model" });
});

Deno.test("alreadyExists returns correct error with details", () => {
  const err = alreadyExists("Vault", "my-vault");
  assertEquals(err.code, "already_exists");
  assertEquals(err.message, "Vault already exists: my-vault");
  assertEquals(err.details, { entityType: "Vault", name: "my-vault" });
});

Deno.test("validationFailed returns correct error", () => {
  const err = validationFailed("Bad input", { field: "name" });
  assertEquals(err.code, "validation_failed");
  assertEquals(err.message, "Bad input");
  assertEquals(err.details, { field: "name" });
});

Deno.test("validationFailed works without details", () => {
  const err = validationFailed("Missing argument");
  assertEquals(err.code, "validation_failed");
  assertEquals(err.details, undefined);
});
