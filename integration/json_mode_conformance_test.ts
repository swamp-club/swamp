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

import { assert, assertEquals } from "@std/assert";
import { walk as walkFs } from "@std/fs";
import { dirname, fromFileUrl, join, relative, toFileUrl } from "@std/path";
import { Command } from "@cliffy/command";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { definingModuleOf } from "../src/cli/commands/command_syntax.ts";

await initializeLogging({});

/**
 * Cliffy's Command has eight generic parameters that change with every chained
 * call, so a precise type is impossible; mirrors the relaxed alias in
 * cli_schema.ts
 */
// deno-lint-ignore no-explicit-any
type AnyCommand = any;

const OUTPUT_MODE_MARKERS = /outputMode|OutputMode|writeOutput|jsonMode/;

/**
 * leaf commands that legitimately cannot honour --json, pinned by command path;
 * do not add one to silence a failure, new commands render through
 * createContext(...).outputMode
 */
const EXEMPT_COMMAND_PATHS = new Map<string, string>([
  // Cliffy's built-in `CompletionsCommand`. These emit shell completion
  // scripts (bash/zsh/fish source text) for `eval`, not swamp output, and are
  // implemented by the framework — swamp does not own their actions.
  ["completions bash", "framework-provided shell completion script emitter"],
  ["completions fish", "framework-provided shell completion script emitter"],
  ["completions zsh", "framework-provided shell completion script emitter"],
  [
    "completions complete",
    "framework-provided completion-candidate emitter (shell-internal)",
  ],
  // swamp's own PowerShell generator (Cliffy has none), the sibling of the
  // three above: it emits PowerShell source for `Invoke-Expression`, so it
  // cannot have a JSON mode either.
  [
    "completions powershell",
    "shell completion script emitter (PowerShell source for Invoke-Expression)",
  ],

  // Always emits JSON, in both modes, by design: it exists to hand the whole
  // CLI schema to AI agents. `--json` is a no-op rather than unsupported.
  ["help", "always emits JSON — CLI schema for agent consumption"],

  // Removed command kept as a stub. Its action does nothing but throw a
  // UserError; the CLI's top-level error handler renders that in the caller's
  // output mode, so the action itself has no output to mode-switch.
  [
    "datastore setup s3",
    "removed command stub — action only throws UserError",
  ],

  // Internal IPC entry points. These speak a framed JSON protocol on
  // stdin/stdout to a parent swamp process (never to a terminal), so an
  // OutputMode would have nothing to switch. Both are hidden.
  [
    "worker exec-dispatch",
    "internal stdio RPC runner — stdout is the dispatch protocol",
  ],
  [
    "audit record",
    "internal hook sink — reads hook JSON on stdin, emits nothing on stdout",
  ],
]);

interface LeafCommand {
  path: string;
  command: AnyCommand;
  actionSource: string;
  definingFile: string | undefined;
}

interface CliTree {
  leaves: LeafCommand[];
  sources: Map<string, string>;
  topLevelNames: string[];
}

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
const cliDir = join(repoRoot, "src", "cli");
const commandsDir = join(cliDir, "commands");

function isCliffyCommand(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    typeof (value as AnyCommand).getName === "function" &&
    typeof (value as AnyCommand).getCommands === "function";
}

/**
 * modules that execute on import must not be imported here; detected from
 * source rather than pinned by name so a new entry point cannot hang the suite
 */
function isEntryScript(source: string): boolean {
  return /^await /m.test(source) || /^if \(import\.meta\.main\)/m.test(source);
}

/** relies on deno fmt: a top-level closing brace is always at column 0 */
function declarationBody(source: string, declarationIndex: number): string {
  const rest = source.slice(declarationIndex);
  const end = rest.search(/\n\}\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

function delegatesToOutputModeHelper(
  actionSource: string,
  definingFile: string | undefined,
  sources: Map<string, string>,
): boolean {
  if (!definingFile) return false;
  const source = sources.get(definingFile);
  if (!source) return false;

  const callees = new Set<string>();
  for (const match of actionSource.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    callees.add(match[1]);
  }

  for (const callee of callees) {
    for (
      const declaration of [
        `function ${callee}(`,
        `async function ${callee}(`,
        `const ${callee} = `,
      ]
    ) {
      const index = source.indexOf(declaration);
      if (index === -1) continue;
      if (OUTPUT_MODE_MARKERS.test(declarationBody(source, index))) return true;
    }
  }
  return false;
}

async function loadCommandModules(): Promise<{
  fileOfCommand: Map<unknown, string>;
  sources: Map<string, string>;
}> {
  const fileOfCommand = new Map<unknown, string>();
  const sources = new Map<string, string>();

  // import mod.ts first to settle command modules in production order; entering
  // the extension.ts -> extension_source.ts -> extension_source_add.ts cycle
  // from the wrong side throws a TDZ ReferenceError
  await import(toFileUrl(join(cliDir, "mod.ts")).href);

  for await (
    const entry of walkFs(commandsDir, { exts: [".ts"], includeDirs: false })
  ) {
    if (entry.path.endsWith("_test.ts")) continue;
    const source = await Deno.readTextFile(entry.path);
    if (isEntryScript(source)) continue;
    sources.set(entry.path, source);

    const module = await import(toFileUrl(entry.path).href) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(module)) {
      if (isCliffyCommand(value) && !fileOfCommand.has(value)) {
        fileOfCommand.set(value, entry.path);
      }
    }
  }

  return { fileOfCommand, sources };
}

async function readTopLevelRegistrations(): Promise<
  Array<{ name: string; symbol: string; specifier: string }>
> {
  const modSource = await Deno.readTextFile(join(cliDir, "mod.ts"));

  const importedFrom = new Map<string, string>();
  for (
    const match of modSource.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"(\.\/commands\/[^"]+)"/g,
    )
  ) {
    for (const symbol of match[1].split(",").map((s) => s.trim())) {
      if (symbol) importedFrom.set(symbol, match[2]);
    }
  }

  const registrations: Array<
    { name: string; symbol: string; specifier: string }
  > = [];
  for (
    const match of modSource.matchAll(
      /\.command\(\s*"([\w-]+)",\s*([A-Za-z_$][\w$]*)/g,
    )
  ) {
    const [, name, symbol] = match;
    const specifier = importedFrom.get(symbol);
    assert(
      specifier !== undefined,
      `src/cli/mod.ts registers "${name}" from symbol "${symbol}", which is ` +
        `not imported from ./commands/. The JSON-mode conformance test cannot ` +
        `resolve it — move the command under src/cli/commands/.`,
    );
    registrations.push({ name, symbol, specifier });
  }
  return registrations;
}

/**
 * prefer the factory's recorded module: swamp behavior leaves are built by the
 * same factories as their model twins and no module exports them; otherwise
 * fall back to the exporting module
 */
function definingFileOf(
  command: AnyCommand,
  fileOfCommand: Map<unknown, string>,
): string | undefined {
  const recorded = definingModuleOf(command);
  return recorded === undefined
    ? fileOfCommand.get(command)
    : fromFileUrl(recorded);
}

let cachedTree: CliTree | undefined;

async function buildCliTree(): Promise<CliTree> {
  if (cachedTree) return cachedTree;

  const { fileOfCommand, sources } = await loadCommandModules();
  const registrations = await readTopLevelRegistrations();

  // Mirrors the root wiring in src/cli/mod.ts. The `--json` global option is
  // what every leaf must inherit; `cliRootDeclaresGlobalJson` below pins that
  // production really declares it this way.
  const root = new Command()
    .name("swamp")
    .globalOption("--json", "Output in JSON format (non-interactive)");

  for (const { name, symbol, specifier } of registrations) {
    const path = join(cliDir, specifier.replace(/^\.\//, ""));
    const module = await import(toFileUrl(path).href) as Record<
      string,
      unknown
    >;
    const exported = module[symbol];
    assert(
      exported !== undefined,
      `src/cli/mod.ts imports "${symbol}" from ${specifier}, but that module ` +
        `does not export it.`,
    );
    const command = typeof exported === "function"
      ? (exported as (root: AnyCommand) => AnyCommand)(root)
      : exported;
    (root as AnyCommand).command(name, command);
  }

  const leaves: LeafCommand[] = [];
  const visit = (command: AnyCommand, path: string[]): void => {
    // `true` includes hidden subcommands — hidden commands are still commands.
    const subcommands = command.getCommands(true) as AnyCommand[];
    if (subcommands.length > 0) {
      for (const sub of subcommands) {
        visit(sub, [...path, sub.getName() as string]);
      }
      return;
    }
    const handler = command.settings?.actionHandler;
    leaves.push({
      path: path.join(" "),
      command,
      actionSource: typeof handler === "function" ? handler.toString() : "",
      definingFile: definingFileOf(command, fileOfCommand),
    });
  };

  for (const sub of (root as AnyCommand).getCommands(true) as AnyCommand[]) {
    visit(sub, [sub.getName() as string]);
  }

  cachedTree = {
    leaves,
    sources,
    topLevelNames: registrations.map((r) => r.name),
  };
  return cachedTree;
}

Deno.test("cli command tree: root declares --json as a global option", async () => {
  const modSource = await Deno.readTextFile(join(cliDir, "mod.ts"));
  assert(
    modSource.includes('.globalOption("--json"'),
    "src/cli/mod.ts must declare --json as a globalOption on the root " +
      "command — every subcommand inherits JSON support from it.",
  );
});

Deno.test("cli command tree: every leaf command declares an action and inherits --json", async () => {
  const { leaves, topLevelNames } = await buildCliTree();

  assert(
    topLevelNames.length >= 25,
    `expected ~27 top-level commands, found ${topLevelNames.length}: ` +
      topLevelNames.join(", "),
  );
  assert(
    leaves.length >= 150,
    `expected the walk to reach the full subcommand tree, found only ` +
      `${leaves.length} leaves`,
  );

  const withoutAction: string[] = [];
  const withoutJsonOption: string[] = [];

  for (const leaf of leaves) {
    if (leaf.actionSource === "") withoutAction.push(leaf.path);

    // Exempt commands are outside the JSON contract entirely — Cliffy's
    // built-in `completions` subtree, for one, rejects `--json` outright
    // because the framework builds those subcommands without globals.
    if (EXEMPT_COMMAND_PATHS.has(leaf.path)) continue;

    const option = leaf.command.getOption("json", true) as
      | { flags: string[] }
      | undefined;
    if (!option || !option.flags.includes("--json")) {
      withoutJsonOption.push(leaf.path);
    }
  }

  assertEquals(
    withoutAction,
    [],
    "leaf commands with no action handler are unreachable dead ends:\n" +
      withoutAction.map((p) => `  swamp ${p}`).join("\n"),
  );
  assertEquals(
    withoutJsonOption,
    [],
    "these leaf commands do not resolve the global --json option (a local " +
      "option or a detached subtree is shadowing it):\n" +
      withoutJsonOption.map((p) => `  swamp ${p}`).join("\n"),
  );
});

Deno.test("cli command tree: every leaf command routes output through the OutputMode plumbing", async () => {
  const { leaves, sources } = await buildCliTree();

  const offenders: string[] = [];
  for (const leaf of leaves) {
    if (EXEMPT_COMMAND_PATHS.has(leaf.path)) continue;

    const routes = OUTPUT_MODE_MARKERS.test(leaf.actionSource) ||
      delegatesToOutputModeHelper(
        leaf.actionSource,
        leaf.definingFile,
        sources,
      );
    if (routes) continue;

    const where = leaf.definingFile
      ? relative(repoRoot, leaf.definingFile)
      : "unknown module";
    offenders.push(`  swamp ${leaf.path}  (${where})`);
  }

  assertEquals(
    offenders,
    [],
    "CLAUDE.md requires every command to support both log and json output " +
      "modes, but these commands' actions never consult the resolved " +
      "OutputMode. Render through `createContext(options, [...]).outputMode` " +
      "(see src/cli/commands/data_get.ts), or — only if the command genuinely " +
      "cannot have two modes — pin it in EXEMPT_COMMAND_PATHS with a " +
      "reason:\n" + offenders.join("\n"),
  );
});

Deno.test("cli command tree: the JSON-mode exemption list has no stale entries", async () => {
  const { leaves } = await buildCliTree();
  const known = new Set(leaves.map((leaf) => leaf.path));

  const stale = [...EXEMPT_COMMAND_PATHS.keys()].filter((path) =>
    !known.has(path)
  );
  assertEquals(
    stale,
    [],
    "EXEMPT_COMMAND_PATHS names commands that no longer exist — remove " +
      "them so the exemption list stays an accurate inventory:\n" +
      stale.map((p) => `  swamp ${p}`).join("\n"),
  );

  // An exemption that would now pass the contract on its own merit is also
  // stale — drop it so the list only ever shrinks.
  const unnecessary = leaves
    .filter((leaf) => EXEMPT_COMMAND_PATHS.has(leaf.path))
    .filter((leaf) => OUTPUT_MODE_MARKERS.test(leaf.actionSource))
    .map((leaf) => leaf.path);
  assertEquals(
    unnecessary,
    [],
    "these commands are exempted but now route through the OutputMode " +
      "plumbing — remove them from EXEMPT_COMMAND_PATHS:\n" +
      unnecessary.map((p) => `  swamp ${p}`).join("\n"),
  );
});

Deno.test("cli command tree: every swamp behavior leaf traces to the module of its swamp model twin", async () => {
  const { leaves } = await buildCliTree();
  const byPath = new Map(leaves.map((leaf) => [leaf.path, leaf]));
  const behaviorLeaves = leaves.filter((leaf) =>
    leaf.path.startsWith("behavior ")
  );
  assert(
    behaviorLeaves.length >= 19,
    `expected the full behavior tree, found ${behaviorLeaves.length} leaves`,
  );
  for (const leaf of behaviorLeaves) {
    const [, word, ...rest] = leaf.path.split(" ");
    const twinPath = ["run", "describe", "history"].includes(word)
      ? ["model", "method", word, ...rest].join(" ")
      : ["model", word, ...rest].join(" ");
    const twin = byPath.get(twinPath);
    assert(twin !== undefined, `${leaf.path}: no twin at ${twinPath}`);
    assert(leaf.definingFile !== undefined, `${leaf.path}: unmapped`);
    assertEquals(leaf.definingFile, twin.definingFile, leaf.path);
  }
});
