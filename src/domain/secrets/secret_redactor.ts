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
  private readonly indentedSecrets = new Map<string, RegExp>();
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
    if (value.includes("\n")) {
      // Nested Error inspection indents the raw message/stack at every line.
      // Permit that added horizontal whitespace without matching fragments of
      // a secret on their own or changing the original value.
      this.indentedSecrets.set(
        value,
        new RegExp(
          value.split("\n").map((line) =>
            line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          ).join("\n[\\t ]*"),
          "g",
        ),
      );
    }
    // Also add JSON-escaped version for JSON data files
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
      this.secrets.add(jsonEscaped);
    }
    // LogTape and console.dir inspect strings instead of JSON-encoding them.
    // Inspection can choose any quote style and uses escapes such as \x00.
    // Enclosing text can change the chosen quotes, so register all styles.
    const inspected = Deno.inspect(value, {
      colors: false,
      strAbbreviateSize: Infinity,
      breakLength: Infinity,
    });
    const quote = inspected[0];
    const body = inspected.slice(1, -1).replaceAll(`\\${quote}`, quote);
    this.secrets.add(body);
    for (const delimiter of ['"', "'", "`", "${"]) {
      this.secrets.add(body.replaceAll(delimiter, `\\${delimiter}`));
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
        const indented = this.indentedSecrets.get(secret);
        if (indented) result = result.replace(indented, "***");
        result = result.split(secret).join("***");
      }
    }
    return result;
  }

  /**
   * Whether `text` is itself a registered secret, matched whole rather than
   * as a substring. A writer that serializes structure asks this of a value
   * it writes unquoted, such as a number, where masking a substring would
   * break the syntax (swamp-club#3754).
   */
  isSecret(text: string): boolean {
    return this.secrets.has(text);
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
