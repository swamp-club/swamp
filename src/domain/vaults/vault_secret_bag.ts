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

/**
 * VaultSecretBag is a value object that maps sentinel tokens to raw secret values.
 *
 * During vault expression resolution, secret values are replaced with unique
 * sentinel tokens (safe alphanumeric strings). The bag tracks the mapping so
 * that sentinels can be resolved later — either to raw values (for non-shell
 * contexts) or to environment variable references (for shell commands).
 */
export class VaultSecretBag {
  private readonly secrets = new Map<string, string>();
  private counter = 0;
  private readonly prefix: string;

  /** Pattern that matches any sentinel produced by this bag or any other. */
  static readonly SENTINEL_PATTERN = /__SWAMP_VSEC_[0-9a-f]{8}_\d+__/g;

  constructor() {
    this.prefix = crypto.getRandomValues(new Uint8Array(4))
      .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  }

  /**
   * Adds a secret and returns a unique sentinel token.
   * The sentinel is alphanumeric + underscores, safe in CEL strings and shell.
   */
  addSecret(value: string): string {
    const sentinel = `__SWAMP_VSEC_${this.prefix}_${this.counter++}__`;
    this.secrets.set(sentinel, value);
    return sentinel;
  }

  /** Whether this bag contains any secrets. */
  get isEmpty(): boolean {
    return this.secrets.size === 0;
  }

  /**
   * Replaces all sentinel tokens in a string with their raw secret values.
   * Use this for non-shell contexts where the value should be literal.
   */
  resolveRaw(str: string): string {
    let result = str;
    for (const [sentinel, value] of this.secrets) {
      result = result.split(sentinel).join(value);
    }
    return result;
  }

  /**
   * Recursively replaces all sentinel tokens in a data structure with raw values.
   */
  resolveDeep(data: unknown): unknown {
    if (typeof data === "string") {
      return this.resolveRaw(data);
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.resolveDeep(item));
    }
    if (data !== null && typeof data === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.resolveDeep(value);
      }
      return result;
    }
    return data;
  }

  /**
   * Replaces sentinel tokens in a shell command string with double-quoted
   * environment variable references, and returns the env var map.
   *
   * Shell variable expansion happens after command parsing, so metacharacters
   * in the secret value are never interpreted as shell syntax.
   */
  resolveForShell(
    command: string,
  ): { command: string; env: Record<string, string> } {
    const env: Record<string, string> = {};
    let result = command;
    let envIdx = 0;
    for (const [sentinel, value] of this.secrets) {
      if (result.includes(sentinel)) {
        const envName = `__SWAMP_VAULT_${envIdx++}`;
        result = result.split(sentinel).join(`"\${${envName}}"`);
        env[envName] = value;
      }
    }
    return { command: result, env };
  }
}
