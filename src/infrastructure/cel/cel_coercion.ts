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

/**
 * The coercion of CEL results to the plain values the rest of the codebase
 * expects. It runs after the boundary conversion (design/enablers/
 * typed-secrets.md Section 3.2), so an evaluator's result holds no `Secret`
 * when it is walked; the query view (Section 6.2) walks a projection that
 * still holds Secrets and adapted record views, and names them through
 * `keep` so they return to the calling expression as they are.
 */

import { Environment, Optional } from "cel-js";

/** The shape of cel-js's `uint` value. */
interface CelUnsignedInt {
  readonly value: bigint;
}

/** The shape of cel-js's `google.protobuf.Duration` value. */
interface CelDuration {
  readonly seconds: bigint;
  readonly nanos: number;
}

// cel-js does not export its uint and duration classes, so take their
// constructors from a value of each.
const celTypeProbe = new Environment();
const UnsignedIntType = (celTypeProbe.evaluate("1u") as object).constructor;
const DurationType = (celTypeProbe.evaluate("duration('0s')") as object)
  .constructor;

const NANOS_PER_SECOND = 1_000_000_000n;

type DurationConstructor = new (seconds: bigint, nanos: number) => CelDuration;

function durationNanos(duration: CelDuration): bigint {
  return duration.seconds * NANOS_PER_SECOND + BigInt(duration.nanos);
}

/**
 * Builds a duration from its total in nanoseconds, with `seconds` and `nanos`
 * sharing the sign of the total — the form cel-js gives a parsed duration.
 */
function durationFromNanos(total: bigint): CelDuration {
  return new (DurationType as DurationConstructor)(
    total / NANOS_PER_SECOND,
    Number(total % NANOS_PER_SECOND),
  );
}

// cel-js 7.6.1 (and 8.0.0) adds and subtracts durations assuming `nanos` is
// never negative, but a negative duration it parses keeps a negative `nanos`,
// so `duration('-1.5s') + duration('-0.6s')` came out as -3.1s. Its `==`
// compares the stored fields, so it also needs every duration in one form.
// Replace both methods on the shared prototype with versions that work from
// the total; this module is loaded by cel_evaluator.ts before any CEL is
// evaluated, so every Environment in the process gets them (swamp-club#3714).
// Remove once cel-js ships a fix; cel_js_duration_pin_test.ts pins what this
// relies on.
if (
  typeof DurationType.prototype.addDuration === "function" &&
  typeof DurationType.prototype.subtractDuration === "function"
) {
  Object.assign(DurationType.prototype, {
    addDuration(this: CelDuration, other: CelDuration): CelDuration {
      return durationFromNanos(durationNanos(this) + durationNanos(other));
    },
    subtractDuration(this: CelDuration, other: CelDuration): CelDuration {
      return durationFromNanos(durationNanos(this) - durationNanos(other));
    },
  });
}

/**
 * Formats a duration in CEL's string form (`90s`, `1.5s`, `-1.5s`). cel-js's
 * own `toString()` misprints negative durations, so this works from the total.
 */
function formatDuration(duration: CelDuration): string {
  const total = durationNanos(duration);
  const sign = total < 0n ? "-" : "";
  const magnitude = total < 0n ? -total : total;
  const seconds = magnitude / NANOS_PER_SECOND;
  const nanos = magnitude % NANOS_PER_SECOND;
  if (nanos === 0n) return `${sign}${seconds}s`;
  const fraction = nanos.toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${seconds}.${fraction}s`;
}

function coerceInt(value: bigint): number | bigint {
  if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
    return Number(value);
  }
  return value;
}

/**
 * Recursively converts CEL result values to the plain values the rest of
 * the codebase expects, following CEL's JSON mapping:
 * - int and uint become numbers; values outside Number.MAX_SAFE_INTEGER are
 *   left as bigint to avoid silent precision loss
 * - timestamp becomes its ISO 8601 string, duration its CEL string (`90s`)
 *   and bytes a base64 string
 * - optionals unwrap to their value, or null when empty
 *
 * An object `keep` answers true for is returned as it is, decided before any
 * other object branch so nothing is read through it: the query view keeps a
 * `Secret`, whose traps refuse a walk, and an adapted record view, whose
 * leaves hold no CEL value, so both reach the calling expression by
 * identity (typed-secrets Section 6.2). Without `keep` every object is
 * walked, as an evaluator's released result is.
 */
export function coerceBigInts(
  value: unknown,
  keep?: (value: object) => boolean,
): unknown {
  if (typeof value === "bigint") {
    return coerceInt(value);
  }
  if (value !== null && typeof value === "object" && keep?.(value) === true) {
    return value;
  }
  if (value instanceof Optional) {
    return coerceBigInts(value.hasValue() ? value.value() : null, keep);
  }
  if (Array.isArray(value)) {
    return value.map((item) => coerceBigInts(item, keep));
  }
  if (value instanceof Date) {
    return value.toJSON();
  }
  if (value instanceof DurationType) {
    return formatDuration(value as CelDuration);
  }
  if (value instanceof UnsignedIntType) {
    return coerceInt((value as CelUnsignedInt).value);
  }
  if (value instanceof Uint8Array) {
    return value.toBase64();
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(result, k, {
        value: coerceBigInts(v, keep),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}
