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

/**
 * Architecture fitness rules for printing a v3 command's result only after
 * its root has committed (swamp-club#3759).
 *
 * The CLI holds stdout in its root helpers (`runCommandInRootUnit`,
 * `runInCoordinatorRoot`), so every way a CLI command reaches a commit must
 * go through one of them; serve holds its replies in `confirmRequest`
 * instead, and must never patch the process's console.
 */

import { join } from "@std/path";
import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  ROOT,
} from "./arch_fitness_helpers.ts";

/** Every CLI root helper, which must hold the command's stdout. */
const CLI_ROOT_HELPERS: readonly string[] = [
  "src/cli/command_root_unit.ts",
  "src/cli/coordinator_root.ts",
];

// `src/cli` files that open a root with runInRootUnitOfWork themselves,
// not through a CLI root helper, so the hold is not theirs to open.
const PINNED_DIRECT_CLI_ROOTS: readonly string[] = [
  // The helpers themselves.
  "src/cli/command_root_unit.ts",
  "src/cli/coordinator_root.ts",
  // The managed lockfile transaction, which runs inside the command's own
  // root (runManagedConfigMutation), so its root is that root's child.
  "src/cli/managed_config_sync.ts",
  // Publish and discard helpers called inside a command's root, or after
  // it, writing nothing a command reports.
  "src/cli/repo_context.ts",
  // Serve answers over its socket; confirmRequest holds those replies.
  "src/cli/commands/serve.ts",
];

// CLI command files that call a transactional use case without a CLI root
// helper.
const PINNED_USE_CASES_WITHOUT_CLI_ROOT: readonly string[] = [
  // Serve's own use of model delete, method run and worker prune answers
  // over its socket, under serve's request roots and confirmRequest.
  "src/cli/commands/serve.ts",
];

// Commands whose progress streams in log mode and whose result alone waits
// for the commit ("live-until-outcome"). `data prune` streams its status
// lines, which ran 6-10 s on populated buckets (swamp-club#3893).
const PINNED_LIVE_UNTIL_OUTCOME: readonly string[] = [
  "src/cli/commands/data_prune.ts",
  "src/cli/commands/model_method_run.ts",
  "src/cli/commands/workflow_resume.ts",
  "src/cli/commands/workflow_run.ts",
];

const CLI_ROOT_CALL =
  /\b(?:runCommandInRootUnit|runManagedConfigMutation|runInCoordinatorRoot)\s*\(/;

async function sources(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const path of productionSourceFiles(join(ROOT, dir))) {
    files.set(repoRelative(path), await Deno.readTextFile(path));
  }
  return files;
}

/** The transactional use cases, as the write-seams rule pins them. */
async function transactionalUseCases(): Promise<string[]> {
  const rules = await Deno.readTextFile(
    join(ROOT, "integration/datastore_write_seams_rules_test.ts"),
  );
  const list = rules.split(
    "PINNED_TRANSACTIONAL_USE_CASES: readonly string[] = [",
  )[1].split("];")[0];
  return [...list.matchAll(/\.ts: (\w+)",/g)].map((match) => match[1]);
}

Deno.test("v3 output after commit: every CLI root helper holds the command's stdout (swamp-club#3759)", async () => {
  const cli = await sources("src/cli");
  const holding = CLI_ROOT_HELPERS.filter((path) =>
    /\bopenOutputHold\s*\(/.test(cli.get(path) ?? "")
  );
  assertPinnedSet(
    holding,
    CLI_ROOT_HELPERS,
    "CLI root helpers holding stdout",
    "A CLI root helper opens openOutputHold on a v3 root and ends it with\n" +
      "the root's onEnded, so the command's result waits for the commit.",
  );
});

Deno.test("v3 output after commit: a CLI file that opens a root itself is pinned (swamp-club#3759)", async () => {
  const cli = await sources("src/cli");
  const direct = [...cli]
    .filter(([, code]) => /\brunInRootUnitOfWork\s*\(/.test(code))
    .map(([path]) => path)
    .sort();
  assertPinnedSet(
    direct,
    PINNED_DIRECT_CLI_ROOTS,
    "src/cli files calling runInRootUnitOfWork",
    "A CLI command opens its root with runCommandInRootUnit (or\n" +
      "runInCoordinatorRoot), which holds its stdout until the root\n" +
      "commits. A root opened directly prints before its commit.",
  );
});

Deno.test("v3 output after commit: a CLI command that runs a transactional use case runs it under a CLI root (swamp-club#3759)", async () => {
  const useCases = await transactionalUseCases();
  const commands = await sources("src/cli/commands");
  const unrooted = [...commands]
    .filter(([, code]) =>
      useCases.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(code)) &&
      !CLI_ROOT_CALL.test(code)
    )
    .map(([path]) => path)
    .sort();
  assertPinnedSet(
    unrooted,
    PINNED_USE_CASES_WITHOUT_CLI_ROOT,
    "CLI commands running a transactional use case without a CLI root",
    "Wrap the use case in runCommandInRootUnit (push: undefined when the\n" +
      "command pushes nothing), so its result waits for the commit.",
  );
});

Deno.test("v3 output after commit: only the streaming commands print live until their outcome (swamp-club#3759)", async () => {
  const commands = await sources("src/cli/commands");
  const live = [...commands]
    .filter(([, code]) => code.includes('"live-until-outcome"'))
    .map(([path]) => path)
    .sort();
  assertPinnedSet(
    live,
    PINNED_LIVE_UNTIL_OUTCOME,
    "commands printing live until their outcome",
    "Only a command whose progress must stream (a run, or data prune's\n" +
      "status lines) prints before its commit, and it wraps its handlers in\n" +
      "holdFromOutcome.",
  );
});

Deno.test("v3 output after commit: serve never holds the process's stdout (swamp-club#3759)", async () => {
  const serve = await sources("src/serve");
  const importing = [...serve]
    .filter(([, code]) => code.includes("committed_output.ts"))
    .map(([path]) => path)
    .sort();
  assertPinnedSet(
    importing,
    [],
    "src/serve files importing the CLI's stdout hold",
    "Serve writes its own log lines concurrently; it holds a request's\n" +
      "replies in confirmRequest, never the console.",
  );
});
