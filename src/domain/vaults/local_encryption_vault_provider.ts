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
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import type { VaultProvider } from "./vault_provider.ts";
import type { VaultAnnotationProvider } from "./vault_annotation.ts";
import { VaultAnnotation } from "./vault_annotation.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { assertSafePath } from "../../infrastructure/persistence/safe_path.ts";
import { checkFileNotBroadlyReadable } from "../../infrastructure/security/file_security_check.ts";

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
export class LocalEncryptionVaultProvider
  implements VaultProvider, VaultAnnotationProvider {
  private readonly name: string;
  private readonly config: LocalEncryptionConfig;
  private readonly vaultDir: string;
  private readonly secretsBoundary: string;
  /** Cache for key material (not the derived key, since each secret has unique salt) */
  private keyMaterialCache?: CryptoKey;

  constructor(name: string, config: LocalEncryptionConfig = {}) {
    this.name = name;
    this.config = config;
    // Compute secrets directory from base_dir + vault name
    // Path: {base_dir}/.swamp/secrets/local_encryption/{vault_name}
    const baseDir = config.base_dir ?? Deno.cwd();
    this.secretsBoundary = swampPath(baseDir);
    this.vaultDir = swampPath(
      baseDir,
      SWAMP_SUBDIRS.secrets,
      "local_encryption",
      name,
    );
  }

  async get(secretKey: string): Promise<string> {
    this.validateSecretKey(secretKey);
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
    this.validateSecretKey(secretKey);
    await this.ensureVaultDirectory();

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const masterKey = await this.getMasterKey(this.arrayBufferToBase64(salt));
    const encryptedData = await this.encrypt(secretValue, masterKey, salt);

    const encryptedFilePath = join(this.vaultDir, `${secretKey}.enc`);
    await assertSafePath(encryptedFilePath, this.secretsBoundary);
    await atomicWriteTextFile(
      encryptedFilePath,
      JSON.stringify(encryptedData, null, 2),
      { mode: 0o600 },
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

  private get annotationsDir(): string {
    return join(this.vaultDir, ".annotations");
  }

  private annotationPath(secretKey: string): string {
    return join(this.annotationsDir, `${secretKey}.enc`);
  }

  async getAnnotation(secretKey: string): Promise<VaultAnnotation | null> {
    this.validateSecretKey(secretKey);
    const metaPath = this.annotationPath(secretKey);

    try {
      const encryptedContent = await Deno.readTextFile(metaPath);
      const encryptedData: EncryptedData = JSON.parse(encryptedContent);
      const masterKey = await this.getMasterKey(encryptedData.salt);
      const json = await this.decrypt(encryptedData, masterKey);
      return VaultAnnotation.fromData(JSON.parse(json));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw new Error(
        `Failed to read annotation for '${secretKey}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async putAnnotation(
    secretKey: string,
    annotation: VaultAnnotation,
  ): Promise<void> {
    this.validateSecretKey(secretKey);
    await this.ensureAnnotationsDirectory();

    const json = JSON.stringify(annotation.toData());
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const masterKey = await this.getMasterKey(this.arrayBufferToBase64(salt));
    const encryptedData = await this.encrypt(json, masterKey, salt);

    const metaPath = this.annotationPath(secretKey);
    await assertSafePath(metaPath, this.secretsBoundary);
    await atomicWriteTextFile(
      metaPath,
      JSON.stringify(encryptedData, null, 2),
      { mode: 0o600 },
    );
  }

  async deleteAnnotation(secretKey: string): Promise<void> {
    this.validateSecretKey(secretKey);
    const metaPath = this.annotationPath(secretKey);
    await assertSafePath(metaPath, this.secretsBoundary);
    try {
      await Deno.remove(metaPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(
          `Failed to delete annotation for '${secretKey}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async listAnnotations(): Promise<Map<string, VaultAnnotation>> {
    const annotations = new Map<string, VaultAnnotation>();
    try {
      for await (const entry of Deno.readDir(this.annotationsDir)) {
        if (entry.isFile && entry.name.endsWith(".enc")) {
          const keyName = entry.name.slice(0, -4);
          const annotation = await this.getAnnotation(keyName);
          if (annotation) {
            annotations.set(keyName, annotation);
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return annotations;
      }
      throw new Error(
        `Failed to list annotations in vault '${this.name}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return annotations;
  }

  private async ensureAnnotationsDirectory(): Promise<void> {
    const dir = this.annotationsDir;
    await assertSafePath(dir, this.secretsBoundary);
    try {
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw new Error(
          `Failed to create annotations directory '${dir}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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
        return await this.readAndValidateSshKey(this.config.ssh_key_path);
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
        return await this.readAndValidateSshKey(defaultSshKeyPath);
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
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
        // Key file doesn't exist — generate a new one with exclusive creation
        await this.ensureVaultDirectory();
        const generatedKey = crypto.randomUUID() + crypto.randomUUID(); // 72 chars

        try {
          // createNew: true uses O_CREAT | O_EXCL — atomic exclusive creation
          // prevents TOCTOU race where two processes both generate different keys.
          // Use open + write + close so we control when the handle is released.
          const file = await Deno.open(keyFile, {
            write: true,
            createNew: true,
            mode: 0o600,
          });
          try {
            await file.write(new TextEncoder().encode(generatedKey));
          } finally {
            file.close();
          }
          return await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(generatedKey),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
          );
        } catch (writeError) {
          if (!(writeError instanceof Deno.errors.AlreadyExists)) {
            throw writeError;
          }
          // Another process won the race — read back their key.
          // The winner may still be writing (file created but content not
          // flushed), so retry until content is available.
          let winnerKey = "";
          for (let attempt = 0; attempt < 20; attempt++) {
            winnerKey = await Deno.readTextFile(keyFile);
            if (winnerKey.length > 0) break;
            await new Promise<void>((r) => setTimeout(r, 5));
          }
          if (!winnerKey) {
            throw new Error(
              `Key file '${keyFile}' exists but is empty — ` +
                `concurrent key generation may have failed`,
            );
          }
          return await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(winnerKey),
            { name: "PBKDF2" },
            false,
            ["deriveKey"],
          );
        }
      }
    }

    throw new Error(
      `No SSH key or auto-generated key configured for local vault '${this.name}'. ` +
        `Set 'ssh_key_path' to point to an SSH private key file or enable 'auto_generate' in vault configuration.`,
    );
  }

  /**
   * Reads an SSH private key file, validates its permissions and encryption
   * status, extracts binary key material from the PEM envelope, and imports
   * it as PBKDF2 key material.
   */
  private async readAndValidateSshKey(
    sshKeyPath: string,
  ): Promise<CryptoKey> {
    const expandedPath = sshKeyPath.startsWith("~/")
      ? sshKeyPath.replace("~/", `${Deno.env.get("HOME")}/`)
      : sshKeyPath;

    await this.validateSshKeyPermissions(expandedPath);
    const content = await Deno.readTextFile(expandedPath);

    // Detect PEM encryption before extraction (text-based check avoids
    // base64 decode failures on header lines like Proc-Type)
    this.detectEncryptedPemKey(content);

    const decodedBytes = this.extractPemKeyMaterial(content);

    // Detect OpenSSH encryption after extraction (needs decoded bytes
    // to read the binary cipher name field)
    this.detectEncryptedOpenSshKey(decodedBytes);

    return await crypto.subtle.importKey(
      "raw",
      decodedBytes.buffer as ArrayBuffer,
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
  }

  /**
   * Extracts the binary key material from a PEM-encoded SSH key.
   * Strips the PEM header/footer lines and decodes the base64 body,
   * returning only the raw key bytes for use as PBKDF2 input.
   */
  private extractPemKeyMaterial(content: string): Uint8Array {
    const lines = content.split(/\r?\n/);
    const base64Lines = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("-----");
    });
    const base64String = base64Lines.join("");
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Validates that an SSH key file is not broadly readable. On POSIX this
   * enforces `0o600` (no group/other bits). On Windows it shells out to
   * `icacls` and rejects any ACE granting Read or higher to broad
   * principals (Everyone, Authenticated Users, etc.). The detailed scope
   * of the Windows check lives in `file_security_check.ts`.
   */
  private async validateSshKeyPermissions(path: string): Promise<void> {
    const result = await checkFileNotBroadlyReadable(path);
    if (!result.ok) {
      // Prefix the reason with "SSH key " so the message remains compatible
      // with the historical `SSH key '<path>' has insecure permissions ...`
      // format that other code and tests expect.
      throw new Error(`SSH key ${result.reason}`);
    }
  }

  /**
   * Detects passphrase-encrypted legacy PEM keys (RSA/DSA/EC) by checking
   * for the Proc-Type encryption header.
   */
  private detectEncryptedPemKey(content: string): void {
    if (content.includes("Proc-Type: 4,ENCRYPTED")) {
      throw new Error(
        `SSH key is encrypted (legacy PEM format). ` +
          `Swamp cannot use passphrase-protected SSH keys for vault encryption. ` +
          `Use an unencrypted SSH key or enable 'auto_generate' in vault configuration.`,
      );
    }
  }

  /**
   * Detects passphrase-encrypted OpenSSH keys by reading the cipher name
   * from the binary key format (magic "openssh-key-v1\0", then uint32
   * length-prefixed cipher name). Only rejects confirmed encrypted keys;
   * parsing failures are silently allowed through.
   */
  private detectEncryptedOpenSshKey(decodedBytes: Uint8Array): void {
    const magic = new TextEncoder().encode("openssh-key-v1\0");

    // Verify we have enough bytes and the magic matches
    if (decodedBytes.length < magic.length + 4) return;
    for (let i = 0; i < magic.length; i++) {
      if (decodedBytes[i] !== magic[i]) return;
    }

    // Read cipher name length (uint32 big-endian)
    const offset = magic.length;
    const cipherNameLen = (decodedBytes[offset] << 24) |
      (decodedBytes[offset + 1] << 16) |
      (decodedBytes[offset + 2] << 8) |
      decodedBytes[offset + 3];

    if (offset + 4 + cipherNameLen > decodedBytes.length) return;
    const cipherName = new TextDecoder().decode(
      decodedBytes.slice(offset + 4, offset + 4 + cipherNameLen),
    );

    if (cipherName !== "none") {
      throw new Error(
        `SSH key is encrypted (cipher: ${cipherName}). ` +
          `Swamp cannot use passphrase-protected SSH keys for vault encryption. ` +
          `Use an unencrypted SSH key or enable 'auto_generate' in vault configuration.`,
      );
    }
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
      version: 2,
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
   * Validates that a secret key does not contain path traversal characters.
   * Rejects keys containing '..', '/', '\', or null bytes to prevent
   * file operations outside the vault directory.
   */
  private validateSecretKey(secretKey: string): void {
    if (
      secretKey.includes("..") ||
      secretKey.includes("/") ||
      secretKey.includes("\\") ||
      secretKey.includes("\0")
    ) {
      throw new Error(
        `Invalid secret key '${secretKey}': must not contain '..', '/', '\\', or null bytes`,
      );
    }
  }

  /**
   * Ensures the vault directory exists.
   */
  private async ensureVaultDirectory(): Promise<void> {
    await assertSafePath(this.vaultDir, this.secretsBoundary);
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
