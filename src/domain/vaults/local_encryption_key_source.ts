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
 * these decide where key material comes from and secrets are stored; a remote
 * caller must not choose them, since they name files on the server's machine
 */
export const LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS = [
  "base_dir",
  "key_file",
  "ssh_key_path",
  "auto_generate",
] as const;

export type LocalEncryptionKeySourceField =
  typeof LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS[number];

/** vault types resolve case-insensitively, so this does too */
export function isLocalEncryptionType(type: string): boolean {
  return type.toLowerCase() === "local_encryption";
}

export function serverDefaultKeySource(
  repoDir: string,
): Record<LocalEncryptionKeySourceField, unknown> {
  return {
    base_dir: repoDir,
    key_file: undefined,
    ssh_key_path: undefined,
    auto_generate: true,
  };
}

/**
 * returns field names only, never values, since the values are host paths;
 * values compare strictly
 */
export function findChangedKeySourceFields(
  config: Record<string, unknown>,
  reference: Record<string, unknown>,
): LocalEncryptionKeySourceField[] {
  return LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS.filter((field) =>
    ownValue(config, field) !== ownValue(reference, field)
  );
}

/**
 * base_dir must equal repoDir as a string; equivalent spellings are refused on
 * purpose since normalizing would put path resolution on the security decision
 */
export function findNonDefaultKeySourceFields(
  config: Record<string, unknown>,
  repoDir: string,
): LocalEncryptionKeySourceField[] {
  const defaults = serverDefaultKeySource(repoDir);
  return LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS.filter((field) => {
    const value = ownValue(config, field);
    return value !== undefined && value !== defaults[field];
  });
}

/**
 * base_dir is left unset so the stored config names no host path and resolves
 * to the repository the vault loads from
 */
export function defaultLocalEncryptionConfig(): Record<string, unknown> {
  return { auto_generate: true };
}

export function withServerDefaultKeySource(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...config };
  for (const field of LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS) {
    delete result[field];
  }
  return { ...result, ...defaultLocalEncryptionConfig() };
}

/**
 * every place that builds a local_encryption provider from stored config goes
 * through this, so an unset base_dir means the repository, never the working
 * directory
 */
export function withRuntimeBaseDir(
  type: string,
  config: Record<string, unknown>,
  repoDir: string,
): Record<string, unknown> {
  if (!isLocalEncryptionType(type) || config.base_dir) return config;
  return { ...config, base_dir: repoDir };
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
