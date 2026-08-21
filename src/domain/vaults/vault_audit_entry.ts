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

export type VaultAuditAction = "get" | "put" | "delete" | "annotate";

export interface VaultAuditEntry {
  readonly action: VaultAuditAction;
  readonly timestamp: string;
  readonly vaultName: string;
  readonly vaultType: string;
  readonly secretKey: string;
  readonly callerContext: string;
}

export interface VaultAuditEntryData {
  action?: VaultAuditAction;
  timestamp: string;
  vaultName: string;
  vaultType: string;
  secretKey: string;
  callerContext: string;
}

export function createVaultAuditEntry(
  action: VaultAuditAction,
  vaultName: string,
  vaultType: string,
  secretKey: string,
  callerContext: string,
): VaultAuditEntry {
  return {
    action,
    timestamp: new Date().toISOString(),
    vaultName,
    vaultType,
    secretKey,
    callerContext,
  };
}

export function vaultAuditEntryFromData(
  data: VaultAuditEntryData,
): VaultAuditEntry {
  return {
    action: data.action ?? "get",
    timestamp: data.timestamp,
    vaultName: data.vaultName,
    vaultType: data.vaultType,
    secretKey: data.secretKey,
    callerContext: data.callerContext,
  };
}

export function vaultAuditEntryToData(
  entry: VaultAuditEntry,
): VaultAuditEntryData {
  return {
    action: entry.action,
    timestamp: entry.timestamp,
    vaultName: entry.vaultName,
    vaultType: entry.vaultType,
    secretKey: entry.secretKey,
    callerContext: entry.callerContext,
  };
}
