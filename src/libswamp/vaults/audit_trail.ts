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

import type { VaultAuditEntry } from "../../domain/vaults/vault_audit_entry.ts";
import type {
  VaultAuditQueryOptions,
  VaultAuditRepository,
} from "../../domain/vaults/vault_audit_repository.ts";
import { JsonlVaultAuditRepository } from "../../infrastructure/persistence/jsonl_vault_audit_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultAuditTrailData {
  entries: VaultAuditEntry[];
  totalCount: number;
}

export type VaultAuditTrailEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultAuditTrailData }
  | { kind: "error"; error: SwampError };

export interface VaultAuditTrailInput {
  vaultName?: string;
  secretKey?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface VaultAuditTrailDeps {
  findByTimeRange: (
    startTime: Date,
    endTime: Date,
    options?: VaultAuditQueryOptions,
  ) => Promise<VaultAuditEntry[]>;
}

export function createVaultAuditTrailDeps(
  repoDir: string,
): VaultAuditTrailDeps {
  const repo: VaultAuditRepository = new JsonlVaultAuditRepository(repoDir);
  return {
    findByTimeRange: (startTime, endTime, options) =>
      repo.findByTimeRange(startTime, endTime, options),
  };
}

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 100;

export async function* vaultAuditTrail(
  ctx: LibSwampContext,
  deps: VaultAuditTrailDeps,
  input: VaultAuditTrailInput,
): AsyncIterable<VaultAuditTrailEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.audit_trail",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const now = new Date();
      const since = input.since ??
        new Date(
          now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        );
      const until = input.until ?? now;
      const limit = input.limit ?? DEFAULT_LIMIT;

      ctx.logger
        .debug`Querying vault audit trail: vault=${input.vaultName}, key=${input.secretKey}, since=${since.toISOString()}, until=${until.toISOString()}, limit=${limit}`;

      const entries = await deps.findByTimeRange(since, until, {
        vaultName: input.vaultName,
        secretKey: input.secretKey,
        limit,
      });

      yield {
        kind: "completed",
        data: {
          entries,
          totalCount: entries.length,
        },
      };
    })(),
  );
}
