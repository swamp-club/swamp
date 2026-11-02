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
 * authored formats accept the behavior spelling as an exact synonym, translated
 * to the model spelling at each context's edge; near-misses are not synonyms so
 * a misspelled deny rule fails loudly
 */

export const BEHAVIOR_STEP_TASK_TYPE = "behavior";
export const MODEL_STEP_TASK_TYPE = "model_method";

export const BEHAVIOR_STEP_TASK_FIELDS: Readonly<Record<string, string>> =
  Object.freeze({
    behavior: "modelIdOrName",
    behaviorType: "modelType",
    behaviorName: "modelName",
  });

export const BEHAVIOR_SELECTOR_KIND = "behavior";
export const MODEL_SELECTOR_KIND = "model";

export const BEHAVIOR_AUDIT_ACTION_PREFIX = "behavior.";
export const MODEL_AUDIT_ACTION_PREFIX = "model.";

export const BEHAVIOR_AUDIT_RESOURCE_PREFIX = "behavior:";
export const MODEL_AUDIT_RESOURCE_PREFIX = "model:";

export function canonicalResourceKind(kind: string): string {
  return kind === BEHAVIOR_SELECTOR_KIND ? MODEL_SELECTOR_KIND : kind;
}

export function replacePrefix(
  value: string,
  from: string,
  to: string,
): string {
  return value.startsWith(from) ? to + value.slice(from.length) : value;
}

/** a module exports one or the other, never both */
export const BEHAVIOR_EXPORT_NAME = "behavior";
export const MODEL_EXPORT_NAME = "model";

/**
 * behaviors/ is loaded beside models/ only while the models directory is the
 * default; archives always carry sources under models/
 */
export const BEHAVIORS_DIR_NAME = "behaviors";
export const MODELS_DIR_NAME = "models";

export const DEFAULT_MODELS_DIR = "extensions/models";
export const DEFAULT_BEHAVIORS_DIR = "extensions/behaviors";

/** a manifest uses one or the other; a pushed manifest always says models: */
export const BEHAVIOR_MANIFEST_KEY = "behaviors";
export const MODEL_MANIFEST_KEY = "models";

/** report search --scope behavior filters on the stored model scope */
export const BEHAVIOR_REPORT_SCOPE = "behavior";
export const MODEL_REPORT_SCOPE = "model";

/** data records always store model-method */
export const BEHAVIOR_OWNER_TYPE = "behavior-method";
export const MODEL_OWNER_TYPE = "model-method";

/** .swamp-sources.yaml only: and the registry keep models */
export const BEHAVIOR_EXTENSION_KIND = "behaviors";
export const MODEL_EXTENSION_KIND = "models";

/**
 * behavior("x") and behaviorName evaluate exactly as model("x") and modelName
 * do
 */
export const BEHAVIOR_QUERY_FUNCTION = "behavior";
export const MODEL_QUERY_FUNCTION = "model";
export const BEHAVIOR_QUERY_NAME_FIELD = "behaviorName";
export const MODEL_QUERY_NAME_FIELD = "modelName";

/**
 * when both are set the model form wins, and different non-empty values are
 * refused at startup
 */
export const BEHAVIORS_DIR_ENV_VAR = "SWAMP_BEHAVIORS_DIR";
export const MODELS_DIR_ENV_VAR = "SWAMP_MODELS_DIR";
