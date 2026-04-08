// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { QUERY_FIELDS } from "./query_predicate.ts";
import { OwnerTypes } from "./data_metadata.ts";
import type { CursorContext } from "./cel_cursor_context.ts";

/** A single completion suggestion. */
export interface CompletionItem {
  /** Text to insert (replaces the current prefix). */
  text: string;
  /** Display text in the dropdown. */
  label: string;
  /** Secondary info (type hint, count). */
  detail?: string;
  /** Category of the completion. */
  kind: "field" | "value" | "operator" | "builtin";
}

/** CEL comparison and method operators suggested after a field name. */
/** Comparison operators shown after a space (e.g. `name ==`). */
const COMPARISON_OPERATORS: CompletionItem[] = [
  { text: "==", label: "==", detail: "equals", kind: "operator" },
  { text: "!=", label: "!=", detail: "not equals", kind: "operator" },
  { text: ">", label: ">", detail: "greater than", kind: "operator" },
  { text: "<", label: "<", detail: "less than", kind: "operator" },
  { text: ">=", label: ">=", detail: "greater or equal", kind: "operator" },
  { text: "<=", label: "<=", detail: "less or equal", kind: "operator" },
];

/** Dot method operators shown after a dot (e.g. `name.contains(`). */
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

/** Maps CEL field names to catalog column names and whether values are numeric. */
const FIELD_TO_COLUMN: Record<string, { column: string; numeric: boolean }> = {
  id: { column: "id", numeric: false },
  name: { column: "data_name", numeric: false },
  version: { column: "version", numeric: true },
  createdAt: { column: "created_at", numeric: false },
  modelName: { column: "model_name", numeric: false },
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

/** Field type hints for display in the autocomplete dropdown. */
const FIELD_TYPES: Record<string, string> = {
  id: "string",
  name: "string",
  version: "int",
  createdAt: "string",
  attributes: "map",
  tags: "map",
  modelName: "string",
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

/**
 * Provides context-aware autocomplete suggestions for CEL query expressions.
 *
 * Caches expensive catalog lookups (distinct values, tag keys) for the
 * lifetime of the provider instance, which matches the TUI session.
 */
export class AutocompleteProvider {
  private distinctCache = new Map<string, string[]>();
  private tagKeysCache: string[] | undefined;

  constructor(
    private readonly distinctFn: (col: string) => string[],
    private readonly tagKeysFn: () => string[],
    private readonly tagValuesFn: (key: string) => string[],
  ) {}

  /**
   * Returns completion items for the given cursor context.
   * @param mode - "predicate" for filter expressions, "select" for projections.
   *   In select mode, operator and value completions are suppressed since
   *   projections use field names and member access, not comparisons.
   */
  complete(
    context: CursorContext,
    mode: "predicate" | "select" = "predicate",
  ): CompletionItem[] {
    switch (context.kind) {
      case "root":
        return this.completeRoot(context.prefix);
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

  private completeRoot(prefix: string): CompletionItem[] {
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
    return items;
  }

  private completeMember(
    root: string,
    chain: string[],
    prefix: string,
  ): CompletionItem[] {
    // tags. → offer tag keys
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
    // Nested access (e.g. attributes.status. or tags.env.) → offer dot methods
    // because the user is calling a method on a resolved value
    if (chain.length > 0) {
      return DOT_METHODS.filter((m) => m.text.startsWith(prefix));
    }
    // Known non-map field with dot (e.g. name.) → offer dot methods
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
    // Boolean field
    if (field === "streaming") {
      return ["true", "false"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ text: v, label: v, kind: "value" as const }));
    }

    // Owner type — hardcoded enum
    if (field === "ownerType") {
      return OwnerTypes
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({
          text: `"${v}"`,
          label: `"${v}"`,
          kind: "value" as const,
        }));
    }

    // Tag value (field is "tags.xxx")
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

    // Catalog column with distinct values
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
