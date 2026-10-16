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

/**
 * Datastore formats this binary reads and writes. Format 2 is the v2 layout:
 * an `_index/` sharded index, `_meta.json` and `.datastore.lock` on S3/GCS,
 * plain files on a filesystem datastore. A datastore without a format marker
 * is format 2. Format 3 is the v3 commit log (`commits.db` and content
 * chunks); see {@link supportedDatastoreFormatsFor}.
 */
export const SUPPORTED_DATASTORE_FORMATS: readonly number[] = [2, 3];

/**
 * The formats this binary reads on S3, GCS and extension datastores. v3
 * there (swamp-club#3534) also needs a provider that can host it
 * (`assertV3Hosting`), which the format guard checks once it reads a
 * format-3 marker.
 */
export const SUPPORTED_CUSTOM_DATASTORE_FORMATS: readonly number[] = [2, 3];

/** The format assumed for a datastore that carries no format marker. */
export const UNMARKED_DATASTORE_FORMAT = 2;

/** The v3 commit-log format (datastore rework Phase 3). */
export const V3_DATASTORE_FORMAT = 3;

/**
 * The storage engine a datastore is opened with: `v2` writes files and
 * syncs them, `v3` commits every change to the commit log. Chosen once per
 * datastore from its format marker (swamp-club#3279).
 */
export type DatastoreEngine = "v2" | "v3";

/**
 * The engine for a format this binary accepted. Formats from 3 up are read
 * by the v3 engine, since the guard has already refused any whose
 * `minReaderFormat` is above what this binary reads.
 */
export function engineForFormat(format: number): DatastoreEngine {
  return format >= V3_DATASTORE_FORMAT ? "v3" : "v2";
}

/**
 * The formats this binary reads on a datastore of the given kind. Both
 * kinds read v3; an extension datastore also needs a v3-capable provider.
 */
export function supportedDatastoreFormatsFor(
  kind: "filesystem" | "custom",
): readonly number[] {
  return kind === "filesystem"
    ? SUPPORTED_DATASTORE_FORMATS
    : SUPPORTED_CUSTOM_DATASTORE_FORMATS;
}

/**
 * Control-plane key of the format marker on datastores whose sync service
 * advertises `controlPlane`. Read through a sync service that has not bound a
 * namespace, so it resolves to the datastore-wide `_control/` root.
 */
export const DATASTORE_FORMAT_MARKER_KEY = "datastore-format";

/** File name of the format marker at the root of a filesystem datastore. */
export const DATASTORE_FORMAT_MARKER_FILE = "datastore-format.json";

/** Largest marker accepted; anything bigger is refused as not a marker. */
export const DATASTORE_FORMAT_MARKER_MAX_BYTES = 64 * 1024;

/** Error code for a datastore whose format this binary cannot read. */
export const DATASTORE_FORMAT_UNSUPPORTED_CODE = "datastore_format_unsupported";

/** Error code for a format marker that exists but is not a valid marker. */
export const DATASTORE_FORMAT_MARKER_INVALID_CODE =
  "datastore_format_marker_invalid";

/** The longest `writtenBy` value shown in an error message. */
const MAX_WRITTEN_BY_DISPLAY = 64;

/** A parsed datastore format marker. */
export interface DatastoreFormatMarker {
  /** The format the datastore is written in. */
  readonly format: number;
  /** The oldest reader format that can read it; defaults to `format`. */
  readonly minReaderFormat?: number;
  /** The swamp version that wrote the marker, for the error message. */
  readonly writtenBy?: string;
}

/**
 * What reading a datastore's format marker found. `source` names the
 * control-plane key or file for error messages.
 */
export type DatastoreFormatMarkerRead =
  | { readonly kind: "absent" }
  | {
    readonly kind: "present";
    readonly source: string;
    readonly bytes: Uint8Array;
  }
  | {
    /** The reader found something at the marker location that is not one. */
    readonly kind: "invalid";
    readonly source: string;
    readonly reason: string;
  }
  | {
    /** The read failed for a reason other than "not found". */
    readonly kind: "unreadable";
    readonly source: string;
    readonly error: unknown;
  }
  | {
    /** The datastore cannot carry a marker this binary can read. */
    readonly kind: "unsupported";
    readonly reason: string;
  };

/** The outcome of a format check that did not refuse. */
export type DatastoreFormatDecision =
  | { readonly kind: "supported"; readonly format: number }
  | { readonly kind: "skipped"; readonly reason: string };

/**
 * Thrown when a datastore's format marker names a format this binary cannot
 * read. Raised before anything is written to the datastore.
 */
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

/**
 * Thrown when a datastore carries something at its format marker location
 * that cannot be read as a marker. Treating it as format 2 would be the
 * unsafe direction, so swamp refuses instead.
 */
export class InvalidDatastoreFormatMarkerError extends UserError {
  readonly source: string;

  constructor(source: string, reason: string) {
    super(
      `The datastore format marker ${source} is not a valid format marker ` +
        `(${reason}). swamp will not use a datastore whose format it cannot ` +
        `determine. Check who wrote it; if swamp did, report it with ` +
        "`swamp issue bug`. Nothing was changed.",
      DATASTORE_FORMAT_MARKER_INVALID_CODE,
    );
    this.name = "InvalidDatastoreFormatMarkerError";
    this.source = source;
  }
}

/** Error code for a datastore config whose `format` its marker contradicts. */
export const DATASTORE_FORMAT_MISMATCH_CODE = "datastore_format_mismatch";

/**
 * Thrown when a filesystem datastore's config asks for one format and its
 * marker records another. The marker is what a datastore is written in; a
 * config that disagrees was edited by hand or points at the wrong path, and
 * opening either engine over it could write the wrong layout.
 */
export class DatastoreFormatMismatchError extends UserError {
  readonly configured: number;
  readonly marked?: number;

  constructor(configured: number, marked: number | undefined) {
    super(
      `The datastore config in .swamp.yaml says format ${configured}, but ` +
        (marked === undefined
          ? "the datastore has no readable format marker"
          : `the datastore's format marker says format ${marked}`) +
        ". Check that the datastore path is the one setup created, or run " +
        "`swamp datastore setup` again. Nothing was changed.",
      DATASTORE_FORMAT_MISMATCH_CODE,
    );
    this.name = "DatastoreFormatMismatchError";
    this.configured = configured;
    if (marked !== undefined) this.marked = marked;
  }
}

/** Error code for a filesystem datastore whose marker cannot be read. */
export const DATASTORE_FORMAT_MARKER_UNREADABLE_CODE =
  "datastore_format_marker_unreadable";

/**
 * Thrown when a filesystem datastore's format marker exists but cannot be
 * read (swamp-club#3279). The marker chooses the engine, so a datastore whose
 * marker cannot be read could be v3 and must not be opened as v2.
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
 * Thrown when an extension datastore's format marker cannot be read, and
 * its provider could host v3 (swamp-club#3534): it may say v3, and opening a
 * v3 datastore as v2 would write v2 files into it, so swamp refuses rather
 * than guess.
 */
export class UnreachableDatastoreFormatMarkerError extends UserError {
  readonly source: string;

  constructor(source: string, reason: string) {
    super(
      `The datastore format marker ${source} could not be read (${reason}). ` +
        "It may say format 3, so swamp will not open this datastore as " +
        "format 2. Check the datastore's connectivity and credentials, and " +
        "run the command again. Nothing was changed.",
      DATASTORE_FORMAT_MARKER_UNREADABLE_CODE,
    );
    this.name = "UnreachableDatastoreFormatMarkerError";
    this.source = source;
  }
}

/**
 * Parses a format marker. Unknown keys are ignored so later writers can add
 * fields; the known ones must have the right shape.
 *
 * @throws InvalidDatastoreFormatMarkerError when the bytes are not a marker
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
 * Decides whether this binary may use a datastore, given what reading its
 * format marker found.
 *
 * - No marker: format 2, supported.
 * - A marker whose `minReaderFormat` (or `format`) is above the highest
 *   supported format: refused.
 * - A marker that is not a valid marker: refused.
 * - A failed read, or a datastore that cannot carry a marker: skipped. The
 *   check does not block offline or degraded use; today's commands surface
 *   the same outage themselves.
 *
 * @throws UnsupportedDatastoreFormatError when the format is newer
 * @throws InvalidDatastoreFormatMarkerError when the marker is garbled
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
