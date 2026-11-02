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

import { maxOf } from "../array_extrema.ts";
import { UserError } from "../errors.ts";

export const SUPPORTED_DATASTORE_FORMATS: readonly number[] = [2, 3];

/**
 * v3 on these also needs a provider that can host it (assertV3Hosting), which
 * the format guard checks once it reads a format-3 marker
 */
export const SUPPORTED_CUSTOM_DATASTORE_FORMATS: readonly number[] = [2, 3];

export const UNMARKED_DATASTORE_FORMAT = 2;

export const V3_DATASTORE_FORMAT = 3;

export type DatastoreEngine = "v2" | "v3";

/**
 * formats from 3 up use the v3 engine, since the guard has already refused any
 * whose minReaderFormat is above what this binary reads
 */
export function engineForFormat(format: number): DatastoreEngine {
  return format >= V3_DATASTORE_FORMAT ? "v3" : "v2";
}

export function supportedDatastoreFormatsFor(
  kind: "filesystem" | "custom",
): readonly number[] {
  return kind === "filesystem"
    ? SUPPORTED_DATASTORE_FORMATS
    : SUPPORTED_CUSTOM_DATASTORE_FORMATS;
}

/**
 * read through a sync service that has not bound a namespace, so it resolves to
 * the datastore-wide _control/ root
 */
export const DATASTORE_FORMAT_MARKER_KEY = "datastore-format";

export const DATASTORE_FORMAT_MARKER_FILE = "datastore-format.json";

export const DATASTORE_FORMAT_MARKER_MAX_BYTES = 64 * 1024;

export const DATASTORE_FORMAT_UNSUPPORTED_CODE = "datastore_format_unsupported";

export const DATASTORE_FORMAT_MARKER_INVALID_CODE =
  "datastore_format_marker_invalid";

const MAX_WRITTEN_BY_DISPLAY = 64;

export interface DatastoreFormatMarker {
  readonly format: number;
  readonly minReaderFormat?: number;
  readonly writtenBy?: string;
}

export type DatastoreFormatMarkerRead =
  | { readonly kind: "absent" }
  | {
    readonly kind: "present";
    readonly source: string;
    readonly bytes: Uint8Array;
  }
  | {
    readonly kind: "invalid";
    readonly source: string;
    readonly reason: string;
  }
  | {
    readonly kind: "unreadable";
    readonly source: string;
    readonly error: unknown;
  }
  | {
    readonly kind: "unsupported";
    readonly reason: string;
  };

export type DatastoreFormatDecision =
  | { readonly kind: "supported"; readonly format: number }
  | { readonly kind: "skipped"; readonly reason: string };

export class UnsupportedDatastoreFormatError extends UserError {
  readonly format: number;
  readonly minReaderFormat: number;
  readonly supported: readonly number[];
  readonly writtenBy?: string;

  constructor(marker: DatastoreFormatMarker, supported: readonly number[]) {
    const required = marker.minReaderFormat ?? marker.format;
    const writtenBy = displayWrittenBy(marker.writtenBy);
    super(
      `This datastore uses format ${marker.format}` +
        (writtenBy ? ` (written by swamp ${writtenBy})` : "") +
        "." +
        (required !== marker.format
          ? ` Reading it needs format ${required} support.`
          : "") +
        ` This version of swamp supports format${
          supported.length === 1 ? "" : "s"
        } ${supported.join(", ")} only. Upgrade swamp to use it. Nothing was ` +
        "changed.",
      DATASTORE_FORMAT_UNSUPPORTED_CODE,
    );
    this.name = "UnsupportedDatastoreFormatError";
    this.format = marker.format;
    this.minReaderFormat = required;
    this.supported = supported;
    this.writtenBy = marker.writtenBy;
  }
}

/** treating it as format 2 would be the unsafe direction, so swamp refuses */
export class InvalidDatastoreFormatMarkerError extends UserError {
  readonly source: string;

  constructor(source: string, reason: string, advice?: string) {
    super(
      `The datastore format marker ${source} is not a valid format marker ` +
        `(${reason}). swamp will not use a datastore whose format it cannot ` +
        `determine. ` +
        (advice ??
          "Check who wrote it; if swamp did, report it with `swamp issue bug`.") +
        " Nothing was changed.",
      DATASTORE_FORMAT_MARKER_INVALID_CODE,
    );
    this.name = "InvalidDatastoreFormatMarkerError";
    this.source = source;
  }
}

export const DATASTORE_FORMAT_MISMATCH_CODE = "datastore_format_mismatch";

/**
 * a config that disagrees with the marker was edited by hand or points at the
 * wrong path, and opening either engine over it could write the wrong layout
 */
export class DatastoreFormatMismatchError extends UserError {
  readonly configured: number;
  readonly marked?: number;

  constructor(
    configured: number,
    marked: number | undefined,
    advice?: string,
  ) {
    super(
      `The datastore config in .swamp.yaml says format ${configured}, but ` +
        (marked === undefined
          ? "the datastore has no readable format marker"
          : `the datastore's format marker says format ${marked}`) +
        ". " +
        (advice ??
          "Check that the datastore path is the one setup created, or run " +
            "`swamp datastore setup` again.") +
        " Nothing was changed.",
      DATASTORE_FORMAT_MISMATCH_CODE,
    );
    this.name = "DatastoreFormatMismatchError";
    this.configured = configured;
    if (marked !== undefined) this.marked = marked;
  }
}

/**
 * a crash can leave nothing, or only whitespace and NUL bytes, as when a file's
 * length reached the disk before its content; partial JSON is not blank,
 * something wrote it
 */
export function isBlankDatastoreFormatMarker(bytes: Uint8Array): boolean {
  return bytes.every((byte) =>
    byte === 0x00 || byte === 0x20 || byte === 0x09 || byte === 0x0a ||
    byte === 0x0d
  );
}

/**
 * where swamp met a datastore whose marker a crash lost beside its v3 commit
 * log; the context decides the way out: v3-config, config (including datastore
 * overrides, which name no format), or setup-target
 */
export type LostFormatMarkerContext = "v3-config" | "config" | "setup-target";

export function lostFormatMarkerAdvice(
  context: LostFormatMarkerContext,
): string {
  const lost =
    "It holds a v3 commit log, so a crash may have lost its format marker.";
  switch (context) {
    case "v3-config":
      return `${lost} Run \`swamp doctor datastores --repair\` to check ` +
        "the datastore and restore the marker.";
    case "config":
      return `${lost} This repository's config does not use it as v3. If ` +
        "a datastore override (SWAMP_DATASTORE or --datastore) points here, " +
        "unset it. Then run `swamp doctor datastores --repair` in the " +
        "repository whose .swamp.yaml uses this datastore with format 3, or " +
        "check that the datastore path is the right one.";
    case "setup-target":
      return `${lost} If \`swamp datastore setup filesystem --format 3\` ` +
        "stopped part-way here, run it again; otherwise run " +
        "`swamp doctor datastores --repair` in the repository that uses " +
        "this datastore.";
  }
}

/**
 * opened as format 2 it would get v2 files written into it, so swamp refuses; a
 * config that says format 3 gets DatastoreFormatMismatchError instead
 */
export class LostDatastoreFormatMarkerError extends UserError {
  readonly datastorePath: string;
  readonly context: LostFormatMarkerContext;

  constructor(datastorePath: string, context: LostFormatMarkerContext) {
    super(
      `The datastore ${datastorePath} has no format marker. swamp will not ` +
        "open it as format 2. " + lostFormatMarkerAdvice(context) +
        " Nothing was changed.",
      DATASTORE_FORMAT_MISMATCH_CODE,
    );
    this.name = "LostDatastoreFormatMarkerError";
    this.datastorePath = datastorePath;
    this.context = context;
  }
}

export const DATASTORE_FORMAT_MARKER_UNREADABLE_CODE =
  "datastore_format_marker_unreadable";

/**
 * the marker chooses the engine, so a datastore whose marker cannot be read
 * could be v3 and must not be opened as v2
 */
export class UnreadableDatastoreFormatMarkerError extends UserError {
  readonly source: string;

  constructor(source: string, reason: string) {
    super(
      `The datastore format marker ${source} exists but could not be read ` +
        `(${reason}). swamp will not open a datastore whose format it cannot ` +
        "determine. Check the file's permissions. Nothing was changed.",
      DATASTORE_FORMAT_MARKER_UNREADABLE_CODE,
    );
    this.name = "UnreadableDatastoreFormatMarkerError";
    this.source = source;
  }
}

/**
 * the marker may say v3, and opening a v3 datastore as v2 would write v2 files
 * into it, so swamp refuses rather than guess; under a config that says format
 * 3 the message only says the marker could not be read
 */
export class UnreachableDatastoreFormatMarkerError extends UserError {
  readonly source: string;

  constructor(source: string, reason: string, configuredFormat?: number) {
    super(
      `The datastore format marker ${source} could not be read (${reason}). ` +
        (configuredFormat === V3_DATASTORE_FORMAT
          ? ""
          : "It may say format 3, so swamp will not open this datastore as " +
            "format 2. ") +
        "Check the datastore's connectivity and credentials, and run the " +
        "command again. Nothing was changed.",
      DATASTORE_FORMAT_MARKER_UNREADABLE_CODE,
    );
    this.name = "UnreachableDatastoreFormatMarkerError";
    this.source = source;
  }
}

/**
 * unknown keys are ignored so later writers can add fields; the known ones must
 * have the right shape
 */
export function parseDatastoreFormatMarker(
  bytes: Uint8Array,
  source: string,
): DatastoreFormatMarker {
  if (bytes.byteLength > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
    throw new InvalidDatastoreFormatMarkerError(
      source,
      `larger than ${DATASTORE_FORMAT_MARKER_MAX_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidDatastoreFormatMarkerError(source, "not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidDatastoreFormatMarkerError(source, "not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const format = record.format;
  if (!isFormatNumber(format)) {
    throw new InvalidDatastoreFormatMarkerError(
      source,
      "format must be a positive integer",
    );
  }
  const minReaderFormat = record.minReaderFormat;
  if (minReaderFormat !== undefined && !isFormatNumber(minReaderFormat)) {
    throw new InvalidDatastoreFormatMarkerError(
      source,
      "minReaderFormat must be a positive integer",
    );
  }
  const writtenBy = record.writtenBy;
  if (writtenBy !== undefined && typeof writtenBy !== "string") {
    throw new InvalidDatastoreFormatMarkerError(
      source,
      "writtenBy must be a string",
    );
  }
  return {
    format,
    ...(minReaderFormat !== undefined ? { minReaderFormat } : {}),
    ...(writtenBy !== undefined ? { writtenBy } : {}),
  };
}

/**
 * a failed read, or a datastore that cannot carry a marker, is skipped so the
 * check does not block offline or degraded use
 */
export function assertSupportedDatastoreFormat(
  read: DatastoreFormatMarkerRead,
  supported: readonly number[] = SUPPORTED_DATASTORE_FORMATS,
): DatastoreFormatDecision {
  switch (read.kind) {
    case "absent":
      return { kind: "supported", format: UNMARKED_DATASTORE_FORMAT };
    case "invalid":
      throw new InvalidDatastoreFormatMarkerError(read.source, read.reason);
    case "unreadable":
      return {
        kind: "skipped",
        reason: `could not read ${read.source}: ${describe(read.error)}`,
      };
    case "unsupported":
      return { kind: "skipped", reason: read.reason };
    case "present": {
      const marker = parseDatastoreFormatMarker(read.bytes, read.source);
      const required = marker.minReaderFormat ?? marker.format;
      // An empty supported list cannot occur with the constant; read it as
      // the unmarked format rather than refusing everything.
      if (required > (maxOf(supported) ?? UNMARKED_DATASTORE_FORMAT)) {
        throw new UnsupportedDatastoreFormatError(marker, supported);
      }
      return { kind: "supported", format: marker.format };
    }
  }
}

function isFormatNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1;
}

/**
 * The marker comes from the datastore, so strip control characters before it
 * reaches a terminal and cap its length.
 */
function displayWrittenBy(writtenBy: string | undefined): string | undefined {
  if (writtenBy === undefined) return undefined;
  // deno-lint-ignore no-control-regex
  const printable = writtenBy.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (printable.length === 0) return undefined;
  return printable.length > MAX_WRITTEN_BY_DISPLAY
    ? `${printable.slice(0, MAX_WRITTEN_BY_DISPLAY)}…`
    : printable;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
