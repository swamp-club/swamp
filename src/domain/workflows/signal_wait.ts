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
import { quoteShellWord } from "../shell_word.ts";

/**
 * a deadline further out than a date or its stored form can hold would leave
 * the run impossible to save or the wait impossible to read back
 */
export const SIGNAL_WAIT_MAX_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

/**
 * the signal is held in plaintext with no run to remove it, so the limit is
 * kept short
 */
export const SIGNAL_ACCEPT_EARLY_MAX_SECONDS = 60 * 60;

export const SIGNAL_PAYLOAD_MAX_BYTES = 16 * 1024;

export const SIGNAL_PAYLOAD_MAX_DEPTH = 16;

/** the payload is read by guards, and these names are members of every object */
export const RESERVED_PAYLOAD_KEYS: ReadonlyArray<string> = [
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * a key becomes one segment of a control-plane key, so it holds no separator or
 * dot and has one spelling on a case-insensitive filesystem
 */
export const WAIT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * no file can have a Windows device name, so such a key could not be kept on a
 * filesystem datastore there
 */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function isWaitKey(key: string): boolean {
  return WAIT_KEY_PATTERN.test(key) && !WINDOWS_DEVICE_NAME.test(key);
}

export const SIGNAL_KEY_MAX_LENGTH = 64;

export const SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export const IDEMPOTENCY_KEY_FORM =
  `1 to ${SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH} letters, digits, dots, colons, hyphens and underscores`;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * names one signal across retries so a retry of a landed signal is answered
 * with it and nothing is delivered twice; kept in plaintext on the receipt, so
 * its form is narrow
 */
export function isIdempotencyKey(value: string): boolean {
  return value.length <= SIGNAL_IDEMPOTENCY_KEY_MAX_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * bounds client text on its way to a lookup and the audit log; a workflow with
 * a longer name is signalled by its id
 */
export const SIGNAL_WORKFLOW_MAX_LENGTH = 256;

export const WAIT_KEY_FORM =
  "1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit, and not a Windows device name (con, prn, aux, nul, com0 to com9, lpt0 to lpt9)";

export const WAIT_TIMEOUT_STEP_ERROR = "wait_timeout";

export const WAIT_UNREADABLE_STEP_ERROR = "wait_unreadable";

export const WAIT_KEY_HELD_STEP_ERROR = "wait_key_held";

export function openSignalWaitMessage(
  open: { jobName: string; stepName: string; wait: { id: string } },
): string {
  return `Step "${open.stepName}" in job "${open.jobName}" is still waiting for a signal. ` +
    `Run "swamp workflow signal ${open.wait.id} --payload '<json>'" first.`;
}

export function signalByKeyCommand(workflowName: string, key: string): string {
  return `swamp workflow signal --workflow ${
    quoteShellWord(workflowName)
  } --key ${quoteShellWord(key)} --payload '<json>'`;
}

export const SignalReceiptSchema = z.object({
  id: z.string().uuid(),
  waitId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  submittedBy: z.string().min(1),
  idempotencyKey: z.string().refine(isIdempotencyKey).optional(),
  /**
   * only the run view shows this: receiptForCaller leaves it out of step
   * outputs and sender replies, whose receipt shape is documented
   */
  heldAsPending: z.literal(true).optional(),
});

export type SignalReceipt = z.infer<typeof SignalReceiptSchema>;

export function receiptForCaller(receipt: SignalReceipt): SignalReceipt {
  const { heldAsPending: _heldAsPending, ...rest } = receipt;
  return rest;
}

export const WaitEarlySchema = z.object({
  generation: z.number().int().min(1),
  overRelease: z.boolean(),
  from: z.string().datetime(),
});

export type WaitEarly = z.infer<typeof WaitEarlySchema>;

/**
 * also reads the slot below when the claim was created over a release, which a
 * signal that read the key before the release wrote to
 */
export function earlySlots(early: WaitEarly): number[] {
  return early.overRelease && early.generation > 1
    ? [early.generation, early.generation - 1]
    : [early.generation];
}

export const SignalWaitSchema = z.object({
  kind: z.literal("signal"),
  id: z.string().uuid(),
  // Captured when the step started waiting, so a later edit to the workflow
  // file does not change what an open wait accepts.
  schema: RequiredInputsSchemaSchema,
  deadline: z.string().datetime(),
  receipt: SignalReceiptSchema.optional(),
  key: z.string().refine(isWaitKey).optional(),
  early: WaitEarlySchema.optional(),
});

export type SignalWaitData = z.infer<typeof SignalWaitSchema>;

export type PayloadValidation =
  | { readonly valid: true; readonly payload: Record<string, unknown> }
  | { readonly valid: false; readonly errors: string[] };

/**
 * a malformed wait is kept as broken with its raw value, so the run stays
 * loadable and a save writes the value back unchanged
 */
export type StoredWait =
  | { readonly kind: "valid"; readonly wait: SignalWait }
  | { readonly kind: "broken"; readonly raw: unknown };

export function parseStoredWait(raw: unknown): StoredWait | undefined {
  if (raw === undefined) return undefined;
  const parsed = SignalWaitSchema.safeParse(raw);
  return parsed.success
    ? { kind: "valid", wait: SignalWait.fromData(parsed.data) }
    : { kind: "broken", raw };
}

export function persistedWait(stored: StoredWait): unknown {
  return stored.kind === "valid" ? stored.wait.toData() : stored.raw;
}

/**
 * an expression left in a captured schema (reading self, steps or data) is not
 * resolved and would be compared with payloads as literal text
 */
export function schemaExpressions(schema: unknown): string[] {
  return extractExpressions(schema).map((location) => location.raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

const ANNOTATION_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "examples",
  "$comment",
]);

const TYPE_BOUND_SCHEMA_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ["required", "object"],
  ["properties", "object"],
  ["additionalProperties", "object"],
  ["items", "array"],
  ["minItems", "array"],
  ["maxItems", "array"],
  ["uniqueItems", "array"],
]);

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
      // a payload is stored as sent, but the validator lets null through for a
      // property with a default, which only suits a value the default then
      // replaces
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
 * the validator applies additionalProperties false only beside properties, so
 * an object closed without declaring any would accept any key
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
 * a payload arrives from outside the workflow, so a schema that promises more
 * than is checked is refused when the workflow is parsed
 */
export function unenforcedSchemaKeywords(schema: unknown): string[] {
  const found: string[] = [];
  collectUnenforcedKeywords(schema, "schema", true, found);
  return found;
}

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

export class SignalWait {
  private constructor(
    readonly id: string,
    readonly schema: InputsSchema,
    readonly deadline: Date,
    readonly receipt: SignalReceipt | undefined,
    readonly key: string | undefined,
    readonly early: WaitEarly | undefined = undefined,
  ) {}

  static open(
    schema: InputsSchema,
    timeoutSeconds: number,
    now: Date,
    maxTimeoutSeconds: number = SIGNAL_WAIT_MAX_TIMEOUT_SECONDS,
    key?: string,
  ): SignalWait {
    if (key !== undefined && !isWaitKey(key)) {
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

  static fromData(data: SignalWaitData): SignalWait {
    const validated = SignalWaitSchema.parse(data);
    return new SignalWait(
      validated.id,
      validated.schema,
      new Date(validated.deadline),
      validated.receipt,
      validated.key,
      validated.early,
    );
  }

  withEarly(early: WaitEarly): SignalWait {
    if (this.key === undefined) {
      throw new Error("Only a wait that holds a key takes an early signal.");
    }
    return new SignalWait(
      this.id,
      this.schema,
      this.deadline,
      this.receipt,
      this.key,
      { ...early },
    );
  }

  get isSettled(): boolean {
    return this.receipt !== undefined;
  }

  isExpired(now: Date): boolean {
    return now.getTime() > this.deadline.getTime();
  }

  /**
   * the accepted payload is the value as sent, re-read from its own JSON so
   * only plain data is kept: defaults are never applied and nothing is coerced
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

    // checked as one object-typed property so the top level follows the same
    // rules as every level below; otherwise an inputs schema is read as a flat
    // map and additionalProperties is not applied
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

  settledWith(receipt: SignalReceipt): SignalWait {
    return new SignalWait(
      this.id,
      this.schema,
      this.deadline,
      { ...receipt },
      this.key,
      this.early,
    );
  }

  toData(): SignalWaitData {
    const data: SignalWaitData = {
      kind: "signal",
      id: this.id,
      schema: structuredClone(this.schema),
      deadline: this.deadline.toISOString(),
    };
    if (this.receipt) data.receipt = { ...this.receipt };
    if (this.key !== undefined) data.key = this.key;
    if (this.early !== undefined) data.early = { ...this.early };
    return data;
  }

  equals(other: SignalWait): boolean {
    return canonicalJson(this.toData()) === canonicalJson(other.toData());
  }
}
