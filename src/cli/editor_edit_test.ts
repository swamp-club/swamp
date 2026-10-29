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
import { ConfigEditConflictError } from "../domain/datastore_v3/config_edit_conflict.ts";
import { getLogger } from "@logtape/logtape";
import { warnIfCopyKept } from "./editor_edit.ts";
import { markModelWording, messageFor } from "../domain/behavior_wording.ts";

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

  await saveEditedCopy(edit, { retry: "swamp model edit web" }, () => {
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
        { retry: "swamp model edit web --allow-rename" },
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
      saveEditedCopy(
        edit,
        { manual: "Paste it into the editor." },
        () => Promise.reject(new Error("no")),
      ),
    Error,
  );

  assertStringIncludes(
    error.message,
    "kept at /tmp/swamp-edit-x/web.yaml. Paste it into the editor.",
  );
  assertEquals(error.message.includes("retry"), false);
});

Deno.test("saveEditedCopy: after a stale-edit conflict the hint says to load the current version first", async () => {
  const { edit } = editedCopy();

  const error = await assertRejects(
    () =>
      saveEditedCopy(edit, {
        retry: "swamp model edit web --allow-rename",
        reload: "swamp model get web",
      }, () =>
        Promise.reject(
          new ConfigEditConflictError([{
            kind: "model",
            name: "web",
            key: "web.yaml",
          }], undefined),
        )),
    ConfigEditConflictError,
  );

  assertStringIncludes(
    error.message,
    "Load the current version with 'swamp model get web', apply your change to the copy, then retry with: swamp model edit web --allow-rename < /tmp/swamp-edit-x/web.yaml",
  );
});

Deno.test("warnIfCopyKept: warns with the kept copy only when one was kept", () => {
  const warnings: unknown[] = [];
  const logger = {
    ...getLogger(["test"]),
    warn: (...args: unknown[]) => warnings.push(args),
  } as unknown as Parameters<typeof warnIfCopyKept>[2];

  warnIfCopyKept(
    { status: "unchanged", editor: "Fake" },
    { retry: "swamp model edit web" },
    logger,
  );
  assertEquals(warnings, []);

  warnIfCopyKept(
    { status: "unchanged", editor: "Fake", keptPath: "/tmp/x/web.yaml" },
    { retry: "swamp model edit web" },
    logger,
  );
  assertEquals(warnings.length, 1);
  assertStringIncludes(
    JSON.stringify(warnings[0]),
    "swamp model edit web < /tmp/x/web.yaml",
  );
});

Deno.test("warnIfCopyKept: without a piped retry, says what to do with the kept copy", () => {
  const warnings: unknown[] = [];
  const logger = {
    ...getLogger(["test"]),
    warn: (...args: unknown[]) => warnings.push(args),
  } as unknown as Parameters<typeof warnIfCopyKept>[2];

  warnIfCopyKept(
    { status: "unchanged", editor: "Fake", keptPath: "/tmp/x/wf.yaml" },
    { manual: "paste the kept copy into the editor." },
    logger,
  );

  const text = JSON.stringify(warnings[0]);
  assertStringIncludes(text, "with the copy at /tmp/x/wf.yaml");
  assertStringIncludes(text, "paste the kept copy");
  assertEquals(text.includes(" < "), false);
});

Deno.test("saveEditedCopy: the kept copy is named in the model spelling too, which swamp model edit prints", async () => {
  const { edit } = editedCopy();

  const error = await assertRejects(
    () =>
      saveEditedCopy(
        edit,
        { retry: "swamp model edit web --allow-rename" },
        () =>
          Promise.reject(
            markModelWording(
              new UserError("Invalid behavior YAML from the editor: bad"),
              "Invalid model YAML from the editor: bad",
            ),
          ),
      ),
    UserError,
  );

  for (const surface of ["model", "behavior"] as const) {
    const text = messageFor(error, surface);
    assertStringIncludes(text, `Invalid ${surface} YAML from the editor`);
    assertStringIncludes(
      text,
      "Your edit is kept at /tmp/swamp-edit-x/web.yaml.",
    );
    assertStringIncludes(
      text,
      "retry with: swamp model edit web --allow-rename",
    );
  }
});
