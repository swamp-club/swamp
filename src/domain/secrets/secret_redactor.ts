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
 * Redacts secret values from text to prevent plaintext leakage into
 * persisted data files and log output.
 */
export class SecretRedactor {
  private secrets: Set<string> = new Set();

  /**
   * Registers a secret value for redaction.
   * Values shorter than 3 characters are ignored to prevent false-positive redaction.
   */
  addSecret(value: string): void {
    if (value.length < 3) return;
    this.secrets.add(value);
    // Also add JSON-escaped version for JSON data files
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
      this.secrets.add(jsonEscaped);
    }
  }

  /**
   * Replaces all registered secret values in the text with `***`.
   * Longer secrets are replaced first to handle substring overlap.
   */
  redact(text: string): string {
    if (this.secrets.size === 0) return text;
    // Sort longest-first to handle substring overlap (e.g., "abc" vs "abcdef")
    const sorted = Array.from(this.secrets).sort((a, b) => b.length - a.length);
    let result = text;
    for (const secret of sorted) {
      result = result.split(secret).join("***");
    }
    return result;
  }

  /** Whether any secrets have been registered. */
  get hasSecrets(): boolean {
    return this.secrets.size > 0;
  }
}
