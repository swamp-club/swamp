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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { saveEditedCopy } from "./editor_edit.ts";
import { UserError } from "../domain/errors.ts";

function editedCopy() {
  const calls: string[] = [];
  return {
    calls,
    edit: {
      status: "edited" as const,
      editor: "Fake",
      content: "a: 2\n",
      tempPath: "/tmp/swamp-edit-x/web.yaml",
      discard: () => {
        calls.push("discard");
        return Promise.resolve();
      },
    },
  };
}

Deno.test("saveEditedCopy: a saved edit discards the copy", async () => {
  const { calls, edit } = editedCopy();

  await saveEditedCopy(edit, "swamp model edit web", () => {
    calls.push("save");
    return Promise.resolve();
  });

  assertEquals(calls, ["save", "discard"]);
});

Deno.test("saveEditedCopy: a refused save keeps the copy and names it with the retry command", async () => {
  const { calls, edit } = editedCopy();

  const error = await assertRejects(
    () =>
      saveEditedCopy(
        edit,
        "swamp model edit web --allow-rename",
        () =>
          Promise.reject(new UserError("Invalid YAML", "validation_failed")),
      ),
    UserError,
  );

  assertEquals(calls, []);
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "Invalid YAML");
  assertStringIncludes(
    error.message,
    "Your edit is kept at /tmp/swamp-edit-x/web.yaml.",
  );
  assertStringIncludes(
    error.message,
    "retry with: swamp model edit web --allow-rename < /tmp/swamp-edit-x/web.yaml",
  );
});

Deno.test("saveEditedCopy: without a retry command the kept copy is still named", async () => {
  const { edit } = editedCopy();

  const error = await assertRejects(
    () =>
      saveEditedCopy(edit, undefined, () => Promise.reject(new Error("no"))),
    Error,
  );

  assertStringIncludes(error.message, "kept at /tmp/swamp-edit-x/web.yaml.");
  assertEquals(error.message.includes("retry"), false);
});
