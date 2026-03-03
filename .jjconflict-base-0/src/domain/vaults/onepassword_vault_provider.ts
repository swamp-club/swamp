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

import type { VaultProvider } from "./vault_provider.ts";

/**
 * Configuration for the 1Password vault provider.
 */
export interface OnePasswordVaultConfig {
  /** 1Password vault name (required) */
  op_vault: string;
  /** Account shorthand for multi-account setups (optional) */
  op_account?: string;
}

/**
 * Parsed representation of a 1Password secret key.
 */
export interface ParsedSecretKey {
  /** The item name in 1Password */
  item: string;
  /** The field path (e.g., "password", "token", "connection/host") */
  field: string;
  /** Whether the key was a full op:// URI passthrough */
  isFullUri: boolean;
  /** The full op:// URI to use with `op read` */
  uri: string;
}

/**
 * Parses a secret key into its 1Password components.
 *
 * Mapping rules:
 * - Full `op://` URI → passed through directly
 * - `item` (no slash) → `op://vault/item/password` (default field)
 * - `item/field` → `op://vault/item/field`
 * - `item/section/field` → `op://vault/item/section/field`
 */
export function parseSecretKey(
  secretKey: string,
  opVault: string,
): ParsedSecretKey {
  // Full op:// URI passthrough
  if (secretKey.startsWith("op://")) {
    // Extract item and field from the URI for metadata
    const uriPath = secretKey.slice("op://".length);
    const parts = uriPath.split("/");
    // op://vault/item/field... → item is parts[1], field is the rest
    const item = parts[1] ?? "";
    const field = parts.slice(2).join("/") || "password";
    return {
      item,
      field,
      isFullUri: true,
      uri: secretKey,
    };
  }

  // Split on first "/" to get item and field path
  const slashIndex = secretKey.indexOf("/");
  if (slashIndex === -1) {
    // No slash → item name only, default field to "password"
    return {
      item: secretKey,
      field: "password",
      isFullUri: false,
      uri: `op://${opVault}/${secretKey}/password`,
    };
  }

  const item = secretKey.slice(0, slashIndex);
  const field = secretKey.slice(slashIndex + 1);

  return {
    item,
    field,
    isFullUri: false,
    uri: `op://${opVault}/${secretKey}`,
  };
}

/**
 * 1Password vault provider.
 *
 * Uses the 1Password CLI (`op`) for secret operations. Supports authentication
 * via service account tokens (OP_SERVICE_ACCOUNT_TOKEN), desktop app biometric
 * unlock, or 1Password Connect Server.
 */
export class OnePasswordVaultProvider implements VaultProvider {
  private readonly name: string;
  private readonly opVault: string;
  private readonly opAccount: string | undefined;
  private opInstalled: boolean | undefined;

  constructor(name: string, config: OnePasswordVaultConfig) {
    if (!config.op_vault) {
      throw new Error(
        "1Password vault name is required. Ensure op_vault is set in the vault configuration.",
      );
    }

    this.name = name;
    this.opVault = config.op_vault;
    this.opAccount = config.op_account;
  }

  async get(secretKey: string): Promise<string> {
    await this.checkOpInstalled();

    const parsed = parseSecretKey(secretKey, this.opVault);
    const args = ["read", parsed.uri];
    if (this.opAccount) {
      args.push("--account", this.opAccount);
    }

    const result = await this.runOp(args);
    return result.trim();
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    await this.checkOpInstalled();

    const parsed = parseSecretKey(secretKey, this.opVault);

    if (parsed.isFullUri) {
      throw new Error(
        "Cannot use full op:// URI for put operations. Use a relative key (e.g., 'item-name' or 'item-name/field').",
      );
    }

    // Check if the item already exists
    const itemExists = await this.itemExists(parsed.item);

    if (itemExists) {
      // Update existing item's field
      const args = [
        "item",
        "edit",
        parsed.item,
        `${parsed.field}=${secretValue}`,
        "--vault",
        this.opVault,
      ];
      if (this.opAccount) {
        args.push("--account", this.opAccount);
      }
      await this.runOp(args);
    } else {
      // Create new item as a Secure Note with the field
      const args = [
        "item",
        "create",
        "--category",
        "Secure Note",
        "--title",
        parsed.item,
        `${parsed.field}=${secretValue}`,
        "--vault",
        this.opVault,
      ];
      if (this.opAccount) {
        args.push("--account", this.opAccount);
      }
      await this.runOp(args);
    }
  }

  async list(): Promise<string[]> {
    await this.checkOpInstalled();

    const args = [
      "item",
      "list",
      "--vault",
      this.opVault,
      "--format",
      "json",
    ];
    if (this.opAccount) {
      args.push("--account", this.opAccount);
    }

    const result = await this.runOp(args);

    if (!result.trim()) {
      return [];
    }

    const items: Array<{ title: string }> = JSON.parse(result);
    return items.map((item) => item.title).sort();
  }

  getName(): string {
    return this.name;
  }

  /**
   * Checks if a 1Password item exists in the configured vault.
   */
  private async itemExists(itemName: string): Promise<boolean> {
    const args = [
      "item",
      "get",
      itemName,
      "--vault",
      this.opVault,
      "--format",
      "json",
    ];
    if (this.opAccount) {
      args.push("--account", this.opAccount);
    }

    try {
      await this.runOp(args);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if the `op` CLI is installed and available.
   * Result is cached after the first successful check.
   */
  private async checkOpInstalled(): Promise<void> {
    if (this.opInstalled === true) {
      return;
    }

    try {
      const command = new Deno.Command("op", {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });
      const { success } = await command.output();
      if (success) {
        this.opInstalled = true;
        return;
      }
    } catch {
      // op not found
    }

    throw new Error(
      "1Password CLI (op) is not installed or not in PATH.\n\n" +
        "Install it from: https://developer.1password.com/docs/cli/get-started/\n\n" +
        "After installing, authenticate using one of:\n" +
        "  - Service account: export OP_SERVICE_ACCOUNT_TOKEN=<token>\n" +
        "  - Desktop app: enable CLI integration in 1Password settings\n" +
        "  - Connect Server: export OP_CONNECT_HOST and OP_CONNECT_TOKEN",
    );
  }

  /**
   * Runs an `op` CLI command and returns the stdout output.
   */
  private async runOp(args: string[]): Promise<string> {
    const command = new Deno.Command("op", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const { success, stdout, stderr } = await command.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    if (!success) {
      const errorMessage = stderrText.trim() || "Unknown error";

      // Detect common authentication errors
      if (
        errorMessage.includes("not signed in") ||
        errorMessage.includes("authorization") ||
        errorMessage.includes("authenticate")
      ) {
        throw new Error(
          `1Password authentication failed for vault '${this.name}'.\n\n` +
            `Authenticate using one of:\n` +
            `  - Service account: export OP_SERVICE_ACCOUNT_TOKEN=<token>\n` +
            `  - Desktop app: enable CLI integration in 1Password settings\n` +
            `  - Sign in: op signin\n\n` +
            `Error: ${errorMessage}`,
        );
      }

      // Detect vault not found
      if (
        errorMessage.includes("isn't a vault") ||
        errorMessage.includes("vault") && errorMessage.includes("not found")
      ) {
        throw new Error(
          `1Password vault '${this.opVault}' not found. Verify the vault name in your configuration.\n\n` +
            `Error: ${errorMessage}`,
        );
      }

      throw new Error(
        `1Password CLI error: ${errorMessage}`,
      );
    }

    return stdoutText;
  }
}
