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
  deliveredJsonValue,
  holdsValue,
  isIssuedEntry,
  isJsonValueEntry,
  jsonEscaped,
  type RegistryEntry,
  type SecretBagEntry,
  SecretBagRegistry,
  type SecretEncoding,
  type SecretReference,
  SENTINEL_EXACT,
  SENTINEL_SOURCE,
  type ShippedReferenceEntry,
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

export interface RecordedSecret {
  readonly value: string;
  readonly source: SecretReference;
}

type QuoteContext = "unquoted" | "single" | "double";

export interface ShellSecretResolution {
  command: string;
  env: Record<string, string>;
  /**
   * Whether a secret read through data had to stay in the command line
   * because no environment reference can expand where it sits.
   */
  dataInCommandLine: boolean;
  singleQuoted: string[];
  envNames: ReadonlyMap<string, string>;
}

export interface ShellOccurrencePlacement {
  readonly sentinel: string;
  readonly start: number;
  readonly end: number;
  readonly dataOrigin: boolean;
  readonly envName: string;
  /**
   * refused: a data-origin value no environment reference can expand where it
   * sits; a typed run refuses the delivery, the legacy fill pastes the value
   * and reports it
   */
  readonly placement: "environment" | "literal" | "refused";
  readonly text?: string;
  readonly where?: string;
  readonly fix?: string;
}

/**
 * computed from references alone, no value read, so a destination policy can
 * refuse before the load and the fill after it places exactly what the plan
 * says
 */
export interface ShellPlacementPlan {
  readonly occurrences: readonly ShellOccurrencePlacement[];
  /**
   * The generated environment name of each sentinel present, in the run's
   * issue order. A name never equals an authored environment key.
   */
  readonly envNames: ReadonlyMap<string, string>;
  readonly refused: readonly ShellOccurrencePlacement[];
  readonly singleQuoted: readonly string[];
}

export const GENERATED_ENV_PREFIX = "__SWAMP_VAULT_";

const TOKEN_BOUNDARY = /[\s=(|;&{[,:]/;

/**
 * reads here-document text as the author's script would: within a line each
 * double quote toggles, an open string carries to the next line only if it
 * opened at a token boundary, single-quoted spans count as quoted
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
 * a double-quoted string may span here-document body lines; a reference in a
 * body is never reported as single-quoted
 */
function posixVaultQuoter(
  command: string,
): (position: number, context: ShellContext) => QuoteContext {
  let lineStarts: number[] | undefined;
  let bodyStarts: number[] = [];
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

/**
 * a shipped entry carries the JSON-value mark only when this holds, so it needs
 * no encoding
 */
function parsesWhole(entry: RegistryEntry): boolean {
  return isJsonValueEntry(entry) &&
    (!isIssuedEntry(entry) || entry.encoding === "raw");
}

function dataSentinelKey(value: string, jsonValue: boolean): string {
  return `${jsonValue ? "json" : "text"}\u0000${value}`;
}

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
 * the bag holds no vault value: a load at delivery returns a delivery view that
 * resolves sentinels; what it ships to a worker stays the entries it issued, so
 * one step's dispatch carries nothing from another
 */
export class VaultSecretBag {
  private readonly issued: string[] = [];
  private readonly dataSentinels = new Map<string, string>();
  private counter = 0;
  /** Drawn on the first issue, so a delivery view draws none. */
  private prefix: string | undefined;
  private loaded: ReadonlyMap<string, string> | undefined;

  static readonly SENTINEL_PATTERN = new RegExp(SENTINEL_SOURCE, "g");

  constructor(
    readonly registry: SecretBagRegistry,
  ) {}

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

  addSecret(reference: SecretReference, location: string): string {
    return this.issue({
      reference,
      encoding: "raw",
      dataOrigin: false,
      location,
    });
  }

  /**
   * one sentinel per distinct value, keeping the first reference; a value that
   * is JSON text never shares a sentinel with the same text that is not
   */
  addDataSecret(
    value: string,
    reference: SecretReference,
    encoding: SecretEncoding = "raw",
    jsonValue = false,
  ): string {
    const key = dataSentinelKey(value, jsonValue);
    const existing = this.dataSentinels.get(key);
    if (existing) return existing;
    const sentinel = this.issue({
      value,
      reference,
      encoding,
      dataOrigin: true,
      ...(jsonValue ? { jsonValue } : {}),
    });
    this.dataSentinels.set(key, sentinel);
    return sentinel;
  }

  /**
   * unlike addDataSecret, nothing is shared on a repeat, because no value is
   * known to share by
   */
  addDataReference(
    reference: SecretReference,
    location: string,
    jsonValue = false,
  ): string {
    return this.issue({
      reference,
      encoding: "raw",
      dataOrigin: true,
      location,
      ...(jsonValue ? { jsonValue } : {}),
    });
  }

  /**
   * the entry keeps the file's encoding and origin so it persists back as read;
   * jsonValue is kept for a data-origin entry only, as only the accessor
   * adapter sets it
   */
  addWrittenReference(
    reference: SecretReference,
    encoding: SecretEncoding,
    dataOrigin: boolean,
    location: string,
    jsonValue = false,
  ): string {
    return dataOrigin
      ? this.issue({
        reference,
        encoding,
        dataOrigin: true,
        location,
        ...(jsonValue ? { jsonValue } : {}),
      })
      : this.issue({ reference, encoding, dataOrigin: false, location });
  }

  entryOf(sentinel: string): RegistryEntry | undefined {
    return this.registry.entryOf(sentinel);
  }

  /**
   * built by a load for one delivery attempt; this bag is left as it is, so the
   * next attempt loads again, and a view issues nothing
   */
  withLoaded(values: ReadonlyMap<string, string>): VaultSecretBag {
    const view = new VaultSecretBag(this.registry);
    for (const sentinel of this.issued) view.issued.push(sentinel);
    view.loaded = new Map([...(this.loaded ?? []), ...values]);
    return view;
  }

  /**
   * a number or boolean entry delivers text, which the boundary schema coerces
   * or refuses, since delivery cannot restore a scalar the sentinel may have
   * flowed from into a text field; an unloaded reference throws
   */
  private valueOf(sentinel: string): string | undefined {
    const entry = this.registry.entryOf(sentinel);
    if (entry === undefined) return undefined;
    if (holdsValue(entry)) return entry.value;
    const value = this.loadedValueOf(entry);
    return entry.encoding === "json" ? jsonEscaped(value) : value;
  }

  private loadedValueOf(
    entry: VaultReferenceEntry | DataReferenceEntry,
  ): string {
    const value = this.loaded?.get(entry.sentinel);
    if (value === undefined) {
      const { vaultName, key } = entry.reference;
      throw new Error(
        `The secret '${key}' in vault '${vaultName}' (at ${entry.location}) was not loaded before delivery`,
      );
    }
    return value;
  }

  private inHand(sentinel: string): boolean {
    const entry = this.registry.entryOf(sentinel);
    return entry !== undefined &&
      (holdsValue(entry) || this.loaded?.has(sentinel) === true);
  }

  /**
   * JSON-escaped forms get their own json-encoded sentinel so a secret spliced
   * into JSON text round-trips to valid JSON; text inside existing sentinels is
   * never searched
   */
  sentinelizeText(text: string, secrets: readonly RecordedSecret[]): string {
    let segments: { text: string; sentinel: boolean }[] = splitOnSentinels(
      text,
    );
    for (const { value: secret, source } of secrets) {
      const escaped = jsonEscaped(secret);
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
   * re-issues sentinels from target so a value sanitized before the step is
   * delivered through that step's own bag; reference-only entries move as
   * references, with no value
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
      const jsonValue = isJsonValueEntry(entry);
      const issued = holdsValue(entry)
        ? target.addDataSecret(
          entry.value,
          entry.reference,
          entry.encoding,
          jsonValue,
        )
        : target.addWrittenReference(
          entry.reference,
          entry.encoding,
          entry.dataOrigin,
          entry.location,
          jsonValue,
        );
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

  private ownInHand(): string[] {
    return this.issued.filter((sentinel) => this.inHand(sentinel));
  }

  private shipped(sentinel: string): SecretBagEntry {
    const entry = this.registry.entryOf(sentinel)!;
    return {
      sentinel,
      value: this.valueOf(sentinel)!,
      dataOrigin: entry.dataOrigin,
      ...(parsesWhole(entry) ? { jsonValue: true as const } : {}),
    };
  }

  toEntries(): SecretBagEntry[] {
    return this.ownInHand().map((sentinel) => this.shipped(sentinel));
  }

  /**
   * own in-hand entries plus any other run entry whose sentinel occurs in args,
   * so a worker delivers what the arguments reference and nothing else; an
   * unloaded sentinel throws
   */
  entriesFor(args: unknown): SecretBagEntry[] {
    const sentinels = this.ownInHand();
    this.collectRunSentinels(args, sentinels);
    return sentinels.map((sentinel) => this.shipped(sentinel));
  }

  /**
   * serve admits these to the dispatch's secret reads since shipped args hold
   * values, not references; read via the registry so an unloaded reference is
   * listed, and an entry without a reference is skipped
   */
  referencesFor(args: unknown): SecretReference[] {
    const sentinels: string[] = [];
    this.collectRunSentinels(args, sentinels);
    const references: SecretReference[] = [];
    const seen = new Set<string>();
    for (const sentinel of sentinels) {
      const entry = this.registry.issuedEntryOf(sentinel);
      if (entry === undefined) continue;
      const id = `${entry.reference.vaultName}\u0000${entry.reference.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      references.push(entry.reference);
    }
    return references;
  }

  /**
   * a data entry that holds its value ships by reference too, so the worker
   * loads it like every other; an entry without a reference cannot ship this
   * way and throws
   */
  referenceEntriesFor(args: unknown): ShippedReferenceEntry[] {
    const sentinels: string[] = [];
    this.collectRunSentinels(args, sentinels);
    return sentinels.map((sentinel) => {
      const entry = this.registry.issuedEntryOf(sentinel);
      if (entry === undefined) {
        throw new Error(
          "A secret bag entry without a reference cannot be shipped by reference",
        );
      }
      return {
        sentinel,
        reference: entry.reference,
        encoding: entry.encoding,
        dataOrigin: entry.dataOrigin,
        ...(isJsonValueEntry(entry) ? { jsonValue: true as const } : {}),
        location: "location" in entry ? entry.location : "a data read",
      };
    });
  }

  private collectRunSentinels(args: unknown, sentinels: string[]): void {
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
  }

  /**
   * keeps each sentinel exactly as shipped; secrets added afterwards get this
   * bag's own prefix; entries come from one bag, so a repeated sentinel is
   * refused
   */
  static fromEntries(entries: readonly SecretBagEntry[]): VaultSecretBag {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    for (const entry of entries) {
      if (!SENTINEL_EXACT.test(entry.sentinel)) {
        throw new Error("Malformed vault secret sentinel in secret bag entry");
      }
      const { sentinel, value, dataOrigin } = entry;
      const jsonValue = dataOrigin && entry.jsonValue === true;
      bag.registry.register(
        jsonValue
          ? { sentinel, value, dataOrigin, jsonValue }
          : { sentinel, value, dataOrigin },
      );
      bag.issued.push(entry.sentinel);
      if (entry.dataOrigin) {
        bag.dataSentinels.set(
          dataSentinelKey(entry.value, jsonValue),
          entry.sentinel,
        );
      }
    }
    return bag;
  }

  /**
   * every entry is reference-only, so the bag delivers nothing until a load
   * builds a delivery view; a repeated sentinel is refused
   */
  static fromReferenceEntries(
    entries: readonly ShippedReferenceEntry[],
  ): VaultSecretBag {
    const bag = new VaultSecretBag(new SecretBagRegistry());
    for (const entry of entries) {
      if (!SENTINEL_EXACT.test(entry.sentinel)) {
        throw new Error("Malformed vault secret sentinel in secret bag entry");
      }
      if (bag.registry.entryOf(entry.sentinel) !== undefined) {
        throw new Error("Repeated vault secret sentinel in secret bag entry");
      }
      const { sentinel, reference, encoding, location } = entry;
      bag.registry.register(
        entry.dataOrigin
          ? {
            sentinel,
            reference,
            encoding,
            dataOrigin: true,
            location,
            ...(entry.jsonValue === true ? { jsonValue: true as const } : {}),
          }
          : { sentinel, reference, encoding, dataOrigin: false, location },
      );
      bag.issued.push(sentinel);
    }
    return bag;
  }

  get isEmpty(): boolean {
    return this.issued.length === 0;
  }

  /**
   * the gate for delivery, since a step's arguments can carry a sentinel an
   * earlier pass issued into the registry
   */
  get resolvesAny(): boolean {
    return !this.registry.isEmpty;
  }

  get rawValues(): string[] {
    return this.ownInHand().map((sentinel) => this.valueOf(sentinel)!);
  }

  /**
   * a vault reference resolves only through a delivery view that loaded it;
   * sentinel-shaped text with another prefix stays as it is
   */
  resolveRaw(str: string): string {
    return str.replace(
      VaultSecretBag.SENTINEL_PATTERN,
      (sentinel) => this.valueOf(sentinel) ?? sentinel,
    );
  }

  resolveDeep(data: unknown): unknown {
    if (typeof data === "string") {
      if (SENTINEL_EXACT.test(data)) {
        const entry = this.registry.entryOf(data);
        if (entry !== undefined && parsesWhole(entry)) {
          return deliveredJsonValue(this.valueOf(data)!);
        }
      }
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
   * shell expansion happens after parsing, so value metacharacters are never
   * syntax: bare ${VAR} inside double quotes, quoted outside, and a literal
   * (listed in singleQuoted) inside single quotes
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
   * values pass through the process environment; PowerShell's backtick escape
   * can mis-classify single-quoted regions, so keep vault sentinels outside
   * them
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

  private get originOf(): SecretOriginLookup {
    return secretOccurrencesOf(this.registry).originOf;
  }

  /**
   * a refused occurrence is the legacy paste: the value goes into the command
   * line and the result says so; a typed run refuses before this; a sentinel no
   * load filled throws
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

export function posixDataReference(
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

function posixVaultReference(envName: string, quote: QuoteContext): string {
  return quote === "double" ? `\${${envName}}` : `"\${${envName}}"`;
}

function powerShellReference(envName: string, quote: QuoteContext): string {
  return quote === "double" ? `$env:${envName}` : `"$env:${envName}"`;
}

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
 * a data value inside single quotes is refused, since PowerShell has no
 * break-out from them that is safe in every position; names are
 * case-insensitive, so authored keys are skipped whatever their case
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

interface ShellPlacementRules<C> {
  caseInsensitiveNames: boolean;
  classify: (command: string, positions: number[]) => C[];
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
