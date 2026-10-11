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
 * The local_encryption config fields that decide where the vault's key
 * material comes from and where its secrets are stored on the host. Unset
 * ssh_key_path with auto_generate unset or false reads the host's default
 * SSH key, so auto_generate is one of them too.
 *
 * A remote caller (swamp serve) must not choose these: they name files on
 * the machine running swamp, not on the caller's (swamp-club#2690).
 */
export const LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS = [
  "base_dir",
  "key_file",
  "ssh_key_path",
  "auto_generate",
] as const;

export type LocalEncryptionKeySourceField =
  typeof LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS[number];

/**
 * Whether a vault type is the built-in local_encryption type. Vault types
 * resolve case-insensitively, so this does too.
 */
export function isLocalEncryptionType(type: string): boolean {
  return type.toLowerCase() === "local_encryption";
}

/**
 * The key source a server applies when the caller cannot choose one: an
 * auto-generated key stored with the secrets under the server's repo.
 */
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
 * The key-source fields whose value in `config` differs from `reference`.
 * A field unset in both is unchanged. Values compare strictly, so anything
 * other than an identical primitive counts as changed. Returns field names
 * only, never values: the values are host paths.
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
 * The key-source fields `config` sets to something other than the server
 * default: the ones a remote caller may not supply.
 *
 * `base_dir` must equal `repoDir` as a string. An equivalent spelling (a
 * trailing slash, `..`, a symlinked prefix) is refused on purpose: the
 * caller can leave the field out, and normalizing here would put path
 * resolution on the security decision.
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
 * The config swamp stores for a local_encryption vault whose key source
 * nobody chose: an auto-generated key. `base_dir` is left unset so the
 * stored config names no host path; it resolves to the repository the vault
 * is loaded from (see {@link withRuntimeBaseDir}).
 */
export function defaultLocalEncryptionConfig(): Record<string, unknown> {
  return { auto_generate: true };
}

/**
 * `config` with the server's default key source in place of whatever key
 * source it names, in the form it is stored: every key-source field is
 * replaced by {@link defaultLocalEncryptionConfig}, so `base_dir` is left
 * unset and resolves to the server's repo when the vault loads.
 */
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
 * The config a vault provider is built from: for a local_encryption vault
 * whose `base_dir` is unset or empty, `config` with `base_dir` set to
 * `repoDir`; otherwise `config` unchanged. Every place that builds a
 * local_encryption provider from a stored config goes through this, so an
 * unset `base_dir` always means the repository and never the process's
 * working directory.
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
