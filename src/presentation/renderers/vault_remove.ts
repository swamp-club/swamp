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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  VaultRemoveEvent,
  VaultRemovePreview,
} from "../../libswamp/vaults/remove.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultRemoveRenderer implements Renderer<VaultRemoveEvent> {
  handlers(): EventHandlers<VaultRemoveEvent> {
    const logger = getSwampLogger(["vault", "remove"]);
    return {
      removing: () => {},
      completed: (e) => {
        const { data } = e;
        logger.info`Removed vault ${data.vaultName} (${data.vaultType})`;
        const secrets = data.secrets;
        if (!secrets) {
          logger
            .info`Only the local config was removed; secrets stored by ${data.vaultType} were left in place`;
        } else if (secrets.keptOutsideRepository) {
          logger
            .warn`Kept ${secrets.secretCount} secret(s) in ${secrets.directory}: it lies outside this repository`;
        } else if (secrets.removed) {
          logger
            .info`Deleted ${secrets.directory} and the ${secrets.secretCount} secret(s) it held`;
        } else {
          logger.info`The vault had no stored secrets`;
        }
        for (const ref of data.forcedReferences) {
          logger
            .warn`Still referenced by ${ref.kind} ${ref.name} (${ref.via}); it will fail until the reference is removed`;
        }
        for (const ref of data.possibleReferences) {
          logger
            .warn`${ref.kind} ${ref.name} computes a vault name at run time and may have used this vault`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonVaultRemoveRenderer implements Renderer<VaultRemoveEvent> {
  handlers(): EventHandlers<VaultRemoveEvent> {
    return {
      removing: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultRemoveRenderer(
  mode: OutputMode,
): Renderer<VaultRemoveEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultRemoveRenderer();
    case "log":
      return new LogVaultRemoveRenderer();
  }
}

/**
 * Says what the removal will destroy, before the confirmation prompt. Only
 * log mode prompts, so only log mode warns.
 */
export function renderVaultRemoveWarnings(
  preview: VaultRemovePreview,
  mode: OutputMode,
): void {
  if (mode !== "log") return;
  const logger = getSwampLogger(["vault", "remove"]);
  const storage = preview.localStorage;
  if (!storage) {
    logger
      .info`Only the local config of vault ${preview.vaultName} (${preview.vaultType}) is removed; its secrets stay with the provider.`;
  } else if (!storage.removable) {
    logger
      .warn`The secrets of vault ${preview.vaultName} in ${storage.directory} lie outside this repository and will be kept.`;
  } else {
    logger
      .warn`This permanently deletes ${storage.directory} and the ${storage.secretCount} secret(s) it holds. This cannot be undone.`;
  }
  for (const ref of preview.references) {
    logger
      .warn`Still referenced by ${ref.kind} ${ref.name} (${ref.via}); --force removes the vault anyway.`;
  }
  for (const ref of preview.possibleReferences) {
    logger
      .warn`${ref.kind} ${ref.name} computes a vault name at run time and may use this vault.`;
  }
}

export function renderVaultRemoveCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["vault", "remove"]);
    logger.info("Operation cancelled.");
  }
}
