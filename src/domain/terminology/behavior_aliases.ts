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
 * The behavior spelling of stored and authored formats (swamp-club#3334).
 *
 * "Behavior" is the product term for what swamp used to call a model
 * (design/primitives/behaviors.md). Every stored format keeps the model name,
 * and swamp keeps writing it. Where a format is authored by people, the
 * behavior spelling is accepted as an exact synonym: each bounded context
 * translates it to the model spelling at its edge, before the value is used or
 * authorized. This table is the one list of those synonyms, and each
 * context's translator is tested against it.
 *
 * Only these exact spellings are synonyms. `behaviour`, plurals and other
 * near-misses are not: a misspelled deny rule must fail loudly rather than
 * match nothing (swamp-club#3130).
 */

/** The workflow step task type, behavior spelling, and its model form. */
export const BEHAVIOR_STEP_TASK_TYPE = "behavior";
export const MODEL_STEP_TASK_TYPE = "model_method";

/**
 * The behavior spelling of each `model_method` step task field, mapped to the
 * field it stands for.
 */
export const BEHAVIOR_STEP_TASK_FIELDS: Readonly<Record<string, string>> =
  Object.freeze({
    behavior: "modelIdOrName",
    behaviorType: "modelType",
    behaviorName: "modelName",
  });

/** The grant selector kind, behavior spelling, and its model form. */
export const BEHAVIOR_SELECTOR_KIND = "behavior";
export const MODEL_SELECTOR_KIND = "model";

/** The audit action prefix, behavior spelling, and its model form. */
export const BEHAVIOR_AUDIT_ACTION_PREFIX = "behavior.";
export const MODEL_AUDIT_ACTION_PREFIX = "model.";

/** The audit resource prefix, behavior spelling, and its model form. */
export const BEHAVIOR_AUDIT_RESOURCE_PREFIX = "behavior:";
export const MODEL_AUDIT_RESOURCE_PREFIX = "model:";

/**
 * A grant selector or audit resource kind in its model form: `behavior`
 * becomes `model`, and every other kind is returned unchanged.
 */
export function canonicalResourceKind(kind: string): string {
  return kind === BEHAVIOR_SELECTOR_KIND ? MODEL_SELECTOR_KIND : kind;
}

/** `value` with a leading `from` replaced by `to`, otherwise unchanged. */
export function replacePrefix(
  value: string,
  from: string,
  to: string,
): string {
  return value.startsWith(from) ? to + value.slice(from.length) : value;
}

/**
 * The extension entry-point export, behavior spelling, and its model form
 * (swamp-club#3338). A module exports one or the other, never both.
 */
export const BEHAVIOR_EXPORT_NAME = "behavior";
export const MODEL_EXPORT_NAME = "model";

/**
 * The extension source directory name, behavior spelling, and its model
 * form. Swamp loads `extensions/behaviors/` beside `extensions/models/` only
 * while the models directory is the default one; archives always carry the
 * sources under `models/`.
 */
export const BEHAVIORS_DIR_NAME = "behaviors";
export const MODELS_DIR_NAME = "models";

/** The default models directory and its behavior-spelled sibling. */
export const DEFAULT_MODELS_DIR = "extensions/models";
export const DEFAULT_BEHAVIORS_DIR = "extensions/behaviors";

/**
 * The extension manifest key, behavior spelling, and its model form. A
 * manifest uses one or the other; a pushed manifest always says `models:`.
 */
export const BEHAVIOR_MANIFEST_KEY = "behaviors";
export const MODEL_MANIFEST_KEY = "models";
