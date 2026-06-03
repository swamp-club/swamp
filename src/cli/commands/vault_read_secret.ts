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
  consumeStream,
  createLibSwampContext,
  createVaultReadSecretDeps,
  vaultReadSecret,
} from "../../libswamp/mod.ts";
import { createVaultReadSecretRenderer } from "../../presentation/renderers/vault_read_secret.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

export const vaultReadSecretCommand = new Command()
  .name("read-secret")
  .description(
    `Read a secret value from a vault.

In interactive (log) mode, prompts for confirmation before revealing the secret
unless --force is set. In --json mode, outputs the value directly.`,
  )
  .example("Read a secret", "swamp vault read-secret my-vault API_KEY --force")
  .example(
    "Read a secret (JSON output)",
    "swamp vault read-secret my-vault API_KEY --json",
  )
  .arguments("<vault_name:string> <key:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-f, --force", "Skip confirmation prompt")
  .action(async function (
    options: AnyOptions,
    vaultName: string,
    key: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "read-secret",
    ]);
    cliCtx.logger.debug`Reading secret from vault: ${vaultName}`;

    const { repoDir, repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    if (cliCtx.outputMode === "log" && !options.force) {
      const confirmed = await promptConfirmation(
        `This will reveal the secret '${key}' from vault '${vaultName}'. Continue?`,
      );
      if (!confirmed) {
        cliCtx.logger.info`Cancelled.`;
        return;
      }
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultReadSecretDeps(repoDir, repoContext.eventBus);

    const renderer = createVaultReadSecretRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultReadSecret(ctx, deps, { vaultName, secretKey: key }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault read-secret command completed");
  });
