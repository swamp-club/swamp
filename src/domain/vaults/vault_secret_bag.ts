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
  classifyShellPositions,
  type ShellContext,
} from "./shell_context_scanner.ts";

type QuoteContext = "unquoted" | "single" | "double";

/** One sentinel of a {@link VaultSecretBag}, as shipped to a remote worker. */
export interface SecretBagEntry {
  sentinel: string;
  value: string;
  /** True when the secret reached the step through a data read. */
  dataOrigin: boolean;
}

const SENTINEL_SOURCE = "__SWAMP_VSEC_[0-9a-f]{8}_\\d+__";

/** Matches exactly one sentinel, as produced by {@link VaultSecretBag}. */
export const SENTINEL_EXACT = new RegExp(`^${SENTINEL_SOURCE}$`);

/** A command with sentinels replaced, and the environment that feeds it. */
export interface ShellSecretResolution {
  command: string;
  env: Record<string, string>;
  /**
   * Whether a secret read through data had to stay in the command line
   * because no environment reference can expand where it sits.
   */
  dataInCommandLine: boolean;
  /**
   * vault.get() sentinels with an occurrence inside single quotes, where
   * the reference stays a literal; each sentinel listed once.
   */
  singleQuoted: string[];
}

/**
 * Builds the reader of the quote context a vault.get() reference in
 * `command` is chosen by, from the POSIX shell context of its occurrence.
 * A here-document body has no quoting of its own, so there only unescaped
 * double quotes counted from the start of the body decide: a double-quoted
 * string may span body lines, and apostrophes in prose do not count. A
 * reference in a body is never reported as single-quoted.
 */
function posixVaultQuoter(
  command: string,
): (position: number, context: ShellContext) => QuoteContext {
  let lineStarts: number[] | undefined;
  let bodyStarts: number[] = [];
  /** Start of the here-document body holding `position`. */
  const bodyStartOf = (position: number): number => {
    if (lineStarts === undefined) {
      const starts = [0];
      for (let i = 0; i < command.length; i++) {
        if (command[i] === "\n") starts.push(i + 1);
      }
      const contexts = classifyShellPositions(command, starts);
      const inBody = (i: number) =>
        contexts[i] === "heredoc" || contexts[i] === "heredoc-literal";
      bodyStarts = starts.map(() => 0);
      starts.forEach((start, i) => {
        bodyStarts[i] = i > 0 && inBody(i) && inBody(i - 1)
          ? bodyStarts[i - 1]
          : start;
      });
      lineStarts = starts;
    }
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return bodyStarts[low];
  };
  return (position, context) => {
    switch (context) {
      case "double":
        return "double";
      case "single":
      case "ansi-c":
        return "single";
      case "heredoc":
      case "heredoc-literal": {
        let inDouble = false;
        for (let i = bodyStartOf(position); i < position; i++) {
          if (command[i] === "\\") i++;
          else if (command[i] === '"') inDouble = !inDouble;
        }
        return inDouble ? "double" : "unquoted";
      }
      default:
        return "unquoted";
    }
  };
}

/**
 * Returns the quoting context at a given position in a shell command string.
 * Tracks single-quote and double-quote state, respecting backslash escapes
 * outside single quotes.
 */
export function getQuoteContext(str: string, position: number): QuoteContext {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < position; i++) {
    const ch = str[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }
  }
  if (inSingle) return "single";
  if (inDouble) return "double";
  return "unquoted";
}

/** Splits text into sentinel tokens and the text between them. */
function splitOnSentinels(
  text: string,
): { text: string; sentinel: boolean }[] {
  const segments: { text: string; sentinel: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) {
      segments.push({ text: text.slice(last, start), sentinel: false });
    }
    segments.push({ text: match[0], sentinel: true });
    last = start + match[0].length;
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), sentinel: false });
  }
  return segments;
}

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
  /** Sentinel per value for secrets read through data, reused on repeat. */
  private readonly dataSentinels = new Map<string, string>();
  private readonly dataOrigin = new Set<string>();
  private counter = 0;
  private readonly prefix: string;

  /** Pattern that matches any sentinel produced by this bag or any other. */
  static readonly SENTINEL_PATTERN = new RegExp(SENTINEL_SOURCE, "g");

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

  /**
   * Returns the sentinel for a secret that reached an argument through a
   * data read (data.latest, step outputs) rather than vault.get(). One
   * sentinel per distinct value, so repeated occurrences share it.
   */
  addDataSecret(value: string): string {
    const existing = this.dataSentinels.get(value);
    if (existing) return existing;
    const sentinel = this.addSecret(value);
    this.dataSentinels.set(value, sentinel);
    this.dataOrigin.add(sentinel);
    return sentinel;
  }

  /** The value behind a data-origin sentinel of this bag, if it is one. */
  dataSecretOf(sentinel: string): string | undefined {
    return this.dataOrigin.has(sentinel)
      ? this.secrets.get(sentinel)
      : undefined;
  }

  /** Whether a sentinel stands for a secret read through data. */
  isDataOrigin(sentinel: string): boolean {
    return this.dataOrigin.has(sentinel);
  }

  /**
   * Replaces every occurrence of the given secret values in a string with
   * data-origin sentinels. JSON-escaped forms are matched too and get their
   * own sentinel, which restores the escaped text, so a secret spliced into
   * JSON text round-trips to valid JSON. Text inside sentinels already in
   * the string is never searched.
   */
  sentinelizeText(text: string, secrets: readonly string[]): string {
    let segments: { text: string; sentinel: boolean }[] = splitOnSentinels(
      text,
    );
    for (const secret of secrets) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      const forms = escaped === secret ? [secret] : [secret, escaped];
      for (const form of forms) {
        segments = segments.flatMap((segment) => {
          if (segment.sentinel || !segment.text.includes(form)) {
            return [segment];
          }
          const parts = segment.text.split(form);
          const sentinel = this.addDataSecret(form);
          const out: { text: string; sentinel: boolean }[] = [];
          parts.forEach((part, i) => {
            if (i > 0) out.push({ text: sentinel, sentinel: true });
            if (part) out.push({ text: part, sentinel: false });
          });
          return out;
        });
      }
    }
    return segments.map((segment) => segment.text).join("");
  }

  /**
   * Deep variant of {@link sentinelizeText} over strings in a structure.
   * `resolveDeep` of the result returns the input exactly.
   */
  sentinelizeValues(data: unknown, secrets: readonly string[]): unknown {
    if (secrets.length === 0) return data;
    if (typeof data === "string") return this.sentinelizeText(data, secrets);
    if (Array.isArray(data)) {
      return data.map((item) => this.sentinelizeValues(item, secrets));
    }
    if (data !== null && typeof data === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(data)) {
        Object.defineProperty(result, key, {
          value: this.sentinelizeValues(value, secrets),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return result;
    }
    return data;
  }

  /**
   * Re-issues this bag's data-origin sentinels found in `data` from `target`,
   * so a value sanitized before a step started (at workflow evaluation) is
   * delivered through that step's own bag. Other text is left as it is.
   */
  rehomeDataSentinels(data: unknown, target: VaultSecretBag): unknown {
    if (typeof data === "string") {
      return splitOnSentinels(data).map((segment) =>
        segment.sentinel && this.dataOrigin.has(segment.text)
          ? target.addDataSecret(this.secrets.get(segment.text) ?? "")
          : segment.text
      ).join("");
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.rehomeDataSentinels(item, target));
    }
    if (data !== null && typeof data === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(data)) {
        Object.defineProperty(result, key, {
          value: this.rehomeDataSentinels(value, target),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return result;
    }
    return data;
  }

  /**
   * The bag's sentinels with their values, so a remote worker can rebuild
   * the bag with {@link VaultSecretBag.fromEntries} and deliver the step's
   * secrets the way a local run does.
   */
  toEntries(): SecretBagEntry[] {
    return [...this.secrets].map(([sentinel, value]) => ({
      sentinel,
      value,
      dataOrigin: this.dataOrigin.has(sentinel),
    }));
  }

  /**
   * Rebuilds a bag from {@link VaultSecretBag.toEntries}, keeping each
   * sentinel exactly as shipped. Secrets added afterwards get this bag's own
   * prefix. Entries come from one bag, so sentinels are unique; a repeated
   * one would keep its last value.
   */
  static fromEntries(entries: readonly SecretBagEntry[]): VaultSecretBag {
    const bag = new VaultSecretBag();
    for (const { sentinel, value, dataOrigin } of entries) {
      if (!SENTINEL_EXACT.test(sentinel)) {
        throw new Error("Malformed vault secret sentinel in secret bag entry");
      }
      bag.secrets.set(sentinel, value);
      if (dataOrigin) {
        bag.dataOrigin.add(sentinel);
        bag.dataSentinels.set(value, sentinel);
      }
    }
    return bag;
  }

  /** Whether this bag contains any secrets. */
  get isEmpty(): boolean {
    return this.secrets.size === 0;
  }

  /** Returns all raw secret values (for registering with a SecretRedactor). */
  get rawValues(): string[] {
    return [...this.secrets.values()];
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
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(data)) {
        Object.defineProperty(result, key, {
          value: this.resolveDeep(value),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return result;
    }
    return data;
  }

  /**
   * Replaces sentinel tokens in a shell command string with environment
   * variable references, and returns the env var map.
   *
   * Shell variable expansion happens after command parsing, so metacharacters
   * in the secret value are never interpreted as shell syntax.
   *
   * The replacement is quoting-context-aware, chosen per occurrence from
   * the shell context scanner (which skips comments and here-documents):
   * - If the sentinel is inside existing double quotes, uses bare `${VAR}`
   *   (the user's quotes already protect against word splitting)
   * - If the sentinel is outside quotes, uses `"${VAR}"` (adds quotes to
   *   prevent word splitting and glob expansion)
   * - Inside single quotes the reference stays a literal and the sentinel
   *   is listed in `singleQuoted`
   */
  resolveForShell(
    command: string,
  ): ShellSecretResolution {
    return this.resolveOccurrences(
      command,
      classifyShellPositions,
      (envName, context: ShellContext) => {
        switch (context) {
          case "double":
          case "heredoc":
            return `\${${envName}}`;
          case "single":
            return `'"\${${envName}}"'`;
          case "ansi-c":
            return `'"\${${envName}}"$'`;
          case "heredoc-literal":
            return undefined;
          default:
            return `"\${${envName}}"`;
        }
      },
      posixVaultQuoter(command),
      (envName, quote) =>
        quote === "double" ? `\${${envName}}` : `"\${${envName}}"`,
    );
  }

  /**
   * Replaces sentinels in a command with references built by the callers,
   * per occurrence from the context `classify` gives it: a data-origin
   * sentinel's by `dataRef`, a vault.get sentinel's by `vaultRef` from the
   * quote context `vaultQuote` reads there. A `dataRef` of undefined means
   * no reference can expand there, so the raw value is substituted and the
   * result reports that a data value is in the command line.
   */
  private resolveOccurrences<C>(
    command: string,
    classify: (command: string, positions: number[]) => C[],
    dataRef: (envName: string, context: C) => string | undefined,
    vaultQuote: (position: number, context: C) => QuoteContext,
    vaultRef: (envName: string, quote: QuoteContext) => string,
  ): ShellSecretResolution {
    const env: Record<string, string> = {};
    const envNames = new Map<string, string>();
    let envIdx = 0;
    for (const [sentinel, value] of this.secrets) {
      if (command.includes(sentinel)) {
        const envName = `__SWAMP_VAULT_${envIdx++}`;
        envNames.set(sentinel, envName);
        env[envName] = value;
      }
    }
    if (envNames.size === 0) {
      return { command, env, dataInCommandLine: false, singleQuoted: [] };
    }

    const occurrences = [...command.matchAll(VaultSecretBag.SENTINEL_PATTERN)]
      .filter((match) => envNames.has(match[0]));
    const contexts = classify(
      command,
      occurrences.map((match) => match.index ?? 0),
    );

    let dataInCommandLine = false;
    const singleQuoted = new Set<string>();
    const referenced = new Set<string>();
    let result = "";
    let last = 0;
    occurrences.forEach((match, i) => {
      const sentinel = match[0];
      const start = match.index ?? 0;
      result += command.slice(last, start);
      if (this.dataOrigin.has(sentinel)) {
        const ref = dataRef(envNames.get(sentinel)!, contexts[i]);
        if (ref === undefined) {
          dataInCommandLine = true;
          result += this.secrets.get(sentinel)!;
        } else {
          result += ref;
          referenced.add(sentinel);
        }
      } else {
        const quote = vaultQuote(start, contexts[i]);
        if (quote === "single") singleQuoted.add(sentinel);
        result += vaultRef(envNames.get(sentinel)!, quote);
        referenced.add(sentinel);
      }
      last = start + sentinel.length;
    });
    result += command.slice(last);
    // A data value substituted raw everywhere needs no environment entry.
    for (const [sentinel, envName] of envNames) {
      if (!referenced.has(sentinel)) delete env[envName];
    }
    return {
      command: result,
      env,
      dataInCommandLine,
      singleQuoted: [...singleQuoted],
    };
  }

  /**
   * PowerShell sibling of `resolveForShell`. Replaces sentinel tokens
   * with `$env:VAR` references using PowerShell's environment-variable
   * syntax, and returns the env var map.
   *
   * As with the POSIX path, secret values are passed through the
   * process environment rather than substituted into the command
   * string, so metacharacters in the value can't be parsed as syntax.
   *
   * The replacement is quoting-context-aware, chosen per occurrence:
   * - If the sentinel is inside existing double quotes, uses bare
   *   `$env:VAR` — PowerShell interpolates env vars inside double
   *   quotes natively, no extra wrapping needed.
   * - If the sentinel is outside quotes, uses `"$env:VAR"` to defend
   *   against PowerShell's whitespace-splitting behavior when the
   *   resolved value is passed to a native (non-cmdlet) command.
   *
   * Quote tracking reuses the POSIX `getQuoteContext` helper.
   * PowerShell's escape character is a backtick rather than a
   * backslash, so commands authored with PowerShell-specific escape
   * sequences inside single quotes could mis-classify their context;
   * users hitting that corner case can avoid it by keeping vault
   * sentinels outside single-quoted regions, the same advice that
   * applies to the POSIX resolver.
   */
  resolveForPowerShell(
    command: string,
  ): ShellSecretResolution {
    const psRef = (envName: string, quote: QuoteContext) =>
      quote === "double" ? `$env:${envName}` : `"$env:${envName}"`;
    return this.resolveOccurrences(
      command,
      (text, positions) =>
        positions.map((position) => getQuoteContext(text, position)),
      (envName, context: QuoteContext) =>
        // PowerShell has no break-out from a single-quoted string that is
        // safe in every command position, so the value stays in place.
        context === "single" ? undefined : psRef(envName, context),
      (_position, context) => context,
      psRef,
    );
  }
}
