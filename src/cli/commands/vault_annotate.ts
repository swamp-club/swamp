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
  createVaultAnnotateDeps,
  vaultAnnotate,
  type VaultAnnotateData,
  type VaultAnnotateInput,
} from "../../libswamp/mod.ts";
import { createVaultAnnotateRenderer } from "../../presentation/renderers/vault_annotate.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireVaultSync,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  VaultAnnotatePayload,
  VaultAnnotateResponse,
} from "../../serve/protocol.ts";

export function parseLabels(
  labels: string[] | undefined,
): Record<string, string> | undefined {
  if (!labels || labels.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const label of labels) {
    const eqIndex = label.indexOf("=");
    if (eqIndex === -1) {
      throw new UserError(
        `Invalid label format: '${label}'. Expected key=value.`,
      );
    }
    const key = label.substring(0, eqIndex);
    const value = label.substring(eqIndex + 1);
    if (key.length === 0) {
      throw new UserError(
        `Invalid label: key cannot be empty in '${label}'.`,
      );
    }
    result[key] = value;
  }
  return result;
}

export interface VaultAnnotateFlags {
  url?: string;
  notes?: string;
  label?: string[];
  removeLabel?: string[];
  clear?: boolean;
}

/**
 * Validates the annotate flags and builds the input shared by the local
 * path and the `--server` request, so both reject the same combinations.
 */
export function buildVaultAnnotateInput(
  vaultName: string,
  key: string,
  flags: VaultAnnotateFlags,
): VaultAnnotateInput {
  const clear = flags.clear === true;
  const labels = parseLabels(flags.label);
  const { url, notes } = flags;
  const removeLabels = flags.removeLabel;

  if (
    clear &&
    (url !== undefined || notes !== undefined ||
      labels !== undefined || removeLabels !== undefined)
  ) {
    throw new UserError(
      "--clear cannot be combined with --url, --notes, --label, or --remove-label. Use --clear alone to remove all annotations.",
    );
  }

  if (
    !clear && url === undefined && notes === undefined &&
    labels === undefined && removeLabels === undefined
  ) {
    throw new UserError(
      "No annotation fields specified. Use --url, --notes, --label, --remove-label, or --clear.",
    );
  }

  return { vaultName, key, url, notes, labels, removeLabels, clear };
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultAnnotateCommand = withRemoteOptions(
  new Command()
    .name("annotate")
    .description(
      `Annotate a vault secret with metadata.

Attaches provenance metadata (URL, notes, labels) to an existing secret.
Annotations use merge semantics: only the fields you specify are updated,
existing fields are preserved. Use --clear to remove all annotations.`,
    )
    .arguments("<vault_name:string> <key:string>")
    .example(
      "Add a URL and notes",
      'swamp vault annotate my-vault API_KEY --url https://console.aws.com/iam --notes "Production API key"',
    )
    .example(
      "Add labels",
      "swamp vault annotate my-vault API_KEY --label env=prod --label team=infra",
    )
    .example(
      "Clear all annotations",
      "swamp vault annotate my-vault API_KEY --clear",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--url <url:string>", "URL associated with this secret")
    .option("--notes <notes:string>", "Free-text notes about this secret")
    .option(
      "--label <label:string>",
      "Key=value label (repeatable)",
      { collect: true },
    )
    .option("--clear", "Remove all annotations from this secret")
    .option(
      "--remove-label <key:string>",
      "Remove a label by key (repeatable)",
      { collect: true },
    ),
).action(async function (
  options: AnyOptions,
  vaultName: string,
  key: string,
) {
  const cliCtx = createContext(options as GlobalOptions, [
    "vault",
    "annotate",
  ]);
  cliCtx.logger.debug`Annotating secret in vault: ${vaultName}`;

  const input = buildVaultAnnotateInput(vaultName, key, options);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<VaultAnnotateResponse>(
      { server, token },
      {
        type: "vault.annotate",
        payload: input satisfies VaultAnnotatePayload,
      },
    );
    const renderer = createVaultAnnotateRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as VaultAnnotateData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  const { repoDir, repoContext, datastoreConfig, syncService, vaultsDir } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });
  const { flush } = await acquireVaultSync(
    datastoreConfig,
    syncService,
    repoDir,
  );

  try {
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultAnnotateDeps(repoDir, repoContext.eventBus, {
      vaultsDir,
    });

    const renderer = createVaultAnnotateRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultAnnotate(ctx, deps, input),
      renderer.handlers(),
    );
  } finally {
    await flush();
  }
});
