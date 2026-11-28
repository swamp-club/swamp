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

export const STREAMING_JSON_SLICE_UNITS = 1024 * 1024;

export interface StreamingJsonOptions {
  /** a string longer than this, in UTF-16 units, is escaped a slice at a time */
  readonly longStringUnits?: number;
  readonly sliceUnits?: number;
}

/** the bytes of `JSON.stringify(value)`, with long strings escaped a slice at a time */
export class StreamingJson {
  private constructor(
    /** the JSON text between long strings; one more than `longStrings` */
    private readonly texts: readonly string[],
    private readonly longStrings: readonly string[],
    private readonly sliceUnits: number,
  ) {}

  /** throws what `JSON.stringify(value)` throws, having called the same toJSON */
  static resolve(
    value: unknown,
    options: StreamingJsonOptions = {},
  ): StreamingJson {
    const longStringUnits = options.longStringUnits ??
      STREAMING_JSON_SLICE_UNITS;
    // two units, so a slice ending on a high surrogate still moves forward
    const sliceUnits = Math.max(
      2,
      options.sliceUnits ?? STREAMING_JSON_SLICE_UNITS,
    );
    // the engine walks the value, so key order, toJSON, boxed primitives and
    // every error are its own; the token is unseen by any code in the value
    const token = `"swamp-long-string-${crypto.randomUUID()}"`;
    const longStrings: string[] = [];
    const text = JSON.stringify(value, (_key, child: unknown) => {
      if (typeof child === "string" && child.length > longStringUnits) {
        longStrings.push(child);
        return token.slice(1, -1);
      }
      return child;
    }) as string | undefined;
    // TextEncoder encodes an undefined input as no bytes
    const texts = text === undefined ? [""] : text.split(token);
    if (texts.length !== longStrings.length + 1) {
      throw new Error(
        "Cannot serialize the resource: a placeholder for a long string did not resolve.",
      );
    }
    return new StreamingJson(texts, longStrings, sliceUnits);
  }

  /** whether it is worth writing a slice at a time rather than whole */
  get streams(): boolean {
    return this.longStrings.length > 0 ||
      this.texts[0].length > this.sliceUnits;
  }

  /** the whole encoded text; for output that does not stream */
  bytes(): Uint8Array {
    if (this.longStrings.length > 0) {
      throw new Error("StreamingJson.bytes: the output holds long strings");
    }
    return new TextEncoder().encode(this.texts[0]);
  }

  /** counted a slice at a time; nothing the size of the output is built */
  byteLength(): number {
    const encoder = new TextEncoder();
    let scratch = new Uint8Array(0);
    let total = 0;
    for (const slice of this.textSlices()) {
      // at most three bytes for each UTF-16 unit
      if (scratch.length < slice.length * 3) {
        scratch = new Uint8Array(slice.length * 3);
      }
      total += encoder.encodeInto(slice, scratch).written;
    }
    return total;
  }

  *chunks(): Generator<Uint8Array> {
    const encoder = new TextEncoder();
    for (const slice of this.textSlices()) {
      if (slice.length > 0) yield encoder.encode(slice);
    }
  }

  private *textSlices(): Generator<string> {
    for (let i = 0; i < this.texts.length; i++) {
      if (i > 0) {
        yield '"';
        for (
          const slice of slicesOf(this.longStrings[i - 1], this.sliceUnits)
        ) {
          // a slice holds no split pair, so a lone surrogate in it is lone in
          // the whole string and escapes as the engine escapes it
          yield JSON.stringify(slice).slice(1, -1);
        }
        yield '"';
      }
      yield* slicesOf(this.texts[i], this.sliceUnits);
    }
  }
}

function* slicesOf(text: string, units: number): Generator<string> {
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + units);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
