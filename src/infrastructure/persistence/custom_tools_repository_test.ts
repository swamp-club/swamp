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
import type { CustomToolDefinition } from "../../domain/repo/custom_tool.ts";
import {
  addCustomTool,
  findCustomTool,
  readCustomTools,
  removeCustomTool,
  writeCustomTools,
} from "./custom_tools_repository.ts";
import { UserError } from "../../domain/errors.ts";

function makeDef(name: string): CustomToolDefinition {
  return {
    name,
    skillsDir: `.${name}/skills`,
    instructionsFile: "AGENTS.md",
    instructionsMode: "shared",
    skillReferenceStyle: "path",
  };
}

Deno.test("readCustomTools: returns empty array when file missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tools = await readCustomTools(dir);
    assertEquals(tools, []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("writeCustomTools + readCustomTools: round-trip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tools = [makeDef("windsurf"), makeDef("tabnine")];
    await writeCustomTools(dir, tools);
    const loaded = await readCustomTools(dir);
    assertEquals(loaded.length, 2);
    assertEquals(loaded[0].name, "windsurf");
    assertEquals(loaded[1].name, "tabnine");
    assertEquals(loaded[0].skillsDir, ".windsurf/skills");
    assertEquals(loaded[0].instructionsMode, "shared");
    assertEquals(loaded[0].skillReferenceStyle, "path");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("writeCustomTools: preserves frontmatter field", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const def: CustomToolDefinition = {
      ...makeDef("windsurf"),
      instructionsMode: "owned",
      frontmatter: "---\ntrigger: always_on\n---\n",
    };
    await writeCustomTools(dir, [def]);
    const loaded = await readCustomTools(dir);
    assertEquals(loaded[0].frontmatter, "---\ntrigger: always_on\n---\n");
    assertEquals(loaded[0].instructionsMode, "owned");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("addCustomTool: appends to existing list", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [makeDef("windsurf")]);
    await addCustomTool(dir, makeDef("tabnine"));
    const loaded = await readCustomTools(dir);
    assertEquals(loaded.length, 2);
    assertEquals(loaded[1].name, "tabnine");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("addCustomTool: rejects duplicate names", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [makeDef("windsurf")]);
    await assertRejects(
      () => addCustomTool(dir, makeDef("windsurf")),
      UserError,
      "already exists",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("addCustomTool: creates file when missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await addCustomTool(dir, makeDef("windsurf"));
    const loaded = await readCustomTools(dir);
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].name, "windsurf");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("removeCustomTool: removes matching tool", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [makeDef("windsurf"), makeDef("tabnine")]);
    const removed = await removeCustomTool(dir, "windsurf");
    assertEquals(removed, true);
    const loaded = await readCustomTools(dir);
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].name, "tabnine");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("removeCustomTool: returns false for non-existent tool", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [makeDef("windsurf")]);
    const removed = await removeCustomTool(dir, "nonexistent");
    assertEquals(removed, false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("findCustomTool: finds matching tool", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [makeDef("windsurf"), makeDef("tabnine")]);
    const found = await findCustomTool(dir, "tabnine");
    assertEquals(found?.name, "tabnine");
    assertEquals(found?.skillsDir, ".tabnine/skills");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("findCustomTool: returns undefined for missing tool", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [makeDef("windsurf")]);
    const found = await findCustomTool(dir, "nonexistent");
    assertEquals(found, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("readCustomTools: rejects entry with missing name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const yaml = `tools:
  - skillsDir: .foo/skills
    instructionsFile: AGENTS.md
    instructionsMode: shared
    skillReferenceStyle: path
`;
    await Deno.writeTextFile(`${dir}/.swamp-custom-tools.yaml`, yaml);
    await assertRejects(
      () => readCustomTools(dir),
      UserError,
      '"name"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("readCustomTools: rejects entry with missing skillsDir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const yaml = `tools:
  - name: mytool
    instructionsFile: AGENTS.md
    instructionsMode: shared
    skillReferenceStyle: path
`;
    await Deno.writeTextFile(`${dir}/.swamp-custom-tools.yaml`, yaml);
    await assertRejects(
      () => readCustomTools(dir),
      UserError,
      '"skillsDir"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
