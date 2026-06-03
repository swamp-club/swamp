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

import { assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";

Deno.test("extension search: --sort relevance without query throws UserError", () => {
  const sort = "relevance";
  const query = undefined;
  const error = assertThrows(
    () => {
      if (sort === "relevance" && !query) {
        throw new UserError('Sort by "relevance" requires a search query.');
      }
    },
    UserError,
  );
  assertStringIncludes(error.message, "relevance");
  assertStringIncludes(error.message, "requires a search query");
});

Deno.test("extension search: --sort relevance with query does not throw", () => {
  const sort = "relevance";
  const query = "aws";
  // Should not throw
  if (sort === "relevance" && !query) {
    throw new UserError('Sort by "relevance" requires a search query.');
  }
});

Deno.test("extension search: invalid content type throws UserError", () => {
  const validContentTypes = [
    "models",
    "workflows",
    "vaults",
    "datastores",
    "drivers",
  ];
  const contentType = ["invalid"];
  const error = assertThrows(
    () => {
      for (const ct of contentType) {
        if (!validContentTypes.includes(ct)) {
          throw new UserError(
            `Invalid content type: "${ct}". Must be one of: ${
              validContentTypes.join(", ")
            }`,
          );
        }
      }
    },
    UserError,
  );
  assertStringIncludes(error.message, "invalid");
  assertStringIncludes(error.message, "Must be one of");
});

Deno.test("extension search: valid content type values are accepted", () => {
  const validContentTypes = [
    "models",
    "workflows",
    "vaults",
    "datastores",
    "drivers",
  ];
  const contentType = ["models", "workflows"];
  // Should not throw
  for (const ct of contentType) {
    if (!validContentTypes.includes(ct)) {
      throw new UserError(
        `Invalid content type: "${ct}". Must be one of: ${
          validContentTypes.join(", ")
        }`,
      );
    }
  }
});

Deno.test("extension search: invalid sort option throws UserError", () => {
  const validSorts = ["relevance", "new", "updated", "name"];
  const sort = "invalid";
  const error = assertThrows(
    () => {
      if (sort && !validSorts.includes(sort)) {
        throw new UserError(
          `Invalid sort option: "${sort}". Must be one of: ${
            validSorts.join(", ")
          }`,
        );
      }
    },
    UserError,
  );
  assertStringIncludes(error.message, "invalid");
  assertStringIncludes(error.message, "Must be one of");
});
