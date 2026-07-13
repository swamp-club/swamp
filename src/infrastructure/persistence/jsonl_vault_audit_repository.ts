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

import { ensureDir } from "@std/fs";
import type {
  VaultAuditEntry,
  VaultAuditEntryData,
} from "../../domain/vaults/vault_audit_entry.ts";
import {
  vaultAuditEntryFromData,
  vaultAuditEntryToData,
} from "../../domain/vaults/vault_audit_entry.ts";
import { vaultAuditFilePathForTimestamp } from "../../domain/vaults/vault_audit_path.ts";
import type {
  VaultAuditQueryOptions,
  VaultAuditRepository,
} from "../../domain/vaults/vault_audit_repository.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

export class JsonlVaultAuditRepository implements VaultAuditRepository {
  private readonly baseDir: string;

  constructor(repoDir: string, baseDir?: string) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.audit);
  }

  async append(entry: VaultAuditEntry): Promise<void> {
    await ensureDir(this.baseDir);

    const path = vaultAuditFilePathForTimestamp(
      this.baseDir,
      entry.timestamp,
    );
    const line = JSON.stringify(vaultAuditEntryToData(entry)) + "\n";

    const file = await Deno.open(path, {
      write: true,
      create: true,
      append: true,
    });
    try {
      const encoder = new TextEncoder();
      await file.write(encoder.encode(line));
    } finally {
      file.close();
    }
  }

  async findByTimeRange(
    startTime: Date,
    endTime: Date,
    options?: VaultAuditQueryOptions,
  ): Promise<VaultAuditEntry[]> {
    const entries: VaultAuditEntry[] = [];

    try {
      const current = new Date(startTime);
      current.setUTCHours(0, 0, 0, 0);

      const end = new Date(endTime);
      end.setUTCHours(23, 59, 59, 999);

      while (current <= end) {
        const path = vaultAuditFilePathForTimestamp(
          this.baseDir,
          current.toISOString(),
        );

        try {
          const content = await Deno.readTextFile(path);
          const lines = content.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line) as VaultAuditEntryData;
              const entry = vaultAuditEntryFromData(data);

              const entryTime = new Date(entry.timestamp);
              if (entryTime < startTime || entryTime > endTime) continue;
              if (options?.vaultName && entry.vaultName !== options.vaultName) {
                continue;
              }
              if (options?.secretKey && entry.secretKey !== options.secretKey) {
                continue;
              }

              entries.push(entry);

              if (options?.limit && entries.length >= options.limit) {
                return entries;
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            if (Deno.env.get("SWAMP_DEBUG")) {
              console.error(
                `[VaultAudit] Failed to read ${path}:`,
                error,
              );
            }
          }
        }

        current.setUTCDate(current.getUTCDate() + 1);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[VaultAudit] Failed to read audit data:", error);
      }
    }

    return entries;
  }
}
