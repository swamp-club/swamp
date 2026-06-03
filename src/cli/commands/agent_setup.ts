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

import { Command } from "@cliffy/command";
import {
  buildInstructionsChoices,
  buildSkillsDirChoices,
  deriveDefaults,
  detectToolConfig,
  validateCustomToolName,
} from "../../domain/repo/custom_tool.ts";
import {
  addCustomTool,
  readCustomTools,
  removeCustomTool,
} from "../../infrastructure/persistence/custom_tools_repository.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function promptLine(message: string): Promise<string> {
  await Deno.stdout.write(encoder.encode(message));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  return decoder.decode(buf.subarray(0, n)).trim();
}

async function promptConfirmation(message: string): Promise<boolean> {
  const response = await promptLine(`${message} [y/N] `);
  return response === "y" || response === "yes";
}

async function promptChoice(
  message: string,
  choices: string[],
): Promise<string> {
  await Deno.stdout.write(encoder.encode(`${message}\n`));
  for (let i = 0; i < choices.length; i++) {
    await Deno.stdout.write(
      encoder.encode(`  ${i + 1}. ${choices[i]}\n`),
    );
  }
  await Deno.stdout.write(
    encoder.encode(`  ${choices.length + 1}. Other path\n`),
  );
  const response = await promptLine("> ");
  const index = parseInt(response, 10) - 1;
  if (index >= 0 && index < choices.length) {
    return choices[index];
  }
  if (index === choices.length) {
    return await promptLine("Path: ");
  }
  return response || choices[0];
}

async function promptMultilineFrontmatter(): Promise<string> {
  await Deno.stdout.write(
    encoder.encode("  Paste frontmatter (end with blank line):\n"),
  );
  const lines: string[] = [];
  while (true) {
    const line = await promptLine("  ");
    if (line === "") break;
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

export const agentSetupCommand = new Command()
  .description("Define a custom AI agent tool for this repository")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["agent", "setup"]);
    const repoDir = resolveRepoDir(undefined);

    if (cliCtx.outputMode === "json") {
      throw new UserError(
        "agent setup requires interactive mode. Remove --json to run the wizard.",
      );
    }

    await Deno.stdout.write(encoder.encode(`
To set up a custom agent you'll need to know three things about your tool:

  1. Where it reads instructions/rules from (e.g. AGENTS.md, .toolname/rules/)
  2. Whether it needs a header block to auto-load rules (like Cursor's):
       ---
       alwaysApply: true
       ---
  3. Where it expects skills/context files to live

If you have an existing repo where the tool is already configured, point
the scanner at it and swamp will detect what it can.

`));

    const name = await promptLine("Agent name: ");
    if (!name) {
      throw new UserError("No agent name provided.");
    }
    validateCustomToolName(name);

    const scanPath = await promptLine(
      `\nDo you have an existing repo where ${name} is set up?\n` +
        "Path (or Enter to skip): ",
    );
    const scanDir = scanPath || repoDir;

    await Deno.stdout.write(
      encoder.encode(
        scanPath
          ? `\nScanning ${scanPath}...\n`
          : "\nScanning current repo...\n",
      ),
    );
    const detection = await detectToolConfig(scanDir, name);

    if (detection.configDir) {
      const subdirInfo = detection.subdirs.length > 0
        ? ` (${
          detection.subdirs.map((s) => `${detection.configDir}/${s}/`).join(
            ", ",
          )
        } found)`
        : "";
      await Deno.stdout.write(
        encoder.encode(`  .${name}/  detected${subdirInfo}\n`),
      );
    }
    for (const file of detection.rootFiles) {
      await Deno.stdout.write(encoder.encode(`  ${file}  (found)\n`));
    }
    if (!detection.configDir && detection.rootFiles.length === 0) {
      await Deno.stdout.write(
        encoder.encode("  No existing config detected.\n"),
      );
    }

    const choices = buildInstructionsChoices(detection, name);
    const instructionsPath = await promptChoice(
      `\nWhere does ${name} read rules/instructions from?`,
      choices,
    );

    let frontmatter: string | undefined;
    await Deno.stdout.write(encoder.encode(`
Some tools need a header like this to auto-load rules:
  ---
  alwaysApply: true
  ---
`));
    const wantsFrontmatter = await promptConfirmation(
      `Does ${name} need this?`,
    );
    if (wantsFrontmatter) {
      frontmatter = await promptMultilineFrontmatter();
    }

    const def = deriveDefaults(
      name,
      instructionsPath,
      detection.configDir,
      detection.skillsDir,
    );
    if (frontmatter) {
      def.frontmatter = frontmatter;
    }

    const skillsDirChoices = buildSkillsDirChoices(detection, def.skillsDir);
    let chosenSkillsDir: string | undefined;
    if (skillsDirChoices.length > 1) {
      const chosen = await promptChoice(
        `\nWhere should swamp write skills for ${name}?`,
        skillsDirChoices,
      );
      if (chosen !== def.skillsDir) {
        chosenSkillsDir = chosen;
      }
    } else {
      const override = await promptLine(
        `\nSkills directory: ${def.skillsDir}/  (Enter to accept, or type a path): `,
      );
      if (override) {
        chosenSkillsDir = override;
      }
    }
    if (chosenSkillsDir) {
      const normalized = chosenSkillsDir.replace(/\/+$/, "");
      def.skillsDir = normalized;
      const gitignoreComment = name.charAt(0).toUpperCase() + name.slice(1);
      def.gitignoreEntries =
        `# ${gitignoreComment} skills (managed by swamp)\n${normalized}/`;
    }

    await addCustomTool(repoDir, def);

    await Deno.stdout.write(encoder.encode(`
Custom agent "${name}" configured:
  Skills:        ${def.skillsDir}/
  Instructions:  ${def.instructionsFile}${
      def.instructionsMode === "shared" ? " (shared)" : ""
    }
  Frontmatter:   ${def.frontmatter ? "yes" : "none"}

Saved to .swamp-custom-tools.yaml
Run \`swamp repo init --tool ${name}\` to set up this repo.
`));

    cliCtx.logger.debug`Agent setup completed for ${name}`;
  });

export const agentListCommand = new Command()
  .description("List custom AI agent tools defined for this repository")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["agent", "list"]);
    const repoDir = resolveRepoDir(undefined);

    const tools = await readCustomTools(repoDir);

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({ tools }, null, 2));
      return;
    }

    if (tools.length === 0) {
      console.log(
        "No custom tools defined. Run `swamp agent setup` to create one.",
      );
      return;
    }

    console.log(`Custom tools (from .swamp-custom-tools.yaml):\n`);
    for (const tool of tools) {
      console.log(`  ${tool.name}`);
      console.log(`    Skills dir:      ${tool.skillsDir}`);
      console.log(`    Instructions:    ${tool.instructionsFile}`);
      console.log(`    Mode:            ${tool.instructionsMode}`);
      if (tool.frontmatter) {
        console.log(`    Frontmatter:     yes`);
      }
      console.log();
    }

    cliCtx.logger.debug`Agent list completed`;
  });

export const agentRemoveCommand = new Command()
  .name("rm")
  .description("Remove a custom AI agent tool definition")
  .arguments("<name:string>")
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, ["agent", "rm"]);
    const repoDir = resolveRepoDir(undefined);

    if (cliCtx.outputMode !== "json") {
      const confirmed = await promptConfirmation(
        `Remove custom tool "${name}" from .swamp-custom-tools.yaml?`,
      );
      if (!confirmed) {
        console.log("Cancelled.");
        return;
      }
    }

    const removed = await removeCustomTool(repoDir, name);

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({ name, removed }, null, 2));
      return;
    }

    if (removed) {
      console.log(`Removed custom tool "${name}".`);
    } else {
      throw new UserError(`Custom tool "${name}" not found.`);
    }

    cliCtx.logger.debug`Agent rm completed for ${name}`;
  });

export const agentCommand = new Command()
  .name("agent")
  .description("Manage custom AI agent tool definitions")
  .command("setup", agentSetupCommand)
  .command("list", agentListCommand)
  .command("rm", agentRemoveCommand);
