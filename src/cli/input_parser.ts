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

import { parse as parseYaml } from "@std/yaml";
import { UserError } from "../domain/errors.ts";
import { homeDirectory } from "../infrastructure/persistence/paths.ts";

// Re-export coerceInputTypes from domain layer for backward compatibility
export { coerceInputTypes } from "../domain/inputs/input_coercion.ts";

/**
 * Result of parsing inputs.
 */
export interface ParsedInputs {
  inputs: Record<string, unknown>;
  source: "json" | "yaml-file" | "key-value" | "combined" | "none";
}

/**
 * Sets a value at a dot-separated key path in an object.
 * Creates intermediate objects as needed.
 *
 * @example
 * setNestedValue({}, "server.host", "localhost")
 * // → { server: { host: "localhost" } }
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const parts = keyPath.split(".");
  // deno-lint-ignore no-explicit-any
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current[part] === undefined || current[part] === null ||
      typeof current[part] !== "object" || Array.isArray(current[part])
    ) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Resolves a file reference value (prefixed with @) to its file contents.
 * Supports tilde expansion for home directory paths.
 */
async function resolveFileValue(
  key: string,
  filePath: string,
): Promise<string> {
  let resolvedPath = filePath;
  if (resolvedPath.startsWith("~/")) {
    // Try HOME (POSIX) then USERPROFILE (Windows). When neither is set,
    // intentionally fall through with the literal `~/...` path so the
    // downstream `Deno.readTextFile` produces a "file not found" error
    // referencing the unexpanded path. Stream 0 pins this behavior.
    try {
      resolvedPath = homeDirectory() + resolvedPath.slice(1);
    } catch {
      // No home directory available — leave the path literal.
    }
  }
  try {
    return await Deno.readTextFile(resolvedPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new UserError(
        `Input file not found for key "${key}": ${resolvedPath}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(
      `Failed to read input file for key "${key}": ${message}`,
    );
  }
}

/**
 * Parses an array of key=value strings into a nested object.
 *
 * - Dot notation creates nested objects: `server.host=localhost`
 * - Values starting with `@` read file contents: `key=@path/to/file`
 * - Escaped `@` with `\@` produces a literal `@`: `key=\@literal`
 * - Splits on first `=` only, so values can contain `=`
 * - `:json` suffix on the leaf segment of the key parses the value as
 *   JSON: `keywords:json=["a","b"]`, `server.config:json={"port":8080}`.
 *   The `@file` and `\@literal` interactions are bypassed when `:json`
 *   is set — the value is read as a literal JSON string. JSON parse
 *   failures are hard errors.
 */
export async function parseKeyValueInputs(
  entries: string[],
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const entry of entries) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex === -1) {
      throw new UserError(
        `Invalid input format: "${entry}". Expected key=value format.`,
      );
    }

    let key = entry.slice(0, eqIndex);
    if (key === "") {
      throw new UserError(`Invalid input: empty key in "${entry}".`);
    }

    const rawValue: string = entry.slice(eqIndex + 1);

    // Detect a `:json` suffix on the LEAF segment of a dot-notation
    // path. e.g. `server.config:json` → leaf `config:json` → leaf
    // `config` with JSON-typed value; `keywords:json` → `keywords`.
    const jsonSuffix = ":json";
    const dotIndex = key.lastIndexOf(".");
    const leaf = dotIndex >= 0 ? key.slice(dotIndex + 1) : key;
    if (leaf.endsWith(jsonSuffix) && leaf.length > jsonSuffix.length) {
      const cleanedLeaf = leaf.slice(0, -jsonSuffix.length);
      key = dotIndex >= 0
        ? key.slice(0, dotIndex + 1) + cleanedLeaf
        : cleanedLeaf;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(
          `Invalid JSON value for input "${key}": ${message}`,
        );
      }
      setNestedValue(result, key, parsed);
      continue;
    }

    let value: string = rawValue;

    if (value.startsWith("\\@")) {
      // Escaped @ — use literal value without the backslash
      value = value.slice(1);
    } else if (value.startsWith("@")) {
      // File reference — read file contents
      const filePath = value.slice(1);
      value = await resolveFileValue(key, filePath);
    }

    setNestedValue(result, key, value);
  }

  return result;
}

/**
 * Deep merges two objects. Override values take precedence.
 * Only merges plain objects recursively; arrays and primitives are replaced.
 */
export function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = result[key];
    if (
      isPlainObject(baseValue) && isPlainObject(overrideValue)
    ) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
      );
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detects whether input strings represent JSON (backward compat) or key=value pairs.
 */
function isJsonInput(entries: string[]): boolean {
  return entries.length === 1 && entries[0].trimStart().startsWith("{");
}

/**
 * Parses a YAML input file and returns the parsed object.
 */
async function parseInputFile(
  inputFile: string,
): Promise<Record<string, unknown>> {
  try {
    const content = await Deno.readTextFile(inputFile);
    const parsed = parseYaml(content);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new UserError("Input file must contain a YAML object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new UserError(`Input file not found: ${inputFile}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Failed to read input file: ${message}`);
  }
}

/**
 * Parses input values from CLI options.
 *
 * Supports three input methods:
 * - `--input '{"key": "value"}'` — JSON object (backward compat, detected by leading `{`)
 * - `--input key=value` — repeatable key=value pairs with dot-notation nesting
 * - `--input-file file.yaml` — YAML file
 *
 * When both `--input-file` and key=value `--input` are provided, the file
 * provides base values and key=value pairs act as overrides (deep merged).
 *
 * @param options - CLI options containing input or inputFile
 * @returns Parsed inputs and their source
 */
export async function parseInputs(options: {
  input?: string | string[];
  inputFile?: string;
}): Promise<ParsedInputs> {
  const inputEntries = normalizeInputOption(options.input);

  // JSON mode: single string starting with `{` — backward compat
  if (inputEntries.length > 0 && isJsonInput(inputEntries)) {
    try {
      const parsed = JSON.parse(inputEntries[0]);
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) {
        throw new UserError("Input must be a JSON object");
      }
      return {
        inputs: parsed as Record<string, unknown>,
        source: "json",
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new UserError(`Invalid JSON in --input: ${error.message}`);
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new UserError(`Invalid input: ${msg}`);
    }
  }

  // Key-value mode (possibly combined with --input-file)
  if (inputEntries.length > 0) {
    const kvInputs = await parseKeyValueInputs(inputEntries);

    if (options.inputFile) {
      const fileInputs = await parseInputFile(options.inputFile);
      return {
        inputs: deepMerge(fileInputs, kvInputs),
        source: "combined",
      };
    }

    return {
      inputs: kvInputs,
      source: "key-value",
    };
  }

  // --input-file only
  if (options.inputFile) {
    const fileInputs = await parseInputFile(options.inputFile);
    return {
      inputs: fileInputs,
      source: "yaml-file",
    };
  }

  return {
    inputs: {},
    source: "none",
  };
}

/**
 * Normalizes the --input option value to an array of strings.
 * Handles both the old single-string form and the new collected array form.
 */
function normalizeInputOption(
  input: string | string[] | undefined,
): string[] {
  if (input === undefined) {
    return [];
  }
  if (Array.isArray(input)) {
    return input;
  }
  return [input];
}
