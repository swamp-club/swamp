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

import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import type { VaultDeleteProvider, VaultProvider } from "./vault_provider.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type EncryptedBlob,
  exportAesKey,
  generateAesKey,
  importAesKey,
} from "../crypto/aes_gcm.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["vaults", "control-plane"]);

export const TOKEN_SECRETS_VAULT_NAME = "_token-secrets";

const ENCRYPTION_KEY_PATH = "token-secrets/encryption-key";
const SECRET_PREFIX = "token-secrets/values/";

export class ControlPlaneVaultProvider
  implements VaultProvider, VaultDeleteProvider {
  readonly #store: ControlPlaneStore;
  #key: CryptoKey | undefined;

  constructor(store: ControlPlaneStore) {
    this.#store = store;
  }

  async initialize(): Promise<void> {
    this.#key = await this.#bootstrapKey();
  }

  getName(): string {
    return TOKEN_SECRETS_VAULT_NAME;
  }

  async get(secretKey: string): Promise<string> {
    const key = this.#requireKey();
    const data = await this.#store.get(`${SECRET_PREFIX}${secretKey}`);
    if (data === null) {
      throw new Error(
        `Secret '${secretKey}' not found in ${TOKEN_SECRETS_VAULT_NAME}`,
      );
    }
    const blob: EncryptedBlob = JSON.parse(new TextDecoder().decode(data));
    return await aesGcmDecrypt(blob, key);
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    const key = this.#requireKey();
    const blob = await aesGcmEncrypt(secretValue, key);
    const encoded = new TextEncoder().encode(JSON.stringify(blob));
    await this.#store.put(`${SECRET_PREFIX}${secretKey}`, encoded);
  }

  async delete(secretKey: string): Promise<void> {
    await this.#store.delete(`${SECRET_PREFIX}${secretKey}`);
  }

  async list(): Promise<string[]> {
    const keys = await this.#store.list(SECRET_PREFIX);
    return keys.map((k) => k.slice(SECRET_PREFIX.length));
  }

  #requireKey(): CryptoKey {
    if (!this.#key) {
      throw new Error(
        "ControlPlaneVaultProvider not initialized — call initialize() first",
      );
    }
    return this.#key;
  }

  async #bootstrapKey(): Promise<CryptoKey> {
    const existing = await this.#store.get(ENCRYPTION_KEY_PATH);
    if (existing) {
      logger.debug`Loaded existing token encryption key`;
      return await importAesKey(new Uint8Array(existing));
    }

    const newKey = await generateAesKey();
    const exported = await exportAesKey(newKey);

    if (this.#store.putIfAbsent) {
      const won = await this.#store.putIfAbsent(ENCRYPTION_KEY_PATH, exported);
      if (won) {
        logger.info`Generated new token encryption key`;
        return newKey;
      }
      const theirs = await this.#store.get(ENCRYPTION_KEY_PATH);
      if (!theirs) {
        throw new Error(
          "Token encryption key disappeared after putIfAbsent race",
        );
      }
      logger.debug`Using token encryption key from another instance`;
      return await importAesKey(new Uint8Array(theirs));
    }

    // Fallback for stores without putIfAbsent. Safe for single-instance
    // deployments. Multi-instance deployments MUST use a store that
    // implements putIfAbsent (FileSystemControlPlaneStore and S3 both do).
    await this.#store.put(ENCRYPTION_KEY_PATH, exported);
    const readBack = await this.#store.get(ENCRYPTION_KEY_PATH);
    if (!readBack) {
      throw new Error("Token encryption key missing after write");
    }
    const readBackBytes = new Uint8Array(readBack);
    if (readBackBytes.length !== exported.length) {
      logger
        .warn`Token encryption key was overwritten by another instance, using theirs`;
      return await importAesKey(readBackBytes);
    }
    let same = true;
    for (let i = 0; i < exported.length; i++) {
      if (readBackBytes[i] !== exported[i]) {
        same = false;
        break;
      }
    }
    if (!same) {
      logger
        .warn`Token encryption key was overwritten by another instance, using theirs`;
      return await importAesKey(readBackBytes);
    }

    logger.info`Generated new token encryption key (no putIfAbsent support)`;
    return newKey;
  }
}
