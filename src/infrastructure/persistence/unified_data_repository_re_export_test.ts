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

import { assert, assertStrictEquals } from "@std/assert";
import { OwnershipValidationError as DomainOwnershipValidationError } from "../../domain/data/repositories.ts";
import { OwnershipValidationError as InfraOwnershipValidationError } from "./unified_data_repository.ts";

// locks the value re-export: a type-only re-export or a duplicated class would
// silently break instanceof across the two import paths

Deno.test("OwnershipValidationError class identity is preserved across the re-export", () => {
  assertStrictEquals(
    DomainOwnershipValidationError,
    InfraOwnershipValidationError,
  );
});

Deno.test("OwnershipValidationError instances are caught by instanceof against either import path", () => {
  const owner = { ownerType: "model-method", ownerRef: "x:y" };
  const thrown = new InfraOwnershipValidationError("name", owner, owner);
  assert(thrown instanceof DomainOwnershipValidationError);
  assert(thrown instanceof InfraOwnershipValidationError);
});
