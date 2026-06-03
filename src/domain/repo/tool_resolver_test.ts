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
import { ToolResolver } from "./tool_resolver.ts";
import {
  readCustomTools,
  writeCustomTools,
} from "../../infrastructure/persistence/custom_tools_repository.ts";
import { UserError } from "../errors.ts";

Deno.test("ToolResolver.resolve: returns built-in tool config", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const resolver = new ToolResolver(dir, readCustomTools);
    const config = await resolver.resolve("claude");
    assertEquals(config.name, "claude");
    assertEquals(config.isBuiltIn, true);
    assertEquals(config.skillsDir, ".claude/skills");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver.resolve: returns custom tool config", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [{
      name: "windsurf",
      skillsDir: ".windsurf/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);
    const resolver = new ToolResolver(dir, readCustomTools);
    const config = await resolver.resolve("windsurf");
    assertEquals(config.name, "windsurf");
    assertEquals(config.isBuiltIn, false);
    assertEquals(config.skillsDir, ".windsurf/skills");
    assertEquals(config.instructionsFile, "AGENTS.md");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver.resolve: throws for unknown tool", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const resolver = new ToolResolver(dir, readCustomTools);
    await assertRejects(
      () => resolver.resolve("nonexistent"),
      UserError,
      "Unknown tool",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver.resolve: error message suggests swamp agent setup", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const resolver = new ToolResolver(dir, readCustomTools);
    await assertRejects(
      () => resolver.resolve("nonexistent"),
      UserError,
      "swamp agent setup",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver.isKnown: built-in tools", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const resolver = new ToolResolver(dir, readCustomTools);
    assertEquals(await resolver.isKnown("claude"), true);
    assertEquals(await resolver.isKnown("none"), true);
    assertEquals(await resolver.isKnown("nonexistent"), false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver.isKnown: custom tools", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [{
      name: "windsurf",
      skillsDir: ".windsurf/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);
    const resolver = new ToolResolver(dir, readCustomTools);
    assertEquals(await resolver.isKnown("windsurf"), true);
    assertEquals(await resolver.isKnown("tabnine"), false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver.allKnownNames: includes built-in and custom", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [{
      name: "windsurf",
      skillsDir: ".windsurf/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);
    const resolver = new ToolResolver(dir, readCustomTools);
    const names = await resolver.allKnownNames();
    assertEquals(names.includes("claude"), true);
    assertEquals(names.includes("cursor"), true);
    assertEquals(names.includes("windsurf"), true);
    assertEquals(names.includes("none"), false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ToolResolver: caches custom tools across calls", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeCustomTools(dir, [{
      name: "windsurf",
      skillsDir: ".windsurf/skills",
      instructionsFile: "AGENTS.md",
      instructionsMode: "shared",
      skillReferenceStyle: "path",
    }]);
    const resolver = new ToolResolver(dir, readCustomTools);
    const config1 = await resolver.resolve("windsurf");
    const config2 = await resolver.resolve("windsurf");
    assertEquals(config1.name, config2.name);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
