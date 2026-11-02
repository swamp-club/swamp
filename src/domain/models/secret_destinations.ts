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

import type { z } from "zod";
import { UserError } from "../errors.ts";
import { SECRET_DESTINATION_REFUSED } from "../expressions/errors.ts";
import type {
  SecretBagRegistry,
  SecretReference,
} from "../vaults/secret_bag_registry.ts";
import {
  type SecretOccurrence,
  type SecretOccurrences,
  secretOccurrencesOf,
} from "../vaults/secret_occurrences.ts";
import type { MethodDefinition, ModelDefinition } from "./model.ts";
import {
  type FieldMetadata,
  findFieldsWhere,
  findValuesWithMetadata,
  schemaHoldsMetadata,
} from "./zod_field_metadata.ts";
import { coerceMethodArgs } from "./zod_type_coercion.ts";

/**
 * destination policy applied by the method boundary before any secret is
 * loaded: a field marked secrets: refuse takes no secret anywhere in its value;
 * the decision reads issued sentinels, never a value
 */

/**
 * the message names destination, reference and location, never a value or
 * sentinel. The stable code secret_destination_refused is in the text too,
 * since a rewrapping boundary keeps the message, not the class.
 */
export class SecretDestinationRefusedError extends UserError {
  constructor(
    readonly destination: string,
    /** The secret's reference; absent for an entry a worker rebuilt. */
    readonly reference: SecretReference | undefined,
    location: string | undefined,
    reason: string,
  ) {
    const secret = reference
      ? `secret '${reference.key}' in vault '${reference.vaultName}'`
      : "a secret of this run";
    const at = location === undefined ? "" : ` (at ${location})`;
    super(
      `Refused to deliver ${secret} to ${destination}${at}: ${reason} ` +
        `(${SECRET_DESTINATION_REFUSED})`,
      SECRET_DESTINATION_REFUSED,
    );
    this.name = "SecretDestinationRefusedError";
  }
}

export const REFUSE_SECRETS = "refuse";

/**
 * Whether field metadata marks the field as refusing secrets. Only the exact
 * value `refuse` does: `.meta()` is a free-form bag an extension may already
 * use a `secrets` key in, so any other value means nothing here.
 */
export function refusesSecrets(meta: FieldMetadata): boolean {
  return meta.secrets === REFUSE_SECRETS;
}

function isSensitive(meta: FieldMetadata): boolean {
  return Boolean(meta.sensitive);
}

function firstOccurrenceIn(
  value: unknown,
  secrets: SecretOccurrences,
  seen: WeakSet<object> = new WeakSet(),
): SecretOccurrence | undefined {
  if (typeof value === "string") return secrets.occurrencesIn(value)[0];
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    const found = firstOccurrenceIn(item, secrets, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * refuses a run secret anywhere in a value under a refusing field, including
 * text composed around a sentinel. A sentinel-shaped string the run did not
 * issue is ordinary data.
 */
export function refuseSecretsInRefusingFields(
  schema: z.ZodTypeAny,
  args: Record<string, unknown>,
  secrets: SecretOccurrences,
  where: string,
): void {
  if (!schemaHoldsMetadata(schema, refusesSecrets)) return;
  for (
    const { path, value } of findValuesWithMetadata(
      schema,
      args,
      refusesSecrets,
    )
  ) {
    const occurrence = firstOccurrenceIn(value, secrets);
    if (occurrence) {
      throw new SecretDestinationRefusedError(
        `${where} '${path}'`,
        occurrence.reference,
        occurrence.location,
        "the field refuses secrets; pass a value that is not a secret, or " +
          "deliver the secret through a field that takes one, such as an " +
          "environment variable",
      );
    }
  }
}

/**
 * fails when one field is both sensitive and secrets: refuse, since a sensitive
 * field goes to a vault and a refusing field never receives a secret. List
 * elements and record values are fields of their own.
 */
export function assertNoSensitiveRefuseConflict(
  schema: z.ZodTypeAny | undefined,
  owner: string,
): void {
  if (!schema) return;
  const conflicts = findFieldsWhere(
    schema,
    (chain) => chain.some(isSensitive) && chain.some(refusesSecrets),
  );
  if (conflicts.length > 0) {
    const field = conflicts[0] === ""
      ? "the schema"
      : `field '${conflicts[0]}'`;
    throw new Error(
      `${owner}: ${field} is marked both sensitive and secrets: "refuse". ` +
        `A sensitive field is stored in a vault and a refusing field never ` +
        `receives a secret, so a field cannot be both; remove one of the two ` +
        `markers.`,
    );
  }
}

export function assertModelSecretsMetadataValid(
  model: Pick<ModelDefinition, "type" | "globalArguments" | "methods">,
): void {
  const type = model.type.normalized;
  assertNoSensitiveRefuseConflict(
    model.globalArguments,
    `Behavior type '${type}' global arguments`,
  );
  for (const [name, method] of Object.entries(model.methods)) {
    assertNoSensitiveRefuseConflict(
      method.arguments,
      `Behavior type '${type}' method '${name}' arguments`,
    );
  }
}

export interface SecretDestinationStage {
  modelDef: ModelDefinition;
  /**
   * The method the attempt delivers to. Absent when no method is named, as
   * `swamp behavior validate` without `--method`: only the global arguments
   * are then checked.
   */
  method?: MethodDefinition;
  globalArguments: Record<string, unknown>;
  /**
   * raw method arguments over raw global arguments holding no unresolved
   * expression; the stage coerces them as validation will before any policy
   * reads them
   */
  mergedArguments: Record<string, unknown>;
  registry: SecretBagRegistry;
  /** False for a remotely placed step, whose shell is the worker's. */
  localPlacement: boolean;
}

/**
 * refuses a secret in a refusing global argument, then in a refusing field of
 * the merged arguments (a superset of the schema, erring toward refusal), then
 * via the method's hook for local placement. No sentinel, nothing to refuse.
 */
export function refuseSecretDestinations(stage: SecretDestinationStage): void {
  if (stage.registry.isEmpty) return;
  const secrets = secretOccurrencesOf(stage.registry);
  // read as validation will: JSON-string arguments are parsed before Zod sees
  // them, so a sentinel inside is read too; sentinels hold only JSON-safe
  // characters, so parsing keeps them intact
  const globalArguments = stage.modelDef.globalArguments
    ? coerceMethodArgs(stage.globalArguments, stage.modelDef.globalArguments)
    : stage.globalArguments;
  if (stage.modelDef.globalArguments) {
    refuseSecretsInRefusingFields(
      stage.modelDef.globalArguments,
      globalArguments,
      secrets,
      "global argument",
    );
  }
  if (stage.method === undefined) return;
  const mergedArguments = coerceMethodArgs(
    stage.mergedArguments,
    stage.method.arguments,
  );
  refuseSecretsInRefusingFields(
    stage.method.arguments,
    mergedArguments,
    secrets,
    "method argument",
  );
  if (stage.localPlacement) {
    stage.method.refuseSecretDestinations?.({
      arguments: mergedArguments,
      secrets,
    });
  }
}
