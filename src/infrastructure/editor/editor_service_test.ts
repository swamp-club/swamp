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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { EditorService } from "./editor_service.ts";

Deno.test("EditorService.findEditor returns $EDITOR when set", async () => {
  const originalEditor = Deno.env.get("EDITOR");
  try {
    // Set EDITOR to a command that exists
    Deno.env.set("EDITOR", "cat");
    const service = new EditorService();
    const editor = await service.findEditor();
    assertEquals(editor, "cat");
  } finally {
    if (originalEditor) {
      Deno.env.set("EDITOR", originalEditor);
    } else {
      Deno.env.delete("EDITOR");
    }
  }
});

Deno.test("EditorService.findEditor handles $EDITOR with arguments", async () => {
  const originalEditor = Deno.env.get("EDITOR");
  try {
    // Set EDITOR to a command with arguments
    Deno.env.set("EDITOR", "cat -n");
    const service = new EditorService();
    const editor = await service.findEditor();
    assertEquals(editor, "cat -n");
  } finally {
    if (originalEditor) {
      Deno.env.set("EDITOR", originalEditor);
    } else {
      Deno.env.delete("EDITOR");
    }
  }
});

Deno.test("EditorService.findEditor falls back when $EDITOR is not available", async () => {
  const originalEditor = Deno.env.get("EDITOR");
  try {
    // Set EDITOR to a non-existent command
    Deno.env.set("EDITOR", "nonexistent-editor-12345");
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
  } finally {
    if (originalEditor) {
      Deno.env.set("EDITOR", originalEditor);
    } else {
      Deno.env.delete("EDITOR");
    }
  }
});

Deno.test("EditorService.findEditor throws when no editor is available", async () => {
  const originalEditor = Deno.env.get("EDITOR");
  const originalPath = Deno.env.get("PATH");
  try {
    // Clear EDITOR and set PATH to empty to ensure no editors are found
    Deno.env.delete("EDITOR");
    Deno.env.set("PATH", "");
    const service = new EditorService();
    await assertRejects(
      () => service.findEditor(),
      Error,
      "No editor found",
    );
  } finally {
    if (originalEditor) {
      Deno.env.set("EDITOR", originalEditor);
    }
    if (originalPath) {
      Deno.env.set("PATH", originalPath);
    }
  }
});

Deno.test("EditorService module exports EditorService class", async () => {
  const module = await import("./editor_service.ts");
  assertEquals(typeof module.EditorService, "function");
});
