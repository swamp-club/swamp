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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  createVaultPutDeps,
  vaultPut,
  vaultPutPreview,
} from "../../libswamp/mod.ts";
import {
  createVaultPutRenderer,
  renderVaultPutCancelled,
} from "../../presentation/renderers/vault_put.ts";
import {
  createContext,
  type GlobalOptions,
  isStdinTty,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  readSecretFromTty,
  readStdin,
} from "../../infrastructure/io/stdin_reader.ts";

/**
 * Parses a KEY=VALUE string into key and value parts.
 * Handles values that contain = signs.
 */
export function parseKeyValue(
  input: string,
): { key: string; value: string } | null {
  const equalsIndex = input.indexOf("=");
  if (equalsIndex === -1) {
    return null;
  }

  const key = input.substring(0, equalsIndex);
  const value = input.substring(equalsIndex + 1);

  if (key.length === 0) {
    return null;
  }

  return { key, value };
}

/**
 * Resolves a key and value from a CLI argument and optional stdin content.
 */
export function resolveKeyValue(
  argument: string,
  stdinContent: string | null,
): { key: string; value: string } | { error: string } {
  const parsed = parseKeyValue(argument);
  if (parsed) {
    return parsed;
  }

  const key = argument;
  if (key.length === 0) {
    return { error: "Key cannot be empty" };
  }

  if (stdinContent !== null) {
    const value = stdinContent.replace(/\n$/, "");
    return { key, value };
  }

  return {
    error: `Invalid argument format: ${argument}\n\n` +
      `Provide the value as a separate argument, inline, or via stdin:\n` +
      `  swamp vault put <vault> ${argument} <value>\n` +
      `  swamp vault put <vault> ${argument}=<value>\n` +
      `  echo "<value>" | swamp vault put <vault> ${argument}`,
  };
}

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

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultPutCommand = new Command()
  .name("put")
  .description(
    `Store a secret in a vault.

The value can be provided in several ways:
  - As a third argument:   swamp vault put <vault> <key> <value>
  - Inline with KEY=VALUE: swamp vault put <vault> KEY=VALUE
  - Piped via stdin:       echo "val" | swamp vault put <vault> <key>
  - Interactive prompt:    swamp vault put <vault> <key>  (prompts with hidden input)

Piping via stdin is recommended for scripts and CI to avoid exposing secrets in the process argument list.`,
  )
  .arguments("<vault_name:string> <key:string> [value:string]")
  .example(
    "Inline KEY=VALUE",
    "swamp vault put my-vault API_KEY=sk-1234567890",
  )
  .example(
    "Pipe from stdin (recommended for scripts)",
    'echo "$SECRET" | swamp vault put my-vault API_KEY',
  )
  .example(
    "Interactive prompt (value is hidden)",
    "swamp vault put my-vault API_KEY",
  )
  .example(
    "Overwrite existing secret",
    "swamp vault put my-vault API_KEY=new-value --force",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-f, --force", "Skip confirmation prompt when overwriting")
  .action(async function (
    options: AnyOptions,
    vaultName: string,
    keyOrKeyValue: string,
    valueArg: string | undefined,
  ) {
    const cliCtx = createContext(options as GlobalOptions, ["vault", "put"]);
    cliCtx.logger.debug`Storing secret in vault: ${vaultName}`;

    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    // Resolve key and value from arguments.
    // Priority: explicit value arg > KEY=VALUE format > stdin > interactive prompt.
    let key: string;
    let value: string;
    let stdinContent: string | null = null;

    if (valueArg !== undefined) {
      // 3-arg form: swamp vault put <vault> <key> <value>
      key = keyOrKeyValue;
      value = valueArg;
    } else {
      // 2-arg form: try KEY=VALUE, then stdin, then interactive prompt.
      const parsed = parseKeyValue(keyOrKeyValue);
      if (parsed) {
        key = parsed.key;
        value = parsed.value;
      } else if (!isStdinTty()) {
        stdinContent = await readStdin();
        const resolved = resolveKeyValue(keyOrKeyValue, stdinContent);
        if ("error" in resolved) {
          throw new UserError(resolved.error);
        }
        key = resolved.key;
        value = resolved.value;
      } else if (cliCtx.outputMode === "log") {
        key = keyOrKeyValue;
        if (key.length === 0) {
          throw new UserError("Key cannot be empty");
        }
        try {
          value = await readSecretFromTty(`Enter value for ${key}: `);
        } catch (err) {
          if (err instanceof Error && err.message === "Cancelled.") {
            renderVaultPutCancelled(cliCtx.outputMode);
            return;
          }
          throw err;
        }
      } else {
        const resolved = resolveKeyValue(keyOrKeyValue, null);
        if ("error" in resolved) {
          throw new UserError(resolved.error);
        }
        key = resolved.key;
        value = resolved.value;
      }
    }
    cliCtx.logger.debug`Parsed key: ${key}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultPutDeps(repoDir, repoContext.eventBus);

    // Phase 1: Preview — check vault existence and whether secret exists
    let preview;
    try {
      preview = await vaultPutPreview(ctx, deps, vaultName, key);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    // Phase 2: Prompt on overwrite
    if (preview.secretExists && cliCtx.outputMode === "log" && !options.force) {
      if (stdinContent !== null) {
        throw new UserError(
          `Secret '${key}' already exists in vault '${vaultName}'.\n` +
            `Use --force (-f) to overwrite when piping from stdin.`,
        );
      }
      const confirmed = await promptConfirmation(
        `Secret '${key}' already exists in vault '${vaultName}'. Overwrite?`,
      );
      if (!confirmed) {
        renderVaultPutCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 3: Execute mutation
    const renderer = createVaultPutRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultPut(ctx, deps, {
        vaultName,
        key,
        value,
        overwritten: preview.secretExists,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault put command completed");
  });
