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
 * runs after the boundary conversion, so an evaluator result holds no Secret;
 * the query view walks a projection that still holds Secrets and names them
 * through keep so they return as they are
 */

import { Environment, Optional } from "cel-js";

interface CelUnsignedInt {
  readonly value: bigint;
}

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

function durationFromNanos(total: bigint): CelDuration {
  return new (DurationType as DurationConstructor)(
    total / NANOS_PER_SECOND,
    Number(total % NANOS_PER_SECOND),
  );
}

// cel-js adds and subtracts durations assuming nanos is never negative, and ==
// compares stored fields; replace both on the shared prototype with total-based
// versions. Remove once cel-js fixes it
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

/** cel-js's own toString misprints negative durations, so format from the total */
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
 * ints beyond MAX_SAFE_INTEGER stay bigint; an object keep answers true for is
 * returned as is, decided first, so a Secret or adapted record view reaches the
 * expression by identity
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
