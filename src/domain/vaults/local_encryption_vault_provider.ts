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

import { join } from "@std/path";
import type { VaultProvider } from "./vault_provider.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";

/**
 * Configuration options for local encryption vault.
 */
export interface LocalEncryptionConfig {
  /** Path to SSH private key file (defaults to ~/.ssh/id_rsa) */
  ssh_key_path?: string;
  /** Auto-generate an encryption key if no SSH key specified */
  auto_generate?: boolean;
  /** Custom path for auto-generated key file (defaults to computed secrets dir/.key) */
  key_file?: string;
  /** Base directory for the repository (defaults to current working directory) */
  base_dir?: string;
}

/**
 * Encrypted data format stored in files.
 */
interface EncryptedData {
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded encrypted data */
  data: string;
  /** Salt used for key derivation (base64) */
  salt: string;
  /** Format version for future compatibility */
  version: number;
}

/**
 * Local encryption vault provider that stores encrypted secrets in local files.
 * Uses Web Crypto API with AES-GCM encryption and SSH key-based key derivation.
 * Supports both SSH private key files and auto-generated encryption keys.
 */
export class LocalEncryptionVaultProvider implements VaultProvider {
  private readonly name: string;
  private readonly config: LocalEncryptionConfig;
  private readonly vaultDir: string;
  /** Cache for key material (not the derived key, since each secret has unique salt) */
  private keyMaterialCache?: CryptoKey;

  constructor(name: string, config: LocalEncryptionConfig = {}) {
    this.name = name;
    this.config = config;
    // Compute secrets directory from base_dir + vault name
    // Path: {base_dir}/.swamp/secrets/local_encryption/{vault_name}
    const baseDir = config.base_dir ?? Deno.cwd();
    this.vaultDir = swampPath(
      baseDir,
      SWAMP_SUBDIRS.secrets,
      "local_encryption",
      name,
    );
  }

  async get(secretKey: string): Promise<string> {
    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);

    try {
      const encryptedContent = await Deno.readTextFile(encryptedFilePath);
      const encryptedData: EncryptedData = JSON.parse(encryptedContent);

      const masterKey = await this.getMasterKey(encryptedData.salt);
      const decryptedValue = await this.decrypt(encryptedData, masterKey);

      return decryptedValue;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(
          `Secret '${secretKey}' not found in local vault '${this.name}'`,
        );
      }
      throw new Error(
        `Failed to retrieve secret '${secretKey}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    await this.ensureVaultDirectory();

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const masterKey = await this.getMasterKey(this.arrayBufferToBase64(salt));
    const encryptedData = await this.encrypt(secretValue, masterKey, salt);

    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);
    await Deno.writeTextFile(
      encryptedFilePath,
      JSON.stringify(encryptedData, null, 2),
    );
  }

  getName(): string {
    return this.name;
  }

  async list(): Promise<string[]> {
    const secretKeys: string[] = [];

    try {
      for await (const entry of Deno.readDir(this.vaultDir)) {
        if (entry.isFile && entry.name.endsWith(".enc")) {
          // Remove the .enc extension to get the secret key name
          const keyName = entry.name.slice(0, -4);
          secretKeys.push(keyName);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Vault directory doesn't exist yet, return empty list
        return [];
      }
      throw new Error(
        `Failed to list secrets in local vault '${this.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return secretKeys.sort();
  }

  /**
   * Derives the master encryption key for a specific salt.
   * Note: Each secret has a unique salt, so we cannot cache the derived key.
   * We cache the key material instead to avoid repeated file reads.
   */
  private async getMasterKey(saltBase64: string): Promise<CryptoKey> {
    const keyMaterial = await this.getKeyMaterial();
    const salt = this.base64ToArrayBuffer(saltBase64);

    // Derive AES key using PBKDF2 from SSH key or generated key
    // Each salt produces a unique derived key, so this must be done per-secret
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );

    return key;
  }

  /**
   * Gets the key material from SSH key or auto-generated key.
   * Key material is cached to avoid repeated file reads.
   */
  private async getKeyMaterial(): Promise<CryptoKey> {
    // Return cached key material if available
    if (this.keyMaterialCache) {
      return this.keyMaterialCache;
    }

    const keyMaterial = await this.loadKeyMaterial();
    this.keyMaterialCache = keyMaterial;
    return keyMaterial;
  }

  /**
   * Loads key material from SSH key or auto-generated key file.
   */
  private async loadKeyMaterial(): Promise<CryptoKey> {
    // Try SSH key if explicitly configured
    if (this.config.ssh_key_path) {
      try {
        const expandedPath = this.config.ssh_key_path.startsWith("~/")
          ? this.config.ssh_key_path.replace("~/", `${Deno.env.get("HOME")}/`)
          : this.config.ssh_key_path;

        const sshKeyContent = await Deno.readTextFile(expandedPath);
        const keyBytes = new TextEncoder().encode(sshKeyContent);

        return await crypto.subtle.importKey(
          "raw",
          keyBytes,
          { name: "PBKDF2" },
          false,
          ["deriveKey"],
        );
      } catch (error) {
        if (!this.config.auto_generate) {
          throw new Error(
            `Failed to read SSH key from '${this.config.ssh_key_path}' for local vault '${this.name}': ${
              error instanceof Error ? error.message : String(error)
            }. Set 'ssh_key_path' to a valid SSH private key or enable 'auto_generate'.`,
          );
        }
        // Fall through to auto-generation if SSH key fails and auto_generate is enabled
      }
    }

    // Try default SSH key only if no explicit path and no auto_generate
    if (!this.config.ssh_key_path && !this.config.auto_generate) {
      const defaultSshKeyPath = "~/.ssh/id_rsa";
      try {
        const expandedPath = defaultSshKeyPath.replace(
          "~/",
          `${Deno.env.get("HOME")}/`,
        );
        const sshKeyContent = await Deno.readTextFile(expandedPath);
        const keyBytes = new TextEncoder().encode(sshKeyContent);

        return await crypto.subtle.importKey(
          "raw",
          keyBytes,
          { name: "PBKDF2" },
          false,
          ["deriveKey"],
        );
      } catch (error) {
        throw new Error(
          `Failed to read default SSH key from '${defaultSshKeyPath}' for local vault '${this.name}': ${
            error instanceof Error ? error.message : String(error)
          }. Set 'ssh_key_path' to a valid SSH private key or enable 'auto_generate'.`,
        );
      }
    }

    // Auto-generate key if SSH key not available or configured
    if (this.config.auto_generate) {
      const keyFile = this.config.key_file || join(this.vaultDir, ".key");

      try {
        // Try to read existing key
        const existingKey = await Deno.readTextFile(keyFile);
        return await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(existingKey),
          { name: "PBKDF2" },
          false,
          ["deriveKey"],
        );
      } catch {
        // Generate new key if it doesn't exist
        await this.ensureVaultDirectory();
        const generatedKey = crypto.randomUUID() + crypto.randomUUID(); // 72 chars
        await Deno.writeTextFile(keyFile, generatedKey, { mode: 0o600 });

        return await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(generatedKey),
          { name: "PBKDF2" },
          false,
          ["deriveKey"],
        );
      }
    }

    throw new Error(
      `No SSH key or auto-generated key configured for local vault '${this.name}'. ` +
        `Set 'ssh_key_path' to point to an SSH private key file or enable 'auto_generate' in vault configuration.`,
    );
  }

  /**
   * Encrypts a value using AES-GCM.
   */
  private async encrypt(
    value: string,
    key: CryptoKey,
    salt: Uint8Array,
  ): Promise<EncryptedData> {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const encodedValue = new TextEncoder().encode(value);

    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      encodedValue,
    );

    return {
      iv: this.arrayBufferToBase64(iv),
      data: this.arrayBufferToBase64(encrypted),
      salt: this.arrayBufferToBase64(salt),
      version: 1,
    };
  }

  /**
   * Decrypts encrypted data using AES-GCM.
   */
  private async decrypt(
    encryptedData: EncryptedData,
    key: CryptoKey,
  ): Promise<string> {
    const iv = this.base64ToArrayBuffer(encryptedData.iv);
    const data = this.base64ToArrayBuffer(encryptedData.data);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      data,
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Ensures the vault directory exists.
   */
  private async ensureVaultDirectory(): Promise<void> {
    try {
      await Deno.mkdir(this.vaultDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw new Error(
          `Failed to create vault directory '${this.vaultDir}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Converts ArrayBuffer to base64 string.
   */
  private arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Converts base64 string to ArrayBuffer.
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
