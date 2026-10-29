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

import { assertEquals, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import { editInEditor, type EditorSessionDeps } from "./editor_session.ts";

/** An editor that rewrites the file it is given with `edit`. */
function fakeEditor(
  edit: (text: string) => string,
  seen: { path?: string; mode?: number | null } = {},
): EditorSessionDeps {
  return {
    prepareEditor: (path) =>
      Promise.resolve({
        editor: "Fake",
        waitsForExit: true,
        open: async () => {
          seen.path = path;
          seen.mode = (await Deno.stat(path)).mode;
          await Deno.writeTextFile(path, edit(await Deno.readTextFile(path)));
          return { editor: "Fake", path };
        },
      }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("editInEditor: an edited copy is returned and kept until discarded", async () => {
  const seen: { path?: string; mode?: number | null } = {};
  const result = await editInEditor(
    fakeEditor((text) => text.replace("a: 1", "a: 2"), seen),
    { content: "a: 1\n", fileName: "my model" },
  );

  if (result.status !== "edited") throw new Error("expected an edit");
  assertEquals(result.content, "a: 2\n");
  assertEquals(result.editor, "Fake");
  assertEquals(result.tempPath, seen.path);
  assertEquals(result.tempPath.endsWith("my-model.yaml"), true);
  if (Deno.build.os !== "windows") {
    assertEquals(seen.mode! & 0o777, 0o600);
    assertEquals(
      (await Deno.stat(dirname(result.tempPath))).mode! & 0o777,
      0o700,
    );
  }
  assertEquals(await Deno.readTextFile(result.tempPath), "a: 2\n");

  await result.discard();
  assertEquals(await exists(dirname(result.tempPath)), false);
});

Deno.test("editInEditor: an unchanged copy is removed and reported unchanged", async () => {
  const seen: { path?: string } = {};
  const result = await editInEditor(fakeEditor((text) => text, seen), {
    content: "a: 1\n",
    fileName: "web",
  });

  assertEquals(result, { status: "unchanged", editor: "Fake" });
  assertEquals(await exists(dirname(seen.path!)), false);
});

Deno.test("editInEditor: announces the launch on the copy, never the stored file", async () => {
  const launched: string[] = [];
  const result = await editInEditor(fakeEditor((text) => text + "b: 2\n"), {
    content: "a: 1\n",
    fileName: "web",
    onLaunching: (data) => launched.push(data.path),
  });

  if (result.status !== "edited") throw new Error("expected an edit");
  assertEquals(launched, [result.tempPath]);
  await result.discard();
});

Deno.test("editInEditor: an editor that cannot be launched leaves no temp dir", async () => {
  let dir: string | undefined;
  await assertRejects(
    () =>
      editInEditor({
        prepareEditor: (path) => {
          dir = dirname(path);
          return Promise.reject(new Error("editor_cannot_wait"));
        },
      }, { content: "a: 1\n", fileName: "web" }),
    Error,
    "editor_cannot_wait",
  );
  assertEquals(await exists(dir!), false);
});
