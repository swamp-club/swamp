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

export class SecretRedactor {
  private secrets: Set<string> = new Set();
  private readonly indentedSecrets = new Map<string, RegExp>();
  private readonly sentinels = new Set<SecretBagRegistry>();
  private readonly sentinelPattern = new RegExp(SENTINEL_SOURCE, "g");

  /**
   * reads the registry, never a value, so nothing loads; registries add up so a
   * nested run sharing this redactor keeps the outer run's sentinels masked
   */
  maskSentinelsOf(registry: SecretBagRegistry): void {
    this.sentinels.add(registry);
  }

  private get masksSentinels(): boolean {
    for (const registry of this.sentinels) {
      if (!registry.isEmpty) return true;
    }
    return false;
  }

  private isMaskedSentinel(sentinel: string): boolean {
    for (const registry of this.sentinels) {
      if (registry.entryOf(sentinel) !== undefined) return true;
    }
    return false;
  }

  /**
   * values under 3 characters are ignored to avoid false positives; the
   * CRLF-normalised form is also registered because captured PowerShell output
   * is normalised before redaction
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
   * sentinels go first so a value that is a fragment of a sentinel cannot break
   * it apart; longer secrets go first to handle substring overlap
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
   * matches whole, for writers that emit a value unquoted such as a number,
   * where masking a substring would break the syntax
   */
  isSecret(text: string): boolean {
    return this.secrets.has(text);
  }

  /**
   * callers gate on this before redact, so it must answer true before any value
   * is loaded in a typed run
   */
  get hasSecrets(): boolean {
    return this.secrets.size > 0 || this.masksSentinels;
  }
}
