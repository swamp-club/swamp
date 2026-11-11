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

import { parse as parseYaml } from "@std/yaml";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import { homeDirectory } from "../infrastructure/persistence/paths.ts";
import { deepMerge } from "../domain/inputs/input_merge.ts";

export { coerceInputTypes } from "../domain/inputs/input_coercion.ts";
export { deepMerge } from "../domain/inputs/input_merge.ts";

export function mergeInputArgs(
  options: { arg?: string[]; input?: string[] },
): string[] | undefined {
  const merged = [
    ...((options.arg as string[] | undefined) ?? []),
    ...((options.input as string[] | undefined) ?? []),
  ];
  return merged.length > 0 ? merged : undefined;
}

export interface ParsedInputs {
  inputs: Record<string, unknown>;
  source: "json" | "yaml-file" | "key-value" | "combined" | "none";
}

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

// scoped @namespace/name with no dots (a dot means a file extension), so
// @hivemq/base-images is not read as @path/to/file.txt
const SCOPED_IDENTIFIER_RE =
  /^@[a-zA-Z][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_\/-]*$/;

export function isScopedIdentifier(value: string): boolean {
  return SCOPED_IDENTIFIER_RE.test(value);
}

async function resolveFileValue(
  key: string,
  filePath: string,
  atHint = true,
): Promise<string> {
  let resolvedPath = filePath;
  if (resolvedPath.startsWith("~/")) {
    // with neither HOME nor USERPROFILE set, keep the literal ~/ path so the
    // read error names the unexpanded path
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
      throw markErrorPaths(
        new UserError(
          `Input file not found for key "${key}": ${resolvedPath}` +
            (atHint
              ? `. Values starting with @ are read as file paths; use \\@ for a literal @ or :json suffix to bypass`
              : ""),
        ),
        [resolvedPath],
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw markErrorPaths(
      new UserError(
        `Failed to read input file for key "${key}": ${message}`,
      ),
      [resolvedPath, ...errorPaths(error)],
    );
  }
}

/**
 * with literal, values are kept verbatim: a leading @ is never read as a file,
 * so text the caller did not write cannot make swamp read a file. :json
 * bypasses the @file and \@ handling
 */
export async function parseKeyValueInputs(
  entries: string[],
  options: { literal?: boolean } = {},
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

    if (options.literal) {
      setNestedValue(result, key, value);
      continue;
    }

    if (value.startsWith("\\@")) {
      value = value.slice(1);
    } else if (value.startsWith("@") && !isScopedIdentifier(value)) {
      const filePath = value.slice(1);
      value = await resolveFileValue(key, filePath);
    }

    setNestedValue(result, key, value);
  }

  return result;
}

export interface DataInputs {
  values: Record<string, unknown>;
  /** dotted, as written after --input-data */
  keys: string[];
}

/**
 * --input-data key=<path>: the file's content is the value, read on the client
 * and never evaluated
 */
export async function parseDataInputs(
  entries: string[] | undefined,
): Promise<DataInputs> {
  const values: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const entry of entries ?? []) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex === -1 || eqIndex === entry.length - 1) {
      throw new UserError(
        `Invalid --input-data format: "${entry}". Expected key=<path>.`,
      );
    }
    const key = entry.slice(0, eqIndex);
    if (key === "" || key.split(".").includes("")) {
      throw new UserError(
        `Invalid --input-data key in "${entry}": keys are dotted names with no empty segment, such as body.text=<path>.`,
      );
    }
    if (keys.includes(key)) {
      throw new UserError(`--input-data ${key} is given more than once.`);
    }
    setNestedValue(
      values,
      key,
      await resolveFileValue(key, entry.slice(eqIndex + 1), false),
    );
    keys.push(key);
  }
  return { values, keys };
}

/** refuses a key another input source also sets, rather than pick one */
export function assertNoDataInputOverlap(
  inputs: Record<string, unknown>,
  data: DataInputs,
): void {
  for (const key of data.keys) {
    // set at the key, or a prefix holds a value the merge would replace
    let current: unknown = inputs;
    let present = true;
    for (const part of key.split(".")) {
      if (
        current === null || typeof current !== "object" ||
        Array.isArray(current)
      ) {
        break;
      }
      if (!Object.hasOwn(current, part)) {
        present = false;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (present) {
      throw new UserError(
        `Input ${key} is given both by --input-data and by --input, --input-file or a --stdin item.`,
      );
    }
  }
}

/** each input set with the data inputs merged in; a set that names one too is refused */
export function withDataInputs(
  sets: Record<string, unknown>[],
  data: DataInputs,
): Record<string, unknown>[] {
  if (data.keys.length === 0) return sets;
  return sets.map((set) => {
    assertNoDataInputOverlap(set, data);
    return deepMerge(set, data.values);
  });
}

function isJsonInput(entries: string[]): boolean {
  return entries.length === 1 && entries[0].trimStart().startsWith("{");
}

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
      throw markErrorPaths(
        new UserError(`Input file not found: ${inputFile}`),
        [inputFile],
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw markErrorPaths(
      new UserError(`Failed to read input file: ${message}`),
      [inputFile, ...errorPaths(error)],
    );
  }
}

export async function parseInputs(options: {
  input?: string | string[];
  inputFile?: string;
  literal?: boolean;
}): Promise<ParsedInputs> {
  const inputEntries = normalizeInputOption(options.input);

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

  if (inputEntries.length > 0) {
    const kvInputs = await parseKeyValueInputs(inputEntries, {
      literal: options.literal,
    });

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

export function parseStdinContent(
  content: string,
): Record<string, unknown>[] {
  const trimmed = content.trim();
  if (trimmed === "") {
    throw new UserError(
      "No input received from stdin. Pipe JSON, NDJSON, or YAML into the command.",
    );
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        throw new UserError("Empty JSON array received from stdin.");
      }
      return parsed.map((item, i) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new UserError(
            `stdin array element [${i}] is not a JSON object.`,
          );
        }
        return item as Record<string, unknown>;
      });
    }
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed as Record<string, unknown>];
    }
    throw new UserError(
      "stdin must contain a JSON object, JSON array, or NDJSON lines.",
    );
  } catch (error) {
    if (error instanceof UserError) throw error;
  }

  const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > 1) {
    try {
      const records: Record<string, unknown>[] = [];
      for (let i = 0; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]);
        if (
          typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        ) {
          throw new UserError(
            `stdin NDJSON line ${i + 1} is not a JSON object.`,
          );
        }
        records.push(parsed as Record<string, unknown>);
      }
      return records;
    } catch (error) {
      if (error instanceof UserError) throw error;
    }
  }

  try {
    const parsed = parseYaml(trimmed);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return [parsed as Record<string, unknown>];
    }
    throw new UserError(
      "stdin YAML must be an object (mapping), not a scalar or list.",
    );
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      "Failed to parse stdin content. Expected JSON object, JSON array, NDJSON, or YAML.\n" +
        `Parse error: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}
