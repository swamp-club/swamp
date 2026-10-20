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
 * The destination policy of a method's arguments
 * (design/enablers/typed-secrets.md Sections 6.3 and 7.1), applied by the
 * method boundary before any secret is loaded. A field a behavior type marks
 * `.meta({ secrets: "refuse" })` takes no secret anywhere in its value; the
 * decision reads the sentinels the run issued, never a value. The metadata
 * sits beside `sensitive`, and the walker that reads one reads the other.
 */

/**
 * A destination that takes no secret was handed one, before any load
 * (design/enablers/typed-secrets.md Sections 6.3 and 7.1). The message
 * names the destination, the reference and where it was written or read,
 * never a value or a sentinel, in the shape every reference error takes:
 * `<what failed> (at <path>): <reason>`. The code is the stable
 * `secret_destination_refused` an expression refusal carries, in the text
 * too: a boundary that rewraps the error keeps its message, not its class.
 */
export class SecretDestinationRefusedError extends UserError {
  constructor(
    /** The destination as a user reads it: `method argument 'workingDir'`. */
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

/** The one value of the `secrets` metadata key: the field refuses secrets. */
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

/**
 * The first sentinel of the run anywhere in `value`, at any depth. A value
 * that contains itself is entered once.
 */
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
 * Refuses a secret of the run anywhere in a value under a field `schema`
 * marks `.meta({ secrets: "refuse" })`: a scalar, a nested field, a list or
 * map element, or text composed around a sentinel, found by the same walk
 * that finds sensitive fields. A sentinel-shaped string the run did not
 * issue is ordinary data. `where` names the destination family in the
 * error, as in `method argument 'workingDir'`.
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
 * Fails when a field of `schema` is marked both `sensitive` and
 * `secrets: "refuse"`, read across the field's whole wrapper chain, with a
 * union or intersection member read as part of its field. A list element or
 * a record value is a field of its own, so a `sensitive` list whose elements
 * refuse is two fields, not one conflict. A sensitive field is delivered to a
 * vault; a refusing field never receives a secret; one field cannot be both,
 * so the schema is wrong. `owner` says whose schema, for the message.
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

/**
 * Checks every argument schema of a behavior type at registration, so a
 * conflicting schema fails before the type can run.
 */
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

/** What one delivery attempt refuses before it loads anything. */
export interface SecretDestinationStage {
  modelDef: ModelDefinition;
  method: MethodDefinition;
  /** The definition's global arguments as written, sentinels in place. */
  globalArguments: Record<string, unknown>;
  /**
   * The method's arguments as `unresolvedMethodArgs` carries them: the raw
   * method arguments over the raw global arguments that hold no unresolved
   * expression, built by the boundary. The stage coerces them as validation
   * will before any policy reads them.
   */
  mergedArguments: Record<string, unknown>;
  registry: SecretBagRegistry;
  /** False for a remotely placed step, whose shell is the worker's. */
  localPlacement: boolean;
}

/**
 * The destination stage of a delivery attempt (Section 6.3, before the
 * load): a secret in a refusing global argument, then in a refusing field of
 * the merged arguments the method will see (a superset of what its schema
 * validates for a record-schema method, erring toward refusal, since the
 * method still receives the merge through `unresolvedMethodArgs`), then the
 * method's own `refuseSecretDestinations` hook, for local placement only. A
 * run that issued no sentinel has nothing to refuse.
 */
export function refuseSecretDestinations(stage: SecretDestinationStage): void {
  if (stage.registry.isEmpty) return;
  const secrets = secretOccurrencesOf(stage.registry);
  // Read as validation will: an argument authored as a JSON string for an
  // object, record or list field is parsed by `coerceMethodArgs` before Zod
  // sees it, so a sentinel it holds, in a key or a value, is read here too.
  // Sentinels hold only JSON-safe characters, so parsing keeps them intact.
  const globalArguments = stage.modelDef.globalArguments
    ? coerceMethodArgs(stage.globalArguments, stage.modelDef.globalArguments)
    : stage.globalArguments;
  const mergedArguments = coerceMethodArgs(
    stage.mergedArguments,
    stage.method.arguments,
  );
  if (stage.modelDef.globalArguments) {
    refuseSecretsInRefusingFields(
      stage.modelDef.globalArguments,
      globalArguments,
      secrets,
      "global argument",
    );
  }
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
