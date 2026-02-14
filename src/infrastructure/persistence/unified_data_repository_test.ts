// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertRejects, assertStringIncludes } from "@std/assert";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const testType = ModelType.create("test/model");

Deno.test("getPath rejects dataName with path traversal", () => {
  const repo = new FileSystemUnifiedDataRepository("/tmp/test-repo");
  try {
    repo.getPath(testType, "valid-model", "../escape", 1);
    throw new Error("Expected path traversal error");
  } catch (e) {
    assertStringIncludes(
      (e as Error).message,
      "Path traversal detected",
    );
  }
});

Deno.test("getPath rejects modelId with path traversal", () => {
  const repo = new FileSystemUnifiedDataRepository("/tmp/test-repo");
  try {
    repo.getPath(testType, "../escape", "valid-data", 1);
    throw new Error("Expected path traversal error");
  } catch (e) {
    assertStringIncludes(
      (e as Error).message,
      "Path traversal detected",
    );
  }
});

Deno.test("getPath accepts valid modelId and dataName", () => {
  const repo = new FileSystemUnifiedDataRepository("/tmp/test-repo");
  const path = repo.getPath(testType, "my-model-id", "my-data-name", 1);
  assertStringIncludes(path, "my-model-id");
  assertStringIncludes(path, "my-data-name");
});

Deno.test("listVersions rejects dataName with path traversal", async () => {
  const repo = new FileSystemUnifiedDataRepository("/tmp/test-repo");
  await assertRejects(
    () => repo.listVersions(testType, "valid-model", "../escape"),
    Error,
    "Path traversal detected",
  );
});
