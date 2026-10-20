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

import {
  type SecretBagRegistry,
  SENTINEL_MARK,
  SENTINEL_SOURCE,
} from "../vaults/secret_bag_registry.ts";

/**
 * Redacts secret values from text to prevent plaintext leakage into
 * persisted data files and log output. In a typed run it also masks every
 * sentinel the run issued ({@link maskSentinelsOf}), so a sentinel in a log
 * line, a streamed output line or an error is never written as it is.
 */
export class SecretRedactor {
  private secrets: Set<string> = new Set();
  private readonly sentinels = new Set<SecretBagRegistry>();
  private readonly sentinelPattern = new RegExp(SENTINEL_SOURCE, "g");

  /**
   * Masks every sentinel `registry` issued as `***` as well
   * (design/enablers/typed-secrets.md Section 7.1). The decision reads the
   * registry, never a value: no load happens, and a mask does not depend on
   * the length or contents of a value. Sentinel-shaped text with another
   * prefix is left as it is. Registries add up: a nested run that shares
   * this redactor keeps the outer run's sentinels masked.
   */
  maskSentinelsOf(registry: SecretBagRegistry): void {
    this.sentinels.add(registry);
  }

  /** Whether an attached registry holds a sentinel to mask. */
  private get masksSentinels(): boolean {
    for (const registry of this.sentinels) {
      if (!registry.isEmpty) return true;
    }
    return false;
  }

  /** Whether an attached registry issued `sentinel`. */
  private isMaskedSentinel(sentinel: string): boolean {
    for (const registry of this.sentinels) {
      if (registry.entryOf(sentinel) !== undefined) return true;
    }
    return false;
  }

  /**
   * Registers a secret value for redaction.
   * Values shorter than 3 characters are ignored to prevent false-positive redaction.
   *
   * Also registers the value as it reads after CRLF line endings are
   * normalised to LF — every CR that precedes an LF or ends the value
   * removed — because captured PowerShell output is normalised that way
   * before it is redacted.
   */
  addSecret(value: string): void {
    if (value.length < 3) return;
    this.addForm(value);
    const lineEndingsNormalised = value.replace(/\r(?=\n|$)/g, "");
    if (
      lineEndingsNormalised !== value && lineEndingsNormalised.length >= 3
    ) {
      this.addForm(lineEndingsNormalised);
    }
  }

  private addForm(value: string): void {
    this.secrets.add(value);
    // Also add JSON-escaped version for JSON data files
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
      this.secrets.add(jsonEscaped);
    }
  }

  /**
   * Replaces every sentinel of an attached registry in the text with `***`,
   * then all registered secret values. Sentinels go first, so a value that
   * happens to be a fragment of a sentinel cannot break the sentinel apart
   * before it is recognised. Longer secrets are replaced first to handle
   * substring overlap.
   */
  redact(text: string): string {
    let result = text;
    if (this.masksSentinels && result.includes(SENTINEL_MARK)) {
      result = result.replace(
        this.sentinelPattern,
        (sentinel) => this.isMaskedSentinel(sentinel) ? "***" : sentinel,
      );
    }
    if (this.secrets.size > 0) {
      // Sort longest-first to handle substring overlap (e.g., "abc" vs "abcdef")
      const sorted = Array.from(this.secrets).sort((a, b) =>
        b.length - a.length
      );
      for (const secret of sorted) {
        result = result.split(secret).join("***");
      }
    }
    return result;
  }

  /**
   * Whether anything is redacted: a registered value, or a sentinel of an
   * attached registry. Callers gate on this before calling {@link redact}, so
   * it must answer true before any value is loaded in a typed run.
   */
  get hasSecrets(): boolean {
    return this.secrets.size > 0 || this.masksSentinels;
  }
}
