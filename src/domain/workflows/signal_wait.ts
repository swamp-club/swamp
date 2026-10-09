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

import { z } from "zod";
import {
  type InputsSchema,
  type JsonSchemaProperty,
  RequiredInputsSchemaSchema,
} from "../definitions/definition.ts";
import { InputValidationService } from "../inputs/input_validation_service.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";

/**
 * The longest a wait may stay open, in seconds: one year. A deadline further
 * out than a date can hold, or than its stored form can express, would leave
 * the run impossible to save or the wait impossible to read back.
 */
export const SIGNAL_WAIT_MAX_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

/** The largest signal payload accepted, as serialised JSON, in bytes. */
export const SIGNAL_PAYLOAD_MAX_BYTES = 16 * 1024;

/** How deep a signal payload may nest. The payload itself is depth 1. */
export const SIGNAL_PAYLOAD_MAX_DEPTH = 16;

/**
 * Keys a signal payload may not use at any depth, whatever its schema allows.
 * The payload is read by guards, and these name members of every object.
 */
export const RESERVED_PAYLOAD_KEYS: ReadonlyArray<string> = [
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * The form of a wait's key: 1 to 64 lowercase letters, digits, hyphens and
 * underscores, starting with a letter or digit. A key becomes one segment
 * of a control-plane key, so it holds no separator and no dot, and has one
 * spelling on a filesystem that ignores case. It can hold no expression.
 */
export const WAIT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** What a refused key is told the form is. */
export const WAIT_KEY_FORM =
  "1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit";

/** The error a step fails with when its wait passed its deadline unsignalled. */
export const WAIT_TIMEOUT_STEP_ERROR = "wait_timeout";

/**
 * The error a waiting step fails with when the wait stored on it cannot be
 * read, so it has no id to signal and no deadline to pass.
 */
export const WAIT_UNREADABLE_STEP_ERROR = "wait_unreadable";

/**
 * The error a step fails with when another open wait holds the key its own
 * wait declares (swamp-club#3209).
 */
export const WAIT_KEY_HELD_STEP_ERROR = "wait_key_held";

/** Why a resume refuses a run with an open signal wait, and the next step. */
export function openSignalWaitMessage(
  open: { jobName: string; stepName: string; wait: { id: string } },
): string {
  return `Step "${open.stepName}" in job "${open.jobName}" is still waiting for a signal. ` +
    `Run "swamp workflow signal ${open.wait.id} --payload '<json>'" first.`;
}

/**
 * What swamp records about the signal that settled a wait. Written by swamp,
 * never by the sender.
 */
export const SignalReceiptSchema = z.object({
  id: z.string().uuid(),
  waitId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  submittedBy: z.string().min(1),
});

export type SignalReceipt = z.infer<typeof SignalReceiptSchema>;

/**
 * A wait as stored on a step. `kind` leaves room for other kinds of wait.
 */
export const SignalWaitSchema = z.object({
  kind: z.literal("signal"),
  id: z.string().uuid(),
  // Captured when the step started waiting, so a later edit to the workflow
  // file does not change what an open wait accepts.
  schema: RequiredInputsSchemaSchema,
  deadline: z.string().datetime(),
  receipt: SignalReceiptSchema.optional(),
  // The key the step declared, if any (swamp-club#3209).
  key: z.string().regex(WAIT_KEY_PATTERN).optional(),
});

export type SignalWaitData = z.infer<typeof SignalWaitSchema>;

/** A payload a wait accepts, or why it refuses one. */
export type PayloadValidation =
  | { readonly valid: true; readonly payload: Record<string, unknown> }
  | { readonly valid: false; readonly errors: string[] };

/**
 * A wait as read from a run record. A malformed wait is kept as `broken`
 * with its raw value, so the run stays loadable and a save writes the value
 * back unchanged.
 */
export type StoredWait =
  | { readonly kind: "valid"; readonly wait: SignalWait }
  | { readonly kind: "broken"; readonly raw: unknown };

/** Reads a step's `wait` field; undefined when absent. */
export function parseStoredWait(raw: unknown): StoredWait | undefined {
  if (raw === undefined) return undefined;
  const parsed = SignalWaitSchema.safeParse(raw);
  return parsed.success
    ? { kind: "valid", wait: SignalWait.fromData(parsed.data) }
    : { kind: "broken", raw };
}

/** The value a wait persists as: its data, or the raw value it was read from. */
export function persistedWait(stored: StoredWait): unknown {
  return stored.kind === "valid" ? stored.wait.toData() : stored.raw;
}

/**
 * The expressions left in a schema, as written. A wait captures its schema
 * as data, so an expression still in it when the step starts waiting (one
 * that reads `self`, `steps` or `data`, which workflow evaluation does not
 * resolve there) would be compared with payloads as literal text.
 */
export function schemaExpressions(schema: unknown): string[] {
  return extractExpressions(schema).map((location) => location.raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema keywords a payload is checked against. */
const ENFORCED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

/** Keywords that describe a value without constraining it. */
const ANNOTATION_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "examples",
  "$comment",
]);

/** Keywords checked only where the schema also declares the type. */
const TYPE_BOUND_SCHEMA_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ["required", "object"],
  ["properties", "object"],
  ["additionalProperties", "object"],
  ["items", "array"],
  ["minItems", "array"],
  ["maxItems", "array"],
  ["uniqueItems", "array"],
]);

/** The keywords a `wait_for_signal` schema may use, for a refusal message. */
export const SUPPORTED_WAIT_SCHEMA_KEYWORDS: readonly string[] = [
  ...ENFORCED_SCHEMA_KEYWORDS,
  ...ANNOTATION_SCHEMA_KEYWORDS,
];

function collectUnenforcedKeywords(
  node: unknown,
  path: string,
  isRoot: boolean,
  found: string[],
): void {
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    if (ANNOTATION_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "default") {
      // A payload is stored as sent. The validator also lets a null through
      // for a property with a default, which only suits a value the default
      // then replaces.
      found.push(`${path}.default: a default is never applied to a payload`);
      continue;
    }
    if (key === "enum" && Array.isArray(node.enum) && node.enum.length === 0) {
      found.push(`${path}.enum: an empty enum is not checked`);
      continue;
    }
    if (!ENFORCED_SCHEMA_KEYWORDS.has(key)) {
      found.push(`${path}.${key}: not a supported keyword`);
      continue;
    }
    // The root is always checked as an object, whether or not it says so.
    const boundTo = TYPE_BOUND_SCHEMA_KEYWORDS.get(key);
    const type = isRoot ? "object" : node.type;
    if (boundTo && type !== boundTo) {
      found.push(`${path}.${key}: only checked beside "type: ${boundTo}"`);
    }
  }
  if (isPlainObject(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) {
      collectUnenforcedKeywords(
        child,
        `${path}.properties.${name}`,
        false,
        found,
      );
    }
  }
  collectUnenforcedKeywords(node.items, `${path}.items`, false, found);
  collectUnenforcedKeywords(
    node.additionalProperties,
    `${path}.additionalProperties`,
    false,
    found,
  );
}

/**
 * A copy of `node` in which every object schema declares `properties`. The
 * validator applies `additionalProperties: false` only beside `properties`,
 * so an object closed without declaring any would otherwise accept any key.
 */
function withDeclaredProperties(node: JsonSchemaProperty): JsonSchemaProperty {
  const copy: JsonSchemaProperty = { ...node };
  if (copy.type === "object") {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties ?? {}).map((
        [name, child],
      ) => [name, withDeclaredProperties(child)]),
    );
  }
  if (isPlainObject(copy.items)) {
    copy.items = withDeclaredProperties(copy.items);
  }
  if (isPlainObject(copy.additionalProperties)) {
    copy.additionalProperties = withDeclaredProperties(
      copy.additionalProperties,
    );
  }
  return copy;
}

/**
 * The parts of a `wait_for_signal` schema no payload would be checked
 * against: a keyword the validator does not know, such as `pattern` or
 * `minimum`, one it reads only beside a `type` the schema does not declare,
 * an empty `enum`, which it skips, and a `default`, which is never applied. A payload arrives from outside the workflow, so a schema that
 * promises more than is checked is refused when the workflow is parsed.
 */
export function unenforcedSchemaKeywords(schema: unknown): string[] {
  const found: string[] = [];
  collectUnenforcedKeywords(schema, "schema", true, found);
  return found;
}

/** JSON with object keys sorted, so key order does not decide equality. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, child) =>
      isPlainObject(child)
        ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : child,
  );
}

/**
 * Collects a reserved key or excessive nesting anywhere in `value`. Stops at
 * the depth limit, so a deeply nested payload is never walked further.
 */
function structuralErrors(
  value: unknown,
  path: string,
  depth: number,
  errors: string[],
): void {
  if (typeof value !== "object" || value === null) return;
  if (depth > SIGNAL_PAYLOAD_MAX_DEPTH) {
    errors.push(
      `${path} nests deeper than ${SIGNAL_PAYLOAD_MAX_DEPTH} levels`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      structuralErrors(item, `${path}[${index}]`, depth + 1, errors)
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_PAYLOAD_KEYS.includes(key)) {
      errors.push(`${path}.${key} uses the reserved key "${key}"`);
      continue;
    }
    structuralErrors(child, `${path}.${key}`, depth + 1, errors);
  }
}

/**
 * SignalWait is a value object: one wait of a `wait_for_signal` step for a
 * JSON message. It carries the wait's id, the payload schema captured when
 * the step started waiting, its deadline, the key the step declared, if any,
 * and, once a signal settled it, the receipt.
 *
 * Immutable with equality based on value.
 */
export class SignalWait {
  private constructor(
    readonly id: string,
    readonly schema: InputsSchema,
    readonly deadline: Date,
    readonly receipt: SignalReceipt | undefined,
    readonly key: string | undefined,
  ) {}

  /**
   * Opens a wait that expires `timeoutSeconds` after `now`. Throws for a
   * timeout the task schema would refuse, so no wait holds a deadline that
   * cannot be stored, and for one above `maxTimeoutSeconds`, the lower
   * maximum of whoever runs the workflow (swamp-club#3109). A maximum above
   * {@link SIGNAL_WAIT_MAX_TIMEOUT_SECONDS} counts as that. Throws for a
   * `key` that is not in the form of {@link WAIT_KEY_PATTERN}.
   */
  static open(
    schema: InputsSchema,
    timeoutSeconds: number,
    now: Date,
    maxTimeoutSeconds: number = SIGNAL_WAIT_MAX_TIMEOUT_SECONDS,
    key?: string,
  ): SignalWait {
    if (key !== undefined && !WAIT_KEY_PATTERN.test(key)) {
      throw new Error(`A wait key must be ${WAIT_KEY_FORM}, got ${key}.`);
    }
    const max = Math.min(maxTimeoutSeconds, SIGNAL_WAIT_MAX_TIMEOUT_SECONDS);
    if (!(timeoutSeconds > 0) || !(timeoutSeconds <= max)) {
      throw new Error(
        `A wait timeout must be more than 0 and at most ${max} seconds, got ${timeoutSeconds}.`,
      );
    }
    return new SignalWait(
      crypto.randomUUID(),
      structuredClone(schema),
      new Date(now.getTime() + timeoutSeconds * 1000),
      undefined,
      key,
    );
  }

  /**
   * Reconstructs a wait from persisted data.
   */
  static fromData(data: SignalWaitData): SignalWait {
    const validated = SignalWaitSchema.parse(data);
    return new SignalWait(
      validated.id,
      validated.schema,
      new Date(validated.deadline),
      validated.receipt,
      validated.key,
    );
  }

  /** True once a signal settled the wait. */
  get isSettled(): boolean {
    return this.receipt !== undefined;
  }

  /** True when `now` is past the deadline. */
  isExpired(now: Date): boolean {
    return now.getTime() > this.deadline.getTime();
  }

  /**
   * Checks a payload against the wait: a JSON object, no larger than
   * {@link SIGNAL_PAYLOAD_MAX_BYTES}, free of reserved keys and excessive
   * nesting, and valid under the captured schema. The accepted payload is the
   * value as sent, re-read from its own JSON so only plain data is kept:
   * defaults are never applied and nothing is coerced.
   */
  validatePayload(payload: unknown): PayloadValidation {
    let json: string | undefined;
    try {
      json = JSON.stringify(payload);
    } catch {
      json = undefined;
    }
    if (json === undefined || !isPlainObject(payload)) {
      return { valid: false, errors: ["payload must be a JSON object"] };
    }
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > SIGNAL_PAYLOAD_MAX_BYTES) {
      return {
        valid: false,
        errors: [
          `payload is ${bytes} bytes, over the ${SIGNAL_PAYLOAD_MAX_BYTES} byte limit`,
        ],
      };
    }
    const plain = JSON.parse(json) as Record<string, unknown>;
    const structural: string[] = [];
    structuralErrors(plain, "payload", 1, structural);
    if (structural.length > 0) return { valid: false, errors: structural };

    // The payload is checked as one object-typed property, so its top level
    // follows the same rules as every level below it: an inputs schema is
    // otherwise read as a flat map of properties when it has none, and its
    // `additionalProperties` schema is not applied.
    const result = new InputValidationService().validate(
      { payload: plain },
      {
        properties: {
          payload: withDeclaredProperties({ ...this.schema, type: "object" }),
        },
      },
    );
    if (!result.valid) {
      return {
        valid: false,
        errors: result.errors.map((error) =>
          `payload: ${
            error.message.startsWith("payload.")
              ? error.message.slice("payload.".length)
              : error.message
          }`
        ),
      };
    }
    return { valid: true, payload: plain };
  }

  /**
   * The wait settled by the signal `receipt` records.
   */
  settledWith(receipt: SignalReceipt): SignalWait {
    return new SignalWait(
      this.id,
      this.schema,
      this.deadline,
      { ...receipt },
      this.key,
    );
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): SignalWaitData {
    const data: SignalWaitData = {
      kind: "signal",
      id: this.id,
      schema: structuredClone(this.schema),
      deadline: this.deadline.toISOString(),
    };
    if (this.receipt) data.receipt = { ...this.receipt };
    if (this.key !== undefined) data.key = this.key;
    return data;
  }

  /**
   * Value equality comparison.
   */
  equals(other: SignalWait): boolean {
    return canonicalJson(this.toData()) === canonicalJson(other.toData());
  }
}
