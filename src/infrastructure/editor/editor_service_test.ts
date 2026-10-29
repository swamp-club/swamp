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
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { EditorService } from "./editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";

Deno.test("EditorService.findEditor returns $EDITOR when set", async () => {
  // Set EDITOR to a command that exists
  await withMockedEnv({ EDITOR: "cat" }, async () => {
    const service = new EditorService();
    const editor = await service.findEditor();
    assertEquals(editor, "cat");
  });
});

Deno.test("EditorService.findEditor handles $EDITOR with arguments", async () => {
  // Set EDITOR to a command with arguments
  await withMockedEnv({ EDITOR: "cat -n" }, async () => {
    const service = new EditorService();
    const editor = await service.findEditor();
    assertEquals(editor, "cat -n");
  });
});

Deno.test("EditorService.prepareOpenFile exposes wait state before launching", async () => {
  const service = new class extends EditorService {
    override findEditor(): Promise<string> {
      return Promise.resolve("code --reuse-window");
    }
  }();
  const launch = await service.prepareOpenFile("/tmp/definition.yaml", {
    wait: true,
  });
  assertEquals(launch.editor, "VS Code");
  assertEquals(launch.waitsForExit, true);
});

Deno.test("EditorService.findEditor falls back when $EDITOR is not available", async () => {
  // Set EDITOR to a non-existent command
  await withMockedEnv({ EDITOR: "nonexistent-editor-12345" }, async () => {
    const service = new EditorService();
    // Should fall back to an available editor or throw
    try {
      const editor = await service.findEditor();
      // If we get here, a fallback editor was found
      assertEquals(typeof editor, "string");
    } catch (error) {
      // If no editor is found, error message should list fallbacks
      assertStringIncludes(
        (error as Error).message,
        "No editor found",
      );
    }
  });
});

Deno.test("EditorService.findEditor throws when no editor is available", async () => {
  // Make every PATH lookup fail via a mocked `which`/`where` — mutating the
  // real PATH is process-global and races other parallel test files.
  await withMockedEnv({ EDITOR: undefined }, async () => {
    await withMockedCommand(() => ({ stdout: "", code: 1 }), async () => {
      const service = new EditorService();
      await assertRejects(
        () => service.findEditor(),
        Error,
        "No editor found",
      );
    });
  });
});

Deno.test("EditorService module exports EditorService class", async () => {
  const module = await import("./editor_service.ts");
  assertEquals(typeof module.EditorService, "function");
});

function serviceWithEditor(editor: string): EditorService {
  return new class extends EditorService {
    override findEditor(): Promise<string> {
      return Promise.resolve(editor);
    }
  }();
}

Deno.test("EditorService.prepareOpenFile: requireWait adds each GUI editor's wait flag once", async () => {
  const cases: [string, string[]][] = [
    ["code", ["code", "--wait", "/f.yaml"]],
    ["code --wait", ["code", "--wait", "/f.yaml"]],
    ["code -w", ["code", "-w", "/f.yaml"]],
    ["cursor", ["cursor", "--wait", "/f.yaml"]],
    ["zed", ["zed", "--wait", "/f.yaml"]],
    ["subl", ["subl", "--wait", "/f.yaml"]],
    ["mate", ["mate", "-w", "/f.yaml"]],
    ["gvim", ["gvim", "-f", "/f.yaml"]],
    ["vim", ["vim", "/f.yaml"]],
  ];
  for (const [editor, args] of cases) {
    const launch = await serviceWithEditor(editor).prepareOpenFile("/f.yaml", {
      requireWait: true,
    });
    assertEquals(launch.args, args, editor);
    assertEquals(launch.waitsForExit, true, editor);
  }
});

Deno.test("EditorService.prepareOpenFile: requireWait waits for an unknown editor's process", async () => {
  const launch = await serviceWithEditor("/usr/local/bin/my-editor.sh")
    .prepareOpenFile("/f.yaml", { requireWait: true });
  assertEquals(launch.waitsForExit, true);
  assertEquals(launch.args, ["/usr/local/bin/my-editor.sh", "/f.yaml"]);
});

Deno.test("EditorService.prepareOpenFile: requireWait refuses launchers that return at once", async () => {
  for (const editor of ["open", "open -e", "xdg-open", "gio open", "start"]) {
    const error = await assertRejects(
      () =>
        serviceWithEditor(editor).prepareOpenFile("/f.yaml", {
          requireWait: true,
        }),
      UserError,
    );
    assertEquals(error.code, "editor_cannot_wait", editor);
    assertStringIncludes(error.message, "pipe the YAML on stdin");
  }
  const waiting = await serviceWithEditor("open -W -n").prepareOpenFile(
    "/f.yaml",
    { requireWait: true },
  );
  assertEquals(waiting.waitsForExit, true);
});

Deno.test("EditorService.prepareOpenFile: without requireWait, GUI editors and launchers are unchanged", async () => {
  const gui = await serviceWithEditor("code").prepareOpenFile("/f.yaml");
  assertEquals(gui.waitsForExit, false);
  assertEquals(gui.args, ["code", "/f.yaml"]);
  const launcher = await serviceWithEditor("xdg-open").prepareOpenFile(
    "/f.yaml",
    { wait: true },
  );
  assertEquals(launcher.args, ["xdg-open", "/f.yaml"]);
});

Deno.test("EditorService.prepareOpenFile: editors given by path follow their command's rules", async () => {
  const code = await serviceWithEditor("/usr/local/bin/code").prepareOpenFile(
    "/f.yaml",
    { requireWait: true },
  );
  assertEquals(code.args, ["/usr/local/bin/code", "--wait", "/f.yaml"]);
  await assertRejects(
    () =>
      serviceWithEditor("/usr/bin/xdg-open").prepareOpenFile("/f.yaml", {
        requireWait: true,
      }),
    UserError,
  );
});

Deno.test("EditorService.prepareOpenFile: the wait is confirmed only for editors known to stay open", async () => {
  const cases: [string, boolean][] = [
    ["vim", true],
    ["/usr/bin/nvim", true],
    ["code", true],
    ["code --wait", true],
    ["open -W -n", true],
    ["/usr/local/bin/my-editor.sh", false],
    ["emacsclient", false],
  ];
  for (const [editor, confirmed] of cases) {
    const launch = await serviceWithEditor(editor).prepareOpenFile("/f.yaml", {
      requireWait: true,
    });
    assertEquals(launch.waitConfirmed, confirmed, editor);
  }
});
