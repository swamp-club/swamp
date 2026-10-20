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
  type DataReferenceEntry,
  type DataSecretEntry,
  holdsValue,
  isIssuedEntry,
  type RegistryEntry,
  type SecretBagEntry,
  SecretBagRegistry,
  type SecretEncoding,
  type SecretReference,
  SENTINEL_EXACT,
  SENTINEL_SOURCE,
  type VaultReferenceEntry,
} from "./secret_bag_registry.ts";
import {
  secretOccurrencesOf,
  type SecretOrigin,
  type SecretOriginLookup,
} from "./secret_occurrences.ts";
import {
  classifyShellPositions,
  type ShellContext,
} from "./shell_context_scanner.ts";

/** A recorded sensitive value with the reference it was read from. */
export interface RecordedSecret {
  readonly value: string;
  readonly source: SecretReference;
}

type QuoteContext = "unquoted" | "single" | "double";

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
  /** The generated environment name of each sentinel in the command. */
  envNames: ReadonlyMap<string, string>;
}

/** Where one occurrence of a sentinel in a shell command is placed. */
export interface ShellOccurrencePlacement {
  readonly sentinel: string;
  /** The offset of the sentinel in the command. */
  readonly start: number;
  /** The offset just past the sentinel. */
  readonly end: number;
  readonly dataOrigin: boolean;
  /** The generated environment variable the occurrence refers to. */
  readonly envName: string;
  /**
   * `environment`: replaced by `text`, a reference the shell expands from
   * the child environment. `literal`: a vault.get() reference inside single
   * quotes, replaced by `text` but left unexpanded by the shell, which is
   * warned about. `refused`: a data-origin value no environment reference
   * can expand where it sits (`where`); a typed run refuses the delivery,
   * and the legacy fill pastes the value and reports it.
   */
  readonly placement: "environment" | "literal" | "refused";
  readonly text?: string;
  /** For a refused placement, the position as a user reads it. */
  readonly where?: string;
  /** For a refused placement, what to write instead. */
  readonly fix?: string;
}

/**
 * A plan of a shell command's secret placement
 * (design/enablers/typed-secrets.md Section 7.2), computed from references
 * alone: no value is read, so a destination policy can refuse before the
 * load, and the fill after the load places exactly what the plan says.
 */
export interface ShellPlacementPlan {
  readonly occurrences: readonly ShellOccurrencePlacement[];
  /**
   * The generated environment name of each sentinel present, in the run's
   * issue order. A name never equals an authored environment key.
   */
  readonly envNames: ReadonlyMap<string, string>;
  /** The occurrences no environment reference can expand. */
  readonly refused: readonly ShellOccurrencePlacement[];
  /**
   * vault.get() sentinels with an occurrence inside single quotes, where
   * the reference stays a literal; each sentinel listed once.
   */
  readonly singleQuoted: readonly string[];
}

/** The prefix of every generated environment variable name. */
export const GENERATED_ENV_PREFIX = "__SWAMP_VAULT_";

/** Characters after which a quote begins a new here-document token. */
const TOKEN_BOUNDARY = /[\s=(|;&{[,:]/;

/**
 * Whether `position` reads as inside a double-quoted string of here-document
 * text starting at `bodyStart`. Here-document text has no quoting of its own,
 * so this reads it as the author's script or config would. Within a line
 * every double quote opens or closes a string, as in shell, so attached
 * strings (`-p"…"`, `>"…"`, `'a'"…"`) pair up. A string still open at the end
 * of a line carries to the next line only when its opening quote sat at a
 * token boundary (`echo "line1`), so a stray mid-word quote such as an inch
 * mark (`5"`) ends with its line. A single-quoted span that opens at a token
 * boundary and closes on the same line is skipped (`tr -d '"'`); a position
 * inside one counts as quoted, so the reference stays bare inside the
 * author's single quotes. Mid-word apostrophes (`don't`) are prose.
 */
function heredocDoubleQuoted(
  command: string,
  bodyStart: number,
  position: number,
): boolean {
  let inDouble = false;
  let carries = true;
  for (let i = bodyStart; i < position; i++) {
    const ch = command[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "\n") {
      if (inDouble && !carries) inDouble = false;
      continue;
    }
    const atBoundary = TOKEN_BOUNDARY.test(command[i - 1]);
    if (ch === '"') {
      if (inDouble) {
        inDouble = false;
      } else {
        inDouble = true;
        carries = atBoundary;
      }
    } else if (ch === "'" && !inDouble && atBoundary) {
      const close = command.indexOf("'", i + 1);
      const lineEnd = command.indexOf("\n", i);
      if (close !== -1 && (lineEnd === -1 || close < lineEnd)) {
        if (close >= position) return true;
        i = close;
      }
    }
  }
  return inDouble;
}

/**
 * Builds the reader of the quote context a vault.get() reference in
 * `command` is chosen by, from the POSIX shell context of its occurrence.
 * In a here-document body, {@link heredocDoubleQuoted} reads the text from
 * the start of the body, so a double-quoted string may span body lines. A
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
      case "heredoc-literal":
        return heredocDoubleQuoted(command, bodyStartOf(position), position)
          ? "double"
          : "unquoted";
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
 * VaultSecretBag is a view of a run's {@link SecretBagRegistry}: it issues
 * sentinels under its own prefix and resolves any sentinel the registry
 * holds.
 *
 * During vault expression resolution, each vault.get() call is replaced with
 * a unique sentinel token (a safe alphanumeric string) that stands for its
 * reference. The bag holds no vault value: a load at delivery reads them and
 * returns a delivery view ({@link withLoaded}) that resolves sentinels —
 * either to raw values (for non-shell contexts) or to environment variable
 * references (for shell commands). Sentinels are persisted as references.
 * What the bag ships to a remote worker and reports as its own stays the
 * entries it issued, so one step's dispatch carries nothing from another
 * step.
 */
export class VaultSecretBag {
  /** Sentinels this bag issued, in issue order. */
  private readonly issued: string[] = [];
  /** Sentinel per value for secrets read through data, reused on repeat. */
  private readonly dataSentinels = new Map<string, string>();
  private counter = 0;
  /** Drawn on the first issue, so a delivery view draws none. */
  private prefix: string | undefined;
  /**
   * The values one delivery attempt loaded for vault references, keyed by
   * sentinel. Set only on a delivery view.
   */
  private loaded: ReadonlyMap<string, string> | undefined;

  /** Pattern that matches any sentinel produced by this bag or any other. */
  static readonly SENTINEL_PATTERN = new RegExp(SENTINEL_SOURCE, "g");

  constructor(
    /** The run's registry this bag is a view of. */
    readonly registry: SecretBagRegistry,
  ) {}

  /** Issues the next sentinel of this bag for `entry` into the registry. */
  private issue(
    entry:
      | Omit<VaultReferenceEntry, "sentinel">
      | Omit<DataSecretEntry, "sentinel">
      | Omit<DataReferenceEntry, "sentinel">,
  ): string {
    if (this.loaded !== undefined) {
      throw new Error("A delivery view of a secret bag issues no sentinels");
    }
    if (this.prefix === undefined) {
      this.prefix = crypto.getRandomValues(new Uint8Array(16))
        .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
      this.registry.drawPrefix(this.prefix);
    }
    const sentinel = `__SWAMP_VSEC_${this.prefix}_${this.counter++}__`;
    this.registry.register({ sentinel, ...entry });
    this.issued.push(sentinel);
    return sentinel;
  }

  /**
   * Adds a vault.get() reference, written at `location`, and returns a
   * unique sentinel token that stands for it. No value is read: a load at
   * delivery reads it. The sentinel is alphanumeric + underscores, safe in
   * CEL strings and shell.
   */
  addSecret(reference: SecretReference, location: string): string {
    return this.issue({
      reference,
      encoding: "raw",
      dataOrigin: false,
      location,
    });
  }

  /**
   * Returns the sentinel for a secret that reached an argument through a
   * data read (data.latest, step outputs) rather than vault.get(). One
   * sentinel per distinct value, so repeated occurrences share it and two
   * references whose values are equal share it too, with the first
   * reference kept, as {@link RunSensitiveValues} keeps the first source.
   */
  addDataSecret(
    value: string,
    reference: SecretReference,
    encoding: SecretEncoding = "raw",
  ): string {
    const existing = this.dataSentinels.get(value);
    if (existing) return existing;
    const sentinel = this.issue({
      value,
      reference,
      encoding,
      dataOrigin: true,
    });
    this.dataSentinels.set(value, sentinel);
    return sentinel;
  }

  /**
   * Adds a sensitive-field reference a typed data read brought into an
   * expression (typed-secrets 3.3), read at `location`, and returns a unique
   * sentinel that stands for it. No value is read: a load at delivery reads
   * it, as for {@link addSecret}. Unlike {@link addDataSecret}, nothing is
   * shared on a repeat, because no value is known to share by.
   */
  addDataReference(reference: SecretReference, location: string): string {
    return this.issue({
      reference,
      encoding: "raw",
      dataOrigin: true,
      location,
    });
  }

  /** The entry behind a sentinel the run issued, if it is one. */
  entryOf(sentinel: string): RegistryEntry | undefined {
    return this.registry.entryOf(sentinel);
  }

  /**
   * A delivery view of this bag: the same registry and the same issued
   * sentinels, with `values` loaded for vault references, keyed by
   * sentinel. Only a load builds one, for one delivery attempt; this bag is
   * left as it is, so the next attempt loads again. A view issues nothing.
   */
  withLoaded(values: ReadonlyMap<string, string>): VaultSecretBag {
    const view = new VaultSecretBag(this.registry);
    for (const sentinel of this.issued) view.issued.push(sentinel);
    view.loaded = new Map([...(this.loaded ?? []), ...values]);
    return view;
  }

  /**
   * The value `sentinel` stands for: a data entry's or a shipped entry's
   * own, or the value this delivery view loaded for a reference-only entry.
   * Undefined for text that is not a sentinel of the run. A reference no
   * load filled throws, so its sentinel is never delivered as a value.
   */
  private valueOf(sentinel: string): string | undefined {
    const entry = this.registry.entryOf(sentinel);
    if (entry === undefined) return undefined;
    if (holdsValue(entry)) return entry.value;
    const value = this.loaded?.get(sentinel);
    if (value === undefined) {
      const { vaultName, key } = entry.reference;
      throw new Error(
        `The secret '${key}' in vault '${vaultName}' (at ${entry.location}) was not loaded before delivery`,
      );
    }
    return value;
  }

  /** Whether a sentinel this bag issued has its value in hand. */
  private inHand(sentinel: string): boolean {
    const entry = this.registry.entryOf(sentinel);
    return entry !== undefined &&
      (holdsValue(entry) || this.loaded?.has(sentinel) === true);
  }

  /**
   * Replaces every occurrence of the given secret values in a string with
   * data-origin sentinels. JSON-escaped forms are matched too and get their
   * own sentinel with the `json` encoding, which restores the escaped text,
   * so a secret spliced into JSON text round-trips to valid JSON. Text
   * inside sentinels already in the string is never searched.
   */
  sentinelizeText(text: string, secrets: readonly RecordedSecret[]): string {
    let segments: { text: string; sentinel: boolean }[] = splitOnSentinels(
      text,
    );
    for (const { value: secret, source } of secrets) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      const forms: [string, SecretEncoding][] = escaped === secret
        ? [[secret, "raw"]]
        : [[secret, "raw"], [escaped, "json"]];
      for (const [form, encoding] of forms) {
        segments = segments.flatMap((segment) => {
          if (segment.sentinel || !segment.text.includes(form)) {
            return [segment];
          }
          const parts = segment.text.split(form);
          const sentinel = this.addDataSecret(form, source, encoding);
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
  sentinelizeValues(
    data: unknown,
    secrets: readonly RecordedSecret[],
  ): unknown {
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
   * Re-issues the sentinels this bag issued that occur in `data` from
   * `target`, so a value sanitized before a step started (at workflow
   * evaluation) is delivered through that step's own bag and ships with it.
   * Each source sentinel maps to one target sentinel, whatever its origin,
   * with the same reference, encoding and origin; a reference-only entry,
   * vault or data origin, moves as a reference, with no value. Other text is
   * left as it is; a sentinel from another bag still resolves through the
   * registry.
   */
  rehomeSentinels(data: unknown, target: VaultSecretBag): unknown {
    const rehomed = new Map<string, string>();
    const own = new Set(this.issued);
    const rehome = (sentinel: string): string => {
      const existing = rehomed.get(sentinel);
      if (existing !== undefined) return existing;
      const entry = this.registry.entryOf(sentinel);
      if (!entry || !isIssuedEntry(entry)) {
        throw new Error(
          "A secret bag entry without a reference cannot be rehomed",
        );
      }
      const issued = holdsValue(entry)
        ? target.addDataSecret(entry.value, entry.reference, entry.encoding)
        : entry.dataOrigin
        ? target.addDataReference(entry.reference, entry.location)
        : target.addSecret(entry.reference, entry.location);
      rehomed.set(sentinel, issued);
      return issued;
    };
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        return splitOnSentinels(value).map((segment) =>
          segment.sentinel && own.has(segment.text)
            ? rehome(segment.text)
            : segment.text
        ).join("");
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, item] of Object.entries(value)) {
          Object.defineProperty(result, key, {
            value: walk(item),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return result;
      }
      return value;
    };
    return walk(data);
  }

  /**
   * The sentinels this bag issued whose values are in hand, in issue order:
   * every data entry, and each vault reference this delivery view loaded. A
   * vault reference of a method the attempt does not run is never loaded.
   */
  private ownInHand(): string[] {
    return this.issued.filter((sentinel) => this.inHand(sentinel));
  }

  /** `sentinel`'s entry in the shape a dispatch ships, with its value. */
  private shipped(sentinel: string): SecretBagEntry {
    return {
      sentinel,
      value: this.valueOf(sentinel)!,
      dataOrigin: this.registry.entryOf(sentinel)!.dataOrigin,
    };
  }

  /**
   * The sentinels this bag issued with their values in hand, so a remote
   * worker can rebuild the bag with {@link VaultSecretBag.fromEntries} and
   * deliver the step's secrets the way a local run does.
   */
  toEntries(): SecretBagEntry[] {
    return this.ownInHand().map((sentinel) => this.shipped(sentinel));
  }

  /**
   * The entries a dispatch of `args` needs: the ones this bag issued with
   * their values in hand, then any other entry of the run whose sentinel
   * occurs in `args`, so a worker delivers what the step's arguments
   * reference and nothing else. A sentinel in `args` no load filled throws.
   */
  entriesFor(args: unknown): SecretBagEntry[] {
    const sentinels = this.ownInHand();
    const seen = new Set(sentinels);
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
          if (seen.has(match[0])) continue;
          if (this.registry.entryOf(match[0])) {
            seen.add(match[0]);
            sentinels.push(match[0]);
          }
        }
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(args);
    return sentinels.map((sentinel) => this.shipped(sentinel));
  }

  /**
   * Rebuilds a bag from {@link VaultSecretBag.toEntries} over a registry of
   * its own, keeping each sentinel exactly as shipped. Secrets added
   * afterwards get this bag's own prefix. Entries come from one bag, so
   * sentinels are unique; a repeated one is refused.
   */
  static fromEntries(entries: readonly SecretBagEntry[]): VaultSecretBag {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    for (const entry of entries) {
      if (!SENTINEL_EXACT.test(entry.sentinel)) {
        throw new Error("Malformed vault secret sentinel in secret bag entry");
      }
      const { sentinel, value, dataOrigin } = entry;
      bag.registry.register({ sentinel, value, dataOrigin });
      bag.issued.push(entry.sentinel);
      if (entry.dataOrigin) bag.dataSentinels.set(entry.value, entry.sentinel);
    }
    return bag;
  }

  /** Whether this bag issued no secrets. */
  get isEmpty(): boolean {
    return this.issued.length === 0;
  }

  /**
   * Whether any sentinel of the run resolves through this bag: the gate for
   * delivery, since a step's arguments can carry a sentinel an earlier pass
   * issued into the registry.
   */
  get resolvesAny(): boolean {
    return !this.registry.isEmpty;
  }

  /** The raw values of the secrets this bag issued that are in hand. */
  get rawValues(): string[] {
    return this.ownInHand().map((sentinel) => this.valueOf(sentinel)!);
  }

  /**
   * Replaces every sentinel the run issued in a string with its raw secret
   * value. Sentinel-shaped text with another prefix stays as it is. Use this
   * for non-shell contexts where the value should be literal. A vault
   * reference resolves only through a delivery view that loaded it.
   */
  resolveRaw(str: string): string {
    return str.replace(
      VaultSecretBag.SENTINEL_PATTERN,
      (sentinel) => this.valueOf(sentinel) ?? sentinel,
    );
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
   *
   * The fill of {@link planShellPlacement}: `authoredEnvKeys` are the names
   * the command's own `env` sets, which no generated name may take.
   */
  resolveForShell(
    command: string,
    authoredEnvKeys: Iterable<string> = [],
  ): ShellSecretResolution {
    return this.fill(
      command,
      planShellPlacement(command, authoredEnvKeys, this.originOf),
    );
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
   *
   * The fill of {@link planPowerShellPlacement}.
   */
  resolveForPowerShell(
    command: string,
    authoredEnvKeys: Iterable<string> = [],
  ): ShellSecretResolution {
    return this.fill(
      command,
      planPowerShellPlacement(command, authoredEnvKeys, this.originOf),
    );
  }

  /** The origin of a sentinel the run issued, read from the registry. */
  private get originOf(): SecretOriginLookup {
    return secretOccurrencesOf(this.registry).originOf;
  }

  /**
   * Places each occurrence as `plan` says and fills the environment with
   * the values of the sentinels the command refers to. A refused occurrence
   * is the legacy paste: the value goes into the command line and the
   * result says so; a typed run refuses the delivery before this is
   * reached. A sentinel no load filled throws.
   */
  private fill(
    command: string,
    plan: ShellPlacementPlan,
  ): ShellSecretResolution {
    const env: Record<string, string> = {};
    if (plan.envNames.size === 0) {
      return {
        command,
        env,
        dataInCommandLine: false,
        singleQuoted: [],
        envNames: plan.envNames,
      };
    }
    let dataInCommandLine = false;
    const referenced = new Set<string>();
    let result = "";
    let last = 0;
    for (const occurrence of plan.occurrences) {
      result += command.slice(last, occurrence.start);
      if (occurrence.placement === "refused") {
        dataInCommandLine = true;
        result += this.valueOf(occurrence.sentinel)!;
      } else {
        result += occurrence.text!;
        referenced.add(occurrence.sentinel);
      }
      last = occurrence.end;
    }
    result += command.slice(last);
    // A data value substituted raw everywhere needs no environment entry.
    for (const [sentinel, envName] of plan.envNames) {
      if (referenced.has(sentinel)) env[envName] = this.valueOf(sentinel)!;
    }
    return {
      command: result,
      env,
      dataInCommandLine,
      singleQuoted: [...plan.singleQuoted],
      envNames: plan.envNames,
    };
  }
}

/** The POSIX reference a data-origin occurrence becomes in `context`. */
function posixDataReference(
  envName: string,
  context: ShellContext,
): string | undefined {
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
}

/** The POSIX reference a vault.get() occurrence becomes in `quote`. */
function posixVaultReference(envName: string, quote: QuoteContext): string {
  return quote === "double" ? `\${${envName}}` : `"\${${envName}}"`;
}

/** The PowerShell reference an occurrence becomes in `quote`. */
function powerShellReference(envName: string, quote: QuoteContext): string {
  return quote === "double" ? `$env:${envName}` : `"$env:${envName}"`;
}

/**
 * Plans the placement of every sentinel of the run in a POSIX `sh -c`
 * command, from references alone: each occurrence's context from the shell
 * context scanner, the environment reference that expands there, a literal
 * vault.get() reference inside single quotes, or a refusal where nothing
 * expands (a data value in a here-document with a quoted delimiter).
 * Generated names follow the run's issue order and skip any name in
 * `authoredEnvKeys`.
 */
export function planShellPlacement(
  command: string,
  authoredEnvKeys: Iterable<string>,
  originOf: SecretOriginLookup,
): ShellPlacementPlan {
  return planOccurrences(command, authoredEnvKeys, originOf, {
    caseInsensitiveNames: false,
    classify: classifyShellPositions,
    dataReference: posixDataReference,
    vaultQuote: posixVaultQuoter(command),
    vaultReference: posixVaultReference,
    refusedWhere: "a here-document with a quoted delimiter",
    refusedFix: "use an unquoted here-document delimiter",
  });
}

/**
 * PowerShell sibling of {@link planShellPlacement}: contexts come from
 * `getQuoteContext`, and a data value inside single quotes is refused,
 * since PowerShell has no break-out from a single-quoted string that is
 * safe in every command position. Environment variable names are
 * case-insensitive on Windows, so generated names skip authored keys
 * whatever their case.
 */
export function planPowerShellPlacement(
  command: string,
  authoredEnvKeys: Iterable<string>,
  originOf: SecretOriginLookup,
): ShellPlacementPlan {
  return planOccurrences(command, authoredEnvKeys, originOf, {
    caseInsensitiveNames: true,
    classify: (text, positions) =>
      positions.map((position) => getQuoteContext(text, position)),
    dataReference: (envName, context: QuoteContext) =>
      context === "single" ? undefined : powerShellReference(envName, context),
    vaultQuote: (_position, context) => context,
    vaultReference: powerShellReference,
    refusedWhere: "PowerShell single quotes",
    refusedFix: "use double quotes",
  });
}

/** How one shell reads contexts and writes references. */
interface ShellPlacementRules<C> {
  caseInsensitiveNames: boolean;
  classify: (command: string, positions: number[]) => C[];
  /** The reference for a data-origin occurrence; undefined where none expands. */
  dataReference: (envName: string, context: C) => string | undefined;
  vaultQuote: (position: number, context: C) => QuoteContext;
  vaultReference: (envName: string, quote: QuoteContext) => string;
  refusedWhere: string;
  refusedFix: string;
}

function planOccurrences<C>(
  command: string,
  authoredEnvKeys: Iterable<string>,
  originOf: SecretOriginLookup,
  rules: ShellPlacementRules<C>,
): ShellPlacementPlan {
  // Only the sentinels present are looked up, never the whole registry;
  // environment names then follow issue order across the run, so a step's
  // own sentinels are numbered as they were added.
  const origins = new Map<string, SecretOrigin>();
  for (const match of command.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
    if (origins.has(match[0])) continue;
    const origin = originOf(match[0]);
    if (origin) origins.set(match[0], origin);
  }
  const present = [...origins.keys()].sort((a, b) =>
    origins.get(a)!.sequence - origins.get(b)!.sequence
  );
  const fold = (name: string) =>
    rules.caseInsensitiveNames ? name.toUpperCase() : name;
  const taken = new Set([...authoredEnvKeys].map(fold));
  const envNames = new Map<string, string>();
  let next = 0;
  for (const sentinel of present) {
    let name = `${GENERATED_ENV_PREFIX}${next++}`;
    while (taken.has(fold(name))) name = `${GENERATED_ENV_PREFIX}${next++}`;
    envNames.set(sentinel, name);
  }
  if (envNames.size === 0) {
    return { occurrences: [], envNames, refused: [], singleQuoted: [] };
  }

  const matches = [...command.matchAll(VaultSecretBag.SENTINEL_PATTERN)]
    .filter((match) => envNames.has(match[0]));
  const contexts = rules.classify(
    command,
    matches.map((match) => match.index ?? 0),
  );
  const singleQuoted = new Set<string>();
  const occurrences = matches.map((match, i): ShellOccurrencePlacement => {
    const sentinel = match[0];
    const start = match.index ?? 0;
    const envName = envNames.get(sentinel)!;
    const base = {
      sentinel,
      start,
      end: start + sentinel.length,
      dataOrigin: origins.get(sentinel)!.dataOrigin,
      envName,
    };
    if (base.dataOrigin) {
      const text = rules.dataReference(envName, contexts[i]);
      return text === undefined
        ? {
          ...base,
          placement: "refused",
          where: rules.refusedWhere,
          fix: rules.refusedFix,
        }
        : { ...base, placement: "environment", text };
    }
    const quote = rules.vaultQuote(start, contexts[i]);
    if (quote === "single") singleQuoted.add(sentinel);
    return {
      ...base,
      placement: quote === "single" ? "literal" : "environment",
      text: rules.vaultReference(envName, quote),
    };
  });
  return {
    occurrences,
    envNames,
    refused: occurrences.filter((o) => o.placement === "refused"),
    singleQuoted: [...singleQuoted],
  };
}
