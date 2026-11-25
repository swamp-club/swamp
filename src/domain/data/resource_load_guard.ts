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

import { getHeapStatistics } from "node:v8";
import { getLogger } from "@logtape/logtape";
import { UserError } from "../errors.ts";
import { escapeLogTemplate } from "../../infrastructure/logging/logger.ts";
import {
  DEFAULT_RESOURCE_WARN_BYTES,
  describeByteCount,
} from "./resource_size_policy.ts";

const logger = getLogger(["swamp", "data", "resource-size"]);

export interface HeapProbe {
  heapLimitBytes(): number;
  heapUsedBytes(): number;
}

export const v8HeapProbe: HeapProbe = {
  heapLimitBytes: () => getHeapStatistics().heap_size_limit,
  heapUsedBytes: () => Deno.memoryUsage().heapUsed,
};

// decoding holds one copy of the text and JSON.parse builds one to two more
export const DECODED_HEAP_FACTOR = 3;

// the structure estimate sits at V8's measured layout costs, so a tenth more covers measurement noise
export const PARSE_ESTIMATE_MARGIN = 1.1;

// V8's sizes: an object with four in-object slots, an array, a slot per element or extra member
const PARSED_OBJECT_BYTES = 56;
const PARSED_OBJECT_INLINE_MEMBERS = 4;
const PARSED_ARRAY_BYTES = 48;
const PARSED_SLOT_BYTES = 8;
// a line string's header plus its slots in the split array and the kept array
export const SPLIT_LINE_BYTES = 64;
// what a kept line still holds once the split array is gone
export const KEPT_LINE_BYTES = 32;
const NEWLINE = 0x0a;

/** newline count plus one, from raw bytes off the V8 heap */
export function countLines(content: Uint8Array): number {
  let lines = 1;
  let at = content.indexOf(NEWLINE);
  while (at !== -1) {
    lines++;
    at = content.indexOf(NEWLINE, at + 1);
  }
  return lines;
}
// past this many members V8 holds an object as a dictionary, at this cost per member
const FAST_OBJECT_MAX_MEMBERS = 64;
const DICTIONARY_MEMBER_BYTES = 48;
// V8 shares repeated values up to this length; longer ones are each a string
const SHARED_STRING_MAX_BYTES = 10;
const STRING_HEADER_BYTES = 24;
// what a distinct key adds beyond its string: its place in object layouts
const KEY_LAYOUT_BYTES = 40;
// a fraction or wide integer among non-numbers is its own heap number
const HEAP_NUMBER_BYTES = 16;
const SMALL_INTEGER_MAX_DIGITS = 9;
// UTF-8 lead bytes from here encode characters past Latin-1, which V8 holds at two bytes each
const TWO_BYTE_LEAD = 0xc4;
// from here a character is outside the basic plane, two UTF-16 units
const ASTRAL_LEAD = 0xf0;
const ESCAPE_U = 0x75;
const LATIN1_MAX = 0xff;

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return 0;
}

/**
 * a bitmap sized to the content: it holds fewer distinct strings than bytes, and
 * 64 bits a byte keeps collisions rare, so a small body never pays for a large one
 */
export function distinctBitsFor(contentBytes: number): number {
  return Math.min(
    DISTINCT_BITS,
    2 ** Math.ceil(Math.log2(Math.max(64, 64 * contentBytes))),
  );
}

/**
 * what TextDecoder makes of the raw bytes: characters past Latin-1, and the
 * U+FFFD it puts for invalid ones, both held two-byte by V8; and UTF-16 units
 * less bytes
 */
class Utf8Width {
  wide = 0;
  unitsLessBytes = 0;
  #continuations = 0;
  // the range the next continuation must fall in, narrower after some leads
  #low = 0x80;
  #high = 0xbf;

  get pending(): boolean {
    return this.#continuations > 0;
  }

  feed(byte: number): void {
    if (this.#continuations > 0) {
      if (byte >= this.#low && byte <= this.#high) {
        this.#continuations--;
        this.unitsLessBytes--;
        this.#low = 0x80;
        this.#high = 0xbf;
        return;
      }
      // a sequence cut short or broken decodes to U+FFFD
      this.#continuations = 0;
      this.#low = 0x80;
      this.#high = 0xbf;
      this.wide++;
    }
    if (byte < 0x80) return;
    // a stray continuation (0x80-0xbf), an overlong or out-of-range lead: U+FFFD each
    if (byte < 0xc2 || byte > 0xf4) {
      this.wide++;
      return;
    }
    if (byte >= TWO_BYTE_LEAD) this.wide++;
    // as TextDecoder does: no overlong, surrogate or past-U+10FFFF sequences
    if (byte === 0xe0) this.#low = 0xa0;
    else if (byte === 0xed) this.#high = 0x9f;
    else if (byte === 0xf0) this.#low = 0x90;
    else if (byte === 0xf4) this.#high = 0x8f;
    if (byte < 0xe0) this.#continuations = 1;
    else if (byte < ASTRAL_LEAD) this.#continuations = 2;
    else {
      this.#continuations = 3;
      this.unitsLessBytes++;
    }
  }

  end(): void {
    if (this.#continuations > 0) this.wide++;
    this.#continuations = 0;
  }
}

// seeded per process, so strings that collide cannot be worked out ahead of time
const HASH_SEED = crypto.getRandomValues(new Uint32Array(1))[0];

/** spreads every hash bit into the low bits that pick a bitmap bit */
function mixHash(hash: number): number {
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const PLUS = 0x2b;
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;

const IS_ARRAY = 1;
const HOLDS = 2;
const HOLDS_NON_NUMBER = 4;
const EXPECTS_KEY = 8;

// 2^23 bits, 1 MiB off the V8 heap; as it fills, the count rises towards every string seen
const DISTINCT_BITS = 1 << 23;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function isDigit(byte: number): boolean {
  return byte >= ZERO && byte <= NINE;
}

function stringBytes(length: number): number {
  return STRING_HEADER_BYTES + Math.ceil(length / 8) * 8;
}

// up to this many distinct strings are counted exactly; past it, by linear counting
const EXACT_DISTINCT = 4096;

/**
 * strings counted by their hashes: exactly while few, then in a bitmap held off
 * the V8 heap, allocated only once the exact count runs out
 */
export class DistinctStrings {
  // each distinct hash and its string's length, while few enough to keep
  #exact: Map<number, number> | undefined = new Map();
  #bits: Uint8Array | undefined;
  #set = 0;
  #newBytes = 0;
  #seen = 0;

  constructor(
    readonly size: number = DISTINCT_BITS,
    readonly exactLimit: number = EXACT_DISTINCT,
  ) {
    if (size < 8 || (size & (size - 1)) !== 0) {
      throw new RangeError(
        "DistinctStrings size must be a power of two of 8 or more",
      );
    }
  }

  add(hash: number, length: number): void {
    this.#seen++;
    const mixed = mixHash(hash);
    if (this.#exact !== undefined) {
      if (this.#exact.has(mixed)) return;
      if (this.#exact.size < this.exactLimit) {
        this.#exact.set(mixed, length);
        this.#newBytes += length;
        return;
      }
      this.#bits = new Uint8Array(this.size / 8);
      this.#newBytes = 0;
      for (const [seen, seenLength] of this.#exact) {
        if (this.#setBit(seen)) this.#newBytes += seenLength;
      }
      this.#exact = undefined;
    }
    if (this.#setBit(mixed)) this.#newBytes += length;
  }

  /** true when the bit was clear */
  #setBit(mixed: number): boolean {
    const bit = mixed & (this.size - 1);
    const mask = 1 << (bit & 7);
    if (this.#bits![bit >>> 3] & mask) return false;
    this.#bits![bit >>> 3] |= mask;
    this.#set++;
    return true;
  }

  /** the heap their strings take, at the average length of the distinct ones */
  bytes(perString: number): number {
    if (this.#exact !== undefined) {
      const distinct = this.#exact.size;
      return distinct === 0
        ? 0
        : distinct * (perString + stringBytes(this.#newBytes / distinct));
    }
    // a full bitmap estimates infinity, so every string seen is the bound
    const distinct = Math.min(
      this.#seen,
      Math.round(-this.size * Math.log(1 - this.#set / this.size)),
    );
    return distinct * (perString + stringBytes(this.#newBytes / this.#set));
  }
}

/**
 * the heap JSON.parse builds for the first top-level value, from containers,
 * strings and numbers; string length counts UTF-16 units and escapes as bytes,
 * doubled for a string V8 holds two bytes per character, so errs high
 */
export function estimateParsedJsonBytes(
  content: Uint8Array,
  cap: number = Number.POSITIVE_INFINITY,
): number {
  // TextDecoder drops a leading byte-order mark before the parse sees the text
  let start = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
    ? 3
    : 0;
  while (start < content.length && isJsonWhitespace(content[start])) start++;
  if (content[start] !== OPEN_OBJECT && content[start] !== OPEN_ARRAY) return 0;

  let total = 0;
  // per open container, in typed arrays so deep nesting grows no V8 heap
  let flags = new Uint8Array(64);
  let commas = new Uint32Array(64);
  let heapNumbers = new Uint32Array(64);
  let depth = 0;
  const bits = distinctBitsFor(content.length);
  const keys = new DistinctStrings(bits);
  const shortValues = new DistinctStrings(bits);
  const text = new Utf8Width();
  let inString = false;
  let escaped = false;
  let stringIsKey = false;
  let stringStart = 0;
  let stringWideAt = 0;
  let stringUnitsLessBytesAt = 0;
  let escapeWide = false;
  let escapeDigits = 0;
  let escapeValue = 0;
  let hash = FNV_OFFSET ^ HASH_SEED;
  let inNumber = false;
  let numberDigits = 0;
  let numberIsHeap = false;

  const closeContainer = (): void => {
    depth--;
    const items = flags[depth] & HOLDS ? commas[depth] + 1 : 0;
    if (flags[depth] & IS_ARRAY) {
      total += PARSED_ARRAY_BYTES + PARSED_SLOT_BYTES * items;
      if (flags[depth] & HOLDS_NON_NUMBER) {
        total += HEAP_NUMBER_BYTES * heapNumbers[depth];
      }
    } else if (items > FAST_OBJECT_MAX_MEMBERS) {
      total += PARSED_OBJECT_BYTES + DICTIONARY_MEMBER_BYTES * items +
        HEAP_NUMBER_BYTES * heapNumbers[depth];
    } else {
      // V8 keeps no double fields in place, so each one is its own heap number
      total += PARSED_OBJECT_BYTES +
        PARSED_SLOT_BYTES * Math.max(0, items - PARSED_OBJECT_INLINE_MEMBERS) +
        HEAP_NUMBER_BYTES * heapNumbers[depth];
    }
  };
  const endNumber = (): void => {
    inNumber = false;
    if (
      depth > 0 && (numberIsHeap || numberDigits > SMALL_INTEGER_MAX_DIGITS)
    ) {
      heapNumbers[depth - 1]++;
    }
  };
  const finish = (from: number): number => {
    if (inNumber) endNumber();
    // JSON.parse builds what is open before it fails at the end
    while (depth > 0) closeContainer();
    // the whole text is decoded, so its width also depends on what follows
    for (let i = from; i < content.length; i++) {
      if (content[i] >= 0x80 || text.pending) text.feed(content[i]);
    }
    text.end();
    // a raw character past Latin-1 makes the decoded text two-byte; escapes stay ASCII
    const textUnits = content.length + text.unitsLessBytes;
    return total + keys.bytes(KEY_LAYOUT_BYTES) + shortValues.bytes(0) +
      (text.wide > 0 ? Math.max(0, 2 * textUnits - content.length) : 0);
  };

  for (let i = start; i < content.length; i++) {
    const byte = content[i];
    if (byte >= 0x80 || text.pending) text.feed(byte);
    if (inString) {
      if (escaped) {
        escaped = false;
        if (byte === ESCAPE_U) {
          escapeDigits = 4;
          escapeValue = 0;
        }
      } else if (escapeDigits > 0) {
        escapeValue = escapeValue * 16 + hexValue(byte);
        // only an escape past Latin-1 decodes to a character V8 holds two-byte
        if (--escapeDigits === 0 && escapeValue > LATIN1_MAX) escapeWide = true;
      } else if (byte === BACKSLASH) escaped = true;
      else if (byte === QUOTE) {
        inString = false;
        const bytes = i - stringStart;
        const units = bytes + text.unitsLessBytes - stringUnitsLessBytesAt;
        const twoByte = escapeWide || text.wide > stringWideAt;
        const length = twoByte ? 2 * units : units;
        if (stringIsKey) keys.add(hash, length);
        else if (bytes > SHARED_STRING_MAX_BYTES) total += stringBytes(length);
        else shortValues.add(hash, length);
        continue;
      }
      if (stringIsKey || i - stringStart <= SHARED_STRING_MAX_BYTES) {
        hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
      }
      continue;
    }
    if (inNumber) {
      if (isDigit(byte)) {
        numberDigits++;
        continue;
      }
      if (byte === DOT || byte === LOWER_E || byte === UPPER_E) {
        numberIsHeap = true;
        continue;
      }
      if (byte === PLUS || byte === MINUS) continue;
      endNumber();
    }
    const top = depth - 1;
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      if (top >= 0) flags[top] |= HOLDS | HOLDS_NON_NUMBER;
      if (depth === flags.length) {
        const grownFlags = new Uint8Array(depth * 2);
        grownFlags.set(flags);
        flags = grownFlags;
        const grownCommas = new Uint32Array(depth * 2);
        grownCommas.set(commas);
        commas = grownCommas;
        const grownNumbers = new Uint32Array(depth * 2);
        grownNumbers.set(heapNumbers);
        heapNumbers = grownNumbers;
      }
      flags[depth] = byte === OPEN_ARRAY ? IS_ARRAY : EXPECTS_KEY;
      commas[depth] = 0;
      heapNumbers[depth] = 0;
      depth++;
      // every open container costs at least an array once closed
      if (total + depth * PARSED_ARRAY_BYTES > cap) {
        return total + depth * PARSED_ARRAY_BYTES;
      }
    } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      if (depth === 0) continue;
      closeContainer();
      if (total > cap) return total;
      if (depth === 0) return finish(i + 1);
    } else if (byte === COMMA) {
      if (top < 0) continue;
      commas[top]++;
      if (!(flags[top] & IS_ARRAY)) flags[top] |= EXPECTS_KEY;
    } else if (byte === QUOTE) {
      inString = true;
      stringStart = i + 1;
      stringWideAt = text.wide;
      stringUnitsLessBytesAt = text.unitsLessBytes;
      escapeWide = false;
      escapeDigits = 0;
      hash = FNV_OFFSET ^ HASH_SEED;
      stringIsKey = top >= 0 && (flags[top] & EXPECTS_KEY) !== 0;
      if (top >= 0) {
        flags[top] = (flags[top] & ~EXPECTS_KEY) | HOLDS | HOLDS_NON_NUMBER;
      }
    } else if (byte === MINUS || isDigit(byte)) {
      inNumber = true;
      numberDigits = isDigit(byte) ? 1 : 0;
      numberIsHeap = false;
      if (top >= 0) flags[top] |= HOLDS;
    } else if (byte !== COLON && !isJsonWhitespace(byte) && top >= 0) {
      flags[top] |= HOLDS | HOLDS_NON_NUMBER;
    }
  }
  return finish(content.length);
}

export interface LoadedItemRef {
  readonly modelType: string;
  readonly modelName?: string;
  readonly dataName: string;
  /** absent when the read took the latest version without naming it */
  readonly version?: number;
}

export function describeLoadedItem(item: LoadedItemRef): string {
  const owner = item.modelName ? item.modelName : item.modelType;
  const version = item.version === undefined ? "" : `@v${item.version}`;
  return `${owner}/${item.dataName}${version}`;
}

/** TextDecoder refuses more bytes than V8's maximum string length */
export const MAX_DECODABLE_BYTES = 2 ** 29 - 24;

export type TooLargeToLoadReason = "memory" | "text-length";

/** recorded on an item a reader left unloaded, so the read that needs it fails */
export interface TooLargeToLoad {
  readonly bytes: number;
  readonly reason: TooLargeToLoadReason;
}

/** the marker as stored data carries it; anything malformed is no marker */
export function parseTooLargeToLoad(
  value: unknown,
): TooLargeToLoad | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { bytes, reason } = value as Record<string, unknown>;
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
  if (reason !== "memory" && reason !== "text-length") return undefined;
  return { bytes, reason };
}

/** message detail only; the persisted marker never carries it */
export interface TooLargeToLoadDetail {
  /** earlier items the read still holds when it was refused */
  readonly heldBytes?: number;
  /** the base64 length that passed the text limit */
  readonly encodedChars?: number;
  /** what the caller can do to read less, as advice opening with a verb */
  readonly remedy?: string;
}

function tooLargeExplanation(
  reason: TooLargeToLoadReason,
  detail: TooLargeToLoadDetail,
): string {
  if (reason === "text-length") {
    return detail.encodedChars === undefined
      ? "more than swamp can load as text"
      : `and its base64 form of ${detail.encodedChars} characters is more than swamp can load as text`;
  }
  return detail.heldBytes
    ? `and with ${
      describeByteCount(detail.heldBytes)
    } of other items this read already holds, loading it would exhaust the memory left to this process`
    : "and loading it would exhaust the memory left to this process";
}

/** names the item and its size only: serve relays it to remote callers */
export class ResourceTooLargeToLoadError extends UserError {
  constructor(
    readonly item: LoadedItemRef,
    readonly bytes: number,
    readonly reason: TooLargeToLoadReason = "memory",
    readonly detail: TooLargeToLoadDetail = {},
  ) {
    const listLargest =
      `swamp data query 'size > ${DEFAULT_RESOURCE_WARN_BYTES}' --select '{"model": modelName, "name": name, "version": version, "size": size}' --sort size:desc --limit 20`;
    const remedy = reason !== "memory" ? undefined : detail.remedy ??
      (detail.heldBytes ? "read fewer items at once" : undefined);
    const advice = remedy
      ? `${
        remedy[0].toUpperCase() + remedy.slice(1)
      }, or list the largest data items without loading them with: `
      : "List the largest data items without loading them with: ";
    super(
      `Cannot load ${describeLoadedItem(item)}: it is ${
        describeByteCount(bytes)
      }, ${tooLargeExplanation(reason, detail)}. ${advice}${listLargest}`,
      "resource_too_large_to_load",
    );
    this.name = "ResourceTooLargeToLoadError";
  }
}

/**
 * heapUsed counts garbage not yet collected, so an item near the limit can be
 * refused that V8 would have fit; the floor keeps small reads out of that
 */
export class ResourceLoadGuard {
  constructor(
    private readonly probe: HeapProbe = v8HeapProbe,
    readonly floorBytes: number = DEFAULT_RESOURCE_WARN_BYTES,
    readonly maxDecodableBytes: number = MAX_DECODABLE_BYTES,
  ) {}

  assertLoadable(item: LoadedItemRef, bytes: number): void {
    const refusal = this.#memoryRefusal(item, bytes);
    if (refusal) throw refusal;
  }

  /** assertLoadable for content in hand that will be parsed as JSON */
  assertParsable(item: LoadedItemRef, content: Uint8Array): void {
    const refusal = this.#memoryRefusal(item, content.length, {
      parsed: content,
    });
    if (refusal) throw refusal;
  }

  /**
   * the heap check plus the text-length limit, for callers that record a
   * refusal; heldBytes, earlier items the read still holds, counts toward the
   * floor only, since the heap in use already includes them
   */
  refusalFor(
    item: LoadedItemRef,
    bytes: number,
    heldBytes = 0,
    remedy?: string,
  ): ResourceTooLargeToLoadError | undefined {
    if (bytes > this.maxDecodableBytes) {
      return new ResourceTooLargeToLoadError(item, bytes, "text-length");
    }
    return this.#memoryRefusal(item, bytes, { heldBytes, remedy });
  }

  /** refusalFor for content in hand that will be parsed as JSON */
  parseRefusalFor(
    item: LoadedItemRef,
    content: Uint8Array,
    heldBytes = 0,
    remedy?: string,
  ): ResourceTooLargeToLoadError | undefined {
    if (content.length > this.maxDecodableBytes) {
      return new ResourceTooLargeToLoadError(
        item,
        content.length,
        "text-length",
      );
    }
    return this.#memoryRefusal(item, content.length, {
      parsed: content,
      heldBytes,
      remedy,
    });
  }

  /**
   * refusalFor for content in hand that will be decoded and split into lines;
   * lines defaults to every line, and a reader keeping fewer passes its count
   */
  splitRefusalFor(
    item: LoadedItemRef,
    content: Uint8Array,
    heldBytes = 0,
    remedy?: string,
    lines: number = countLines(content),
  ): ResourceTooLargeToLoadError | undefined {
    if (content.length > this.maxDecodableBytes) {
      return new ResourceTooLargeToLoadError(
        item,
        content.length,
        "text-length",
      );
    }
    return this.#memoryRefusal(item, content.length, {
      split: content.length + lines * SPLIT_LINE_BYTES,
      heldBytes,
      remedy,
    });
  }

  /**
   * parsed is priced by its JSON structure, split by its line estimate, which
   * also stands in for the bytes at the floor; with nothing held, a split
   * refusal names its remedy only when the lines, not the decode, tipped it
   */
  #memoryRefusal(
    item: LoadedItemRef,
    bytes: number,
    options: {
      readonly parsed?: Uint8Array;
      readonly split?: number;
      readonly heldBytes?: number;
      readonly remedy?: string;
    } = {},
  ): ResourceTooLargeToLoadError | undefined {
    const { parsed, split, heldBytes = 0, remedy } = options;
    if (!((split ?? bytes) + heldBytes >= this.floorBytes)) return undefined;
    const limit = this.probe.heapLimitBytes();
    const used = this.probe.heapUsedBytes();
    let needed = bytes * DECODED_HEAP_FACTOR;
    let overCap = false;
    // the scan runs only when the cheaper byte estimate would admit the item
    if (parsed !== undefined && used + needed <= limit) {
      const cap = (limit - used - bytes) / PARSE_ESTIMATE_MARGIN;
      const structure = estimateParsedJsonBytes(parsed, cap);
      // a scan stopped past cap refuses whatever rounding the product takes
      overCap = structure > cap;
      needed = Math.max(
        needed,
        bytes + Math.ceil(PARSE_ESTIMATE_MARGIN * structure),
      );
    }
    if (split !== undefined) needed = Math.max(needed, split);
    if (!overCap && used + needed <= limit) return undefined;
    logger.warn(escapeLogTemplate(
      `Refused to load ${
        describeLoadedItem(item)
      } of ${bytes} bytes: about ${needed} bytes needed, ${used} of ${limit} heap bytes in use`,
    ));
    return new ResourceTooLargeToLoadError(
      item,
      bytes,
      "memory",
      heldBytes > 0
        ? { heldBytes, ...(remedy ? { remedy } : {}) }
        : split !== undefined && remedy &&
            used + bytes * DECODED_HEAP_FACTOR <= limit
        ? { remedy }
        : {},
    );
  }
}

export const defaultResourceLoadGuard = new ResourceLoadGuard();

export function resourceLoadGuardOf(
  holder: { readonly loadGuard?: ResourceLoadGuard } | undefined,
): ResourceLoadGuard {
  return holder?.loadGuard ?? defaultResourceLoadGuard;
}
