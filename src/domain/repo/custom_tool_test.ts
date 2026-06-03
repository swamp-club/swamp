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

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertPathContained,
  buildInstructionsChoices,
  buildSkillsDirChoices,
  builtInToolConfig,
  customToolConfig,
  deriveDefaults,
  detectToolConfig,
  isBuiltInTool,
  validateCustomToolName,
} from "./custom_tool.ts";
import { UserError } from "../errors.ts";

Deno.test("isBuiltInTool: recognizes built-in tools", () => {
  assertEquals(isBuiltInTool("claude"), true);
  assertEquals(isBuiltInTool("cursor"), true);
  assertEquals(isBuiltInTool("opencode"), true);
  assertEquals(isBuiltInTool("codex"), true);
  assertEquals(isBuiltInTool("copilot"), true);
  assertEquals(isBuiltInTool("kiro"), true);
  assertEquals(isBuiltInTool("none"), true);
});

Deno.test("isBuiltInTool: rejects unknown names", () => {
  assertEquals(isBuiltInTool("windsurf"), false);
  assertEquals(isBuiltInTool("tabnine"), false);
  assertEquals(isBuiltInTool(""), false);
});

Deno.test("validateCustomToolName: accepts valid names", () => {
  validateCustomToolName("windsurf");
  validateCustomToolName("tabnine");
  validateCustomToolName("my-tool");
  validateCustomToolName("tool123");
  validateCustomToolName("Pi");
  validateCustomToolName("MyTool");
});

Deno.test("validateCustomToolName: rejects built-in names", () => {
  assertThrows(
    () => validateCustomToolName("claude"),
    UserError,
    "built-in tool",
  );
  assertThrows(
    () => validateCustomToolName("none"),
    UserError,
    "built-in tool",
  );
});

Deno.test("validateCustomToolName: rejects built-in names case-insensitively", () => {
  assertThrows(
    () => validateCustomToolName("Claude"),
    UserError,
    "conflicts with a built-in",
  );
  assertThrows(
    () => validateCustomToolName("KIRO"),
    UserError,
    "conflicts with a built-in",
  );
});

Deno.test("validateCustomToolName: rejects invalid patterns", () => {
  assertThrows(
    () => validateCustomToolName("my tool"),
    UserError,
    "alphanumeric",
  );
  assertThrows(
    () => validateCustomToolName(""),
    UserError,
    "alphanumeric",
  );
  assertThrows(
    () => validateCustomToolName("-tool"),
    UserError,
    "alphanumeric",
  );
});

Deno.test("builtInToolConfig: claude config", () => {
  const config = builtInToolConfig("claude");
  assertEquals(config.name, "claude");
  assertEquals(config.isBuiltIn, true);
  assertEquals(config.skillsDir, ".claude/skills");
  assertEquals(config.instructionsFile, "CLAUDE.md");
  assertEquals(config.instructionsMode, "shared");
  assertEquals(config.skillReferenceStyle, "name");
});

Deno.test("builtInToolConfig: cursor config", () => {
  const config = builtInToolConfig("cursor");
  assertEquals(config.name, "cursor");
  assertEquals(config.isBuiltIn, true);
  assertEquals(config.skillsDir, ".cursor/skills");
  assertEquals(config.instructionsFile, ".cursor/rules/swamp.mdc");
  assertEquals(config.instructionsMode, "owned");
  assertEquals(config.skillReferenceStyle, "path");
  assertEquals(config.frontmatter !== undefined, true);
});

Deno.test("builtInToolConfig: kiro config", () => {
  const config = builtInToolConfig("kiro");
  assertEquals(config.name, "kiro");
  assertEquals(config.isBuiltIn, true);
  assertEquals(config.skillsDir, ".kiro/skills");
  assertEquals(config.instructionsFile, ".kiro/steering/swamp-rules.md");
  assertEquals(config.instructionsMode, "owned");
});

Deno.test("builtInToolConfig: opencode/codex/copilot share AGENTS.md", () => {
  for (const tool of ["opencode", "codex", "copilot"] as const) {
    const config = builtInToolConfig(tool);
    assertEquals(config.instructionsFile, "AGENTS.md");
    assertEquals(config.instructionsMode, "shared");
    assertEquals(config.skillsDir, ".agents/skills");
  }
});

Deno.test("customToolConfig: wraps definition correctly", () => {
  const def = {
    name: "windsurf",
    skillsDir: ".windsurf/skills",
    instructionsFile: "AGENTS.md",
    instructionsMode: "shared" as const,
    skillReferenceStyle: "path" as const,
  };
  const config = customToolConfig(def);
  assertEquals(config.name, "windsurf");
  assertEquals(config.isBuiltIn, false);
  assertEquals(config.skillsDir, ".windsurf/skills");
  assertEquals(config.instructionsFile, "AGENTS.md");
  assertEquals(config.instructionsMode, "shared");
});

Deno.test("deriveDefaults: root-level shared file without config dir", () => {
  const def = deriveDefaults("windsurf", "AGENTS.md");
  assertEquals(def.name, "windsurf");
  assertEquals(def.skillsDir, ".windsurf/skills");
  assertEquals(def.instructionsFile, "AGENTS.md");
  assertEquals(def.instructionsMode, "shared");
  assertEquals(def.skillReferenceStyle, "path");
});

Deno.test("deriveDefaults: root-level shared file with detected config dir", () => {
  const def = deriveDefaults("windsurf", "AGENTS.md", ".windsurf");
  assertEquals(def.skillsDir, ".windsurf/skills");
  assertEquals(def.instructionsMode, "shared");
});

Deno.test("deriveDefaults: file inside dot-directory", () => {
  const def = deriveDefaults("tabnine", ".tabnine/guidelines/swamp.md");
  assertEquals(def.skillsDir, ".tabnine/skills");
  assertEquals(def.instructionsFile, ".tabnine/guidelines/swamp.md");
  assertEquals(def.instructionsMode, "owned");
});

Deno.test("deriveDefaults: file inside non-dot directory", () => {
  const def = deriveDefaults("mytool", "config/rules/swamp.md");
  assertEquals(def.skillsDir, ".mytool/skills");
  assertEquals(def.instructionsMode, "owned");
});

Deno.test("deriveDefaults: root-level non-shared file", () => {
  const def = deriveDefaults("mytool", "RULES.md");
  assertEquals(def.instructionsMode, "owned");
  assertEquals(def.skillsDir, ".mytool/skills");
});

Deno.test("detectToolConfig: empty directory returns no detections", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await detectToolConfig(dir, "windsurf");
    assertEquals(result.configDir, undefined);
    assertEquals(result.subdirs, []);
    assertEquals(result.rootFiles, []);
    assertEquals(result.skillsDir, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("detectToolConfig: detects config dir and subdirs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.windsurf/rules`, { recursive: true });
    await Deno.mkdir(`${dir}/.windsurf/guidelines`, { recursive: true });
    const result = await detectToolConfig(dir, "windsurf");
    assertEquals(result.configDir, ".windsurf");
    assertEquals(result.subdirs.includes("rules"), true);
    assertEquals(result.subdirs.includes("guidelines"), true);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("detectToolConfig: detects root-level files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/AGENTS.md`, "# Agents");
    const result = await detectToolConfig(dir, "windsurf");
    assertEquals(result.rootFiles, ["AGENTS.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("buildInstructionsChoices: with detected root files and config dir", () => {
  const choices = buildInstructionsChoices(
    {
      configDir: ".windsurf",
      subdirs: ["rules"],
      rootFiles: ["AGENTS.md"],
    },
    "windsurf",
  );
  assertEquals(choices.includes("AGENTS.md"), true);
  assertEquals(choices.includes(".windsurf/rules/swamp.md"), true);
});

Deno.test("buildInstructionsChoices: no detections defaults to AGENTS.md", () => {
  const choices = buildInstructionsChoices(
    { subdirs: [], rootFiles: [] },
    "windsurf",
  );
  assertEquals(choices, ["AGENTS.md"]);
});

Deno.test("buildInstructionsChoices: config dir without known subdirs suggests rules/", () => {
  const choices = buildInstructionsChoices(
    { configDir: ".tabnine", subdirs: [], rootFiles: [] },
    "tabnine",
  );
  assertEquals(choices.includes(".tabnine/rules/swamp.md"), true);
});

Deno.test("detectToolConfig: detects bare skills/ directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/skills`, { recursive: true });
    const result = await detectToolConfig(dir, "deepagents");
    assertEquals(result.skillsDir, "skills");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("deriveDefaults: uses detectedSkillsDir when provided", () => {
  const def = deriveDefaults("deepagents", "AGENTS.md", undefined, "skills");
  assertEquals(def.skillsDir, "skills");
  assertEquals(def.instructionsMode, "shared");
  assertEquals(
    def.gitignoreEntries,
    "# Deepagents skills (managed by swamp)\nskills/",
  );
});

Deno.test("deriveDefaults: detectedSkillsDir takes priority over configDir", () => {
  const def = deriveDefaults("mytool", "AGENTS.md", ".mytool", "skills");
  assertEquals(def.skillsDir, "skills");
});

Deno.test("buildSkillsDirChoices: single choice when no detection", () => {
  const choices = buildSkillsDirChoices(
    { subdirs: [], rootFiles: [] },
    ".deepagents/skills",
  );
  assertEquals(choices, [".deepagents/skills"]);
});

Deno.test("buildSkillsDirChoices: includes detected skillsDir", () => {
  const choices = buildSkillsDirChoices(
    { subdirs: [], rootFiles: [], skillsDir: "skills" },
    ".deepagents/skills",
  );
  assertEquals(choices, [".deepagents/skills", "skills"]);
});

Deno.test("buildSkillsDirChoices: includes configDir/skills", () => {
  const choices = buildSkillsDirChoices(
    { configDir: ".mytool", subdirs: [], rootFiles: [] },
    "other/skills",
  );
  assertEquals(choices, ["other/skills", ".mytool/skills"]);
});

Deno.test("buildSkillsDirChoices: deduplicates when derived matches detected", () => {
  const choices = buildSkillsDirChoices(
    { subdirs: [], rootFiles: [], skillsDir: "skills" },
    "skills",
  );
  assertEquals(choices, ["skills"]);
});

Deno.test("assertPathContained: allows paths within repo", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertPathContained(dir, "skills", "skillsDir");
    assertPathContained(dir, ".foo/skills", "skillsDir");
    assertPathContained(dir, "AGENTS.md", "instructionsFile");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("assertPathContained: rejects path traversal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertThrows(
      () => assertPathContained(dir, "../../etc/foo", "skillsDir"),
      UserError,
      "escapes the repository root",
    );
    assertThrows(
      () =>
        assertPathContained(
          dir,
          "../.ssh/authorized_keys",
          "instructionsFile",
        ),
      UserError,
      "escapes the repository root",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
