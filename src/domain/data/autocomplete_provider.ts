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

import {
  BEHAVIOR_FUNCTION,
  MODEL_FUNCTION,
  QUERY_FIELDS,
} from "./query_predicate.ts";
import { OwnerTypes } from "./data_metadata.ts";
import type { CursorContext } from "./cel_cursor_context.ts";

export interface CompletionItem {
  text: string;
  label: string;
  detail?: string;
  kind: "field" | "value" | "operator" | "builtin";
}

const COMPARISON_OPERATORS: CompletionItem[] = [
  { text: "==", label: "==", detail: "equals", kind: "operator" },
  { text: "!=", label: "!=", detail: "not equals", kind: "operator" },
  { text: ">", label: ">", detail: "greater than", kind: "operator" },
  { text: "<", label: "<", detail: "less than", kind: "operator" },
  { text: ">=", label: ">=", detail: "greater or equal", kind: "operator" },
  { text: "<=", label: "<=", detail: "less or equal", kind: "operator" },
];

const DOT_METHODS: CompletionItem[] = [
  {
    text: "contains(",
    label: "contains(",
    detail: "string contains",
    kind: "operator",
  },
  {
    text: "startsWith(",
    label: "startsWith(",
    detail: "string prefix",
    kind: "operator",
  },
  {
    text: "endsWith(",
    label: "endsWith(",
    detail: "string suffix",
    kind: "operator",
  },
  {
    text: "matches(",
    label: "matches(",
    detail: "regex match",
    kind: "operator",
  },
];

const FIELD_TO_COLUMN: Record<string, { column: string; numeric: boolean }> = {
  id: { column: "id", numeric: false },
  name: { column: "data_name", numeric: false },
  version: { column: "version", numeric: true },
  createdAt: { column: "created_at", numeric: false },
  modelName: { column: "model_name", numeric: false },
  behaviorName: { column: "model_name", numeric: false },
  modelType: { column: "type_normalized", numeric: false },
  specName: { column: "spec_name", numeric: false },
  dataType: { column: "data_type", numeric: false },
  contentType: { column: "content_type", numeric: false },
  lifetime: { column: "lifetime", numeric: false },
  ownerType: { column: "owner_type", numeric: false },
  size: { column: "size", numeric: true },
  ownerRef: { column: "owner_ref", numeric: false },
  workflowRunId: { column: "workflow_run_id", numeric: false },
  workflowName: { column: "workflow_name", numeric: false },
  jobName: { column: "job_name", numeric: false },
  stepName: { column: "step_name", numeric: false },
  source: { column: "source", numeric: false },
};

const FIELD_TYPES: Record<string, string> = {
  id: "string",
  name: "string",
  version: "int",
  createdAt: "string",
  attributes: "map",
  tags: "map",
  modelName: "string",
  behaviorName: "string",
  modelType: "string",
  specName: "string",
  dataType: "string",
  contentType: "string",
  lifetime: "string",
  ownerType: "string",
  streaming: "bool",
  size: "int",
  content: "string",
  ownerRef: "string",
  workflowRunId: "string",
  workflowName: "string",
  jobName: "string",
  stepName: "string",
  source: "string",
};

export class AutocompleteProvider {
  private distinctCache = new Map<string, string[]>();
  private tagKeysCache: string[] | undefined;

  constructor(
    private readonly distinctFn: (col: string) => string[],
    private readonly tagKeysFn: () => string[],
    private readonly tagValuesFn: (key: string) => string[],
  ) {}

  complete(
    context: CursorContext,
    mode: "predicate" | "select" = "predicate",
  ): CompletionItem[] {
    switch (context.kind) {
      case "root":
        return this.completeRoot(context.prefix, mode);
      case "member":
        return this.completeMember(
          context.root,
          context.chain,
          context.prefix,
        );
      case "operator":
        return mode === "select" ? [] : this.completeOperator(context.field);
      case "value":
        return mode === "select"
          ? []
          : this.completeValue(context.field, context.prefix);
      case "unknown":
        return [];
    }
  }

  private completeRoot(
    prefix: string,
    mode: "predicate" | "select",
  ): CompletionItem[] {
    const items: CompletionItem[] = [];
    for (const field of QUERY_FIELDS) {
      if (field.startsWith(prefix)) {
        items.push({
          text: field,
          label: field,
          detail: FIELD_TYPES[field],
          kind: "field",
        });
      }
    }
    // model() matches rows by model name or definition id; it is resolved
    // before matching, so it is offered in predicates only.
    if (mode === "predicate" && MODEL_FUNCTION.startsWith(prefix)) {
      items.push({
        text: `${MODEL_FUNCTION}(`,
        label: `${MODEL_FUNCTION}(`,
        detail: "behavior name or definition id",
        kind: "builtin",
      });
    }
    if (mode === "predicate" && BEHAVIOR_FUNCTION.startsWith(prefix)) {
      items.push({
        text: `${BEHAVIOR_FUNCTION}(`,
        label: `${BEHAVIOR_FUNCTION}(`,
        detail: "behavior name or definition id",
        kind: "builtin",
      });
    }
    return items;
  }

  private completeMember(
    root: string,
    chain: string[],
    prefix: string,
  ): CompletionItem[] {
    if (root === "tags" && chain.length === 0) {
      const keys = this.getCachedTagKeys();
      return keys
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({
          text: k,
          label: k,
          kind: "field" as const,
        }));
    }
    if (chain.length > 0) {
      return DOT_METHODS.filter((m) => m.text.startsWith(prefix));
    }
    if (QUERY_FIELDS.has(root) && root !== "attributes" && root !== "tags") {
      return DOT_METHODS.filter((m) => m.text.startsWith(prefix));
    }
    // attributes. (first level) — no completions (too expensive to enumerate keys)
    return [];
  }

  private completeOperator(_field: string): CompletionItem[] {
    return [...COMPARISON_OPERATORS];
  }

  private completeValue(field: string, prefix: string): CompletionItem[] {
    if (field === "streaming") {
      return ["true", "false"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ text: v, label: v, kind: "value" as const }));
    }

    if (field === "ownerType") {
      return OwnerTypes
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({
          text: `"${v}"`,
          label: `"${v}"`,
          kind: "value" as const,
        }));
    }

    if (field.startsWith("tags.")) {
      const tagKey = field.slice(5);
      const values = this.tagValuesFn(tagKey);
      return values
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({
          text: `"${v}"`,
          label: `"${v}"`,
          kind: "value" as const,
        }));
    }

    const mapping = FIELD_TO_COLUMN[field];
    if (mapping) {
      const values = this.getCachedDistinct(mapping.column);
      return values
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({
          text: mapping.numeric ? v : `"${v}"`,
          label: mapping.numeric ? v : `"${v}"`,
          kind: "value" as const,
        }));
    }

    return [];
  }

  private getCachedDistinct(column: string): string[] {
    let cached = this.distinctCache.get(column);
    if (!cached) {
      cached = this.distinctFn(column);
      this.distinctCache.set(column, cached);
    }
    return cached;
  }

  private getCachedTagKeys(): string[] {
    if (!this.tagKeysCache) {
      this.tagKeysCache = this.tagKeysFn();
    }
    return this.tagKeysCache;
  }
}
