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

import { relative, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { normalizeBehaviorTask } from "../workflows/step_task.ts";
import type {
  ExtensionContentMetadata,
  ExtractedArgument,
  ExtractedDatastore,
  ExtractedExtension,
  ExtractedFile,
  ExtractedMethod,
  ExtractedModel,
  ExtractedReport,
  ExtractedResource,
  ExtractedVault,
  ExtractedWebhook,
  ExtractedWorkflow,
  ExtractedWorkflowJob,
  ExtractedWorkflowStep,
} from "./extension_content.ts";
import { MARKED_SENSITIVE } from "./extension_review_rules.ts";

/**
 * Reads a source file for its metadata, refusing a symlink: the safety gate
 * refuses it later, and what its target declares must not reach the
 * content-collective check, which quotes it (swamp-club#3420).
 */
async function readSourceText(path: string): Promise<string> {
  if ((await Deno.lstat(path)).isSymlink) {
    throw new Error("symlinked source");
  }
  return await Deno.readTextFile(path);
}

/**
 * The `fileName` the registry receives for `filePath`: relative to `dir`,
 * with forward slashes on every OS, so a push from Windows sends what a push
 * from macOS or Linux sends.
 */
export function contentFileName(dir: string, filePath: string): string {
  const rel = relative(dir, filePath);
  return SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
}

/**
 * Extracts content metadata from model source files and workflow YAML files.
 *
 * This metadata is sent to the registry during `extension push` so the server
 * can index extension contents without re-parsing the archive.
 *
 * Extraction is best-effort: individual file failures are silently skipped
 * and partial results are returned.
 */
export async function extractContentMetadata(
  modelFiles: string[],
  modelsDir: string,
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>,
  vaultFiles: string[] = [],
  vaultsDir = "",
  datastoreFiles: string[] = [],
  datastoresDir = "",
  reportFiles: string[] = [],
  reportsDir = "",
  webhookFiles: string[] = [],
  webhooksDir = "",
): Promise<ExtensionContentMetadata> {
  const models: ExtractedModel[] = [];
  const extensions: ExtractedExtension[] = [];
  const workflows: ExtractedWorkflow[] = [];
  const vaults: ExtractedVault[] = [];
  const datastores: ExtractedDatastore[] = [];
  const reports: ExtractedReport[] = [];
  const webhooks: ExtractedWebhook[] = [];

  for (const filePath of modelFiles) {
    try {
      const content = await readSourceText(filePath);
      const model = extractModelFromSource(content, filePath, modelsDir);
      if (model) {
        models.push(model);
      } else {
        const ext = extractExtensionFromSource(content, filePath, modelsDir);
        if (ext) {
          extensions.push(ext);
        }
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const wf of workflowFiles) {
    try {
      const content = await readSourceText(wf.sourcePath);
      const workflow = extractWorkflowFromYaml(content, wf.archiveName);
      if (workflow) {
        workflows.push(workflow);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const filePath of vaultFiles) {
    try {
      const content = await readSourceText(filePath);
      const vault = extractVaultFromSource(content, filePath, vaultsDir);
      if (vault) {
        vaults.push(vault);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const filePath of datastoreFiles) {
    try {
      const content = await readSourceText(filePath);
      const ds = extractDatastoreFromSource(
        content,
        filePath,
        datastoresDir,
      );
      if (ds) {
        datastores.push(ds);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const filePath of reportFiles) {
    try {
      const content = await readSourceText(filePath);
      const report = extractReportFromSource(content, filePath, reportsDir);
      if (report) {
        reports.push(report);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const filePath of webhookFiles) {
    try {
      const content = await readSourceText(filePath);
      const webhook = extractWebhookFromSource(content, filePath, webhooksDir);
      if (webhook) {
        webhooks.push(webhook);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  return {
    models,
    extensions,
    workflows,
    vaults,
    datastores,
    reports,
    webhooks,
    skills: [],
  };
}

/**
 * Extracts model metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable model definition.
 */
function extractModelFromSource(
  content: string,
  filePath: string,
  modelsDir: string,
): ExtractedModel | null {
  const type = extractModelType(content);
  if (!type) return null;

  const version = extractModelVersion(content);
  if (!version) return null;

  const globalArguments = extractGlobalArguments(content);
  const methods = extractMethods(content);
  const resources = extractResources(content);
  const files = extractFiles(content);

  return {
    fileName: contentFileName(modelsDir, filePath),
    type,
    version,
    globalArguments,
    methods,
    resources,
    files,
  };
}

/**
 * Extracts extension metadata from a TypeScript source file that uses
 * `export const extension = { type: "...", methods: [...] }`.
 * Returns null if the file doesn't contain a recognizable extension definition.
 */
function extractExtensionFromSource(
  content: string,
  filePath: string,
  modelsDir: string,
): ExtractedExtension | null {
  const extensionMatch = content.match(
    /export\s+const\s+extension\s*=\s*\{/,
  );
  if (!extensionMatch || extensionMatch.index === undefined) return null;

  const bodyStart = extensionMatch.index + extensionMatch[0].length;
  const body = extractBalancedBraces(content, bodyStart);
  if (!body) return null;

  const typeMatch = body.match(/type:\s*["']([^"']+)["']/);
  if (!typeMatch) return null;

  const methods = extractExtensionMethods(body, content);
  const resources = extractResources(body);

  return {
    fileName: contentFileName(modelsDir, filePath),
    extendsType: typeMatch[1],
    methods,
    resources,
  };
}

/**
 * Extracts methods from an extension's `methods` array.
 * Extension methods use an array-of-records pattern: `methods: [{ name: { ... } }]`.
 */
function extractExtensionMethods(
  extensionBody: string,
  fullContent: string,
): ExtractedMethod[] {
  const methods: ExtractedMethod[] = [];

  const methodsBlockMatch = extensionBody.match(/methods:\s*\[/);
  if (!methodsBlockMatch || methodsBlockMatch.index === undefined) {
    return methods;
  }

  const arrayStart = methodsBlockMatch.index + methodsBlockMatch[0].length;
  const arrayBody = extractBalancedBrackets(extensionBody, arrayStart);
  if (!arrayBody) return methods;

  for (const record of extractArrayObjectBodies(arrayBody)) {
    for (const method of extractMethodsFromEntries(record, fullContent)) {
      methods.push(method);
    }
  }

  return methods;
}

/**
 * Extracts the content between balanced square brackets, starting after an
 * opening bracket. Returns the content between the brackets (excluding the
 * outer brackets themselves).
 */
function extractBalancedBrackets(
  text: string,
  startAfterBracket: number,
): string | null {
  let depth = 1;
  let i = startAfterBracket;

  while (i < text.length && depth > 0) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") depth--;
    i++;
  }

  if (depth !== 0) return null;
  return text.slice(startAfterBracket, i - 1);
}

/**
 * The opening of a model entry point's plain object literal:
 * `export const model = {`, or else its behavior spelling
 * `export const behavior = {` (swamp-club#3338). Both read the same, so a
 * behavior-spelled extension reaches the registry catalog exactly as its
 * model-spelled twin does. The model spelling is looked for first, so a
 * model file that also exports an unrelated `behavior` object reads as it
 * always has.
 */
function matchModelExportObject(content: string): RegExpMatchArray | null {
  const model = content.match(/export\s+const\s+model\s*=\s*\{/);
  if (model) return model;
  // The behavior spelling reads exactly as the model spelling does (first
  // match), but only in a file that holds a behavior definition at all: an
  // object that declares methods, as the loader requires. A helper whose
  // only export is an unrelated config such as `{ type: "retry" }` has none.
  return hasBehaviorDefinition(content)
    ? content.match(/export\s+const\s+behavior\s*=\s*\{/)
    : null;
}

/**
 * Whether `content` declares `export const behavior` with an object that
 * declares methods (swamp-club#3338): the first object after the `=`, so a
 * plain literal (`= { ... }`), a wrapped one (`= make({ ... })`) and an
 * annotated one (`: T = { ... }`) all count, and an unrelated config such as
 * `{ type: "retry" }` does not.
 */
export function hasBehaviorDefinition(content: string): boolean {
  for (
    const match of content.matchAll(/export\s+const\s+behavior\b[^=;]*=/g)
  ) {
    if (match.index === undefined) continue;
    const after = match.index + match[0].length;
    const brace = content.indexOf("{", after);
    const end = content.indexOf(";", after);
    if (brace === -1 || (end !== -1 && end < brace)) continue;
    const body = extractBalancedBraces(content, brace + 1);
    if (body !== null && declaresMethods(body)) return true;
  }
  return false;
}

/**
 * Whether an object body declares a `methods` property, written out
 * (`methods: {`) or as a shorthand (`methods,`, or last in the body). Used to tell a
 * behavior-spelled definition from an unrelated `behavior` binding
 * (swamp-club#3338).
 */
export function declaresMethods(body: string): boolean {
  return /(?<![.\w])methods\s*(?:[:,}(]|$)/.test(body);
}

/**
 * Extracts the model type string.
 * Matches `ModelType.create("...")` or `type: "..."` patterns.
 *
 * Scopes the `type:` literal search to the `export const model = { ... }`
 * object body to avoid false positives from string literals elsewhere in
 * the file (e.g. embedded LLM prompts containing `type: "anime"`).
 */
export function extractModelType(content: string): string | null {
  // Match ModelType.create("type-name") or ModelType.create('type-name')
  const modelTypeMatch = content.match(
    /ModelType\.create\(\s*["']([^"']+)["']\s*\)/,
  );
  if (modelTypeMatch) return modelTypeMatch[1];

  // Scope the type: search to the model export object body to avoid matching
  // type: patterns inside string literals elsewhere in the file.
  const body = extractModelExportBody(content);
  if (!body) return null;

  const typeLiteralMatch = body.match(/type:\s*["']([^"']+)["']/);
  if (typeLiteralMatch) return typeLiteralMatch[1];

  return null;
}

/**
 * The text inside the braces of the `export const model = { ... }` object,
 * or null when the export is not written as a plain object literal (a type
 * annotation, or an initializer that is not an object) or its braces do not
 * balance. Every field the catalog reads from a model comes from this body.
 */
export function extractModelExportBody(content: string): string | null {
  const modelExportMatch = matchModelExportObject(content);
  if (!modelExportMatch || modelExportMatch.index === undefined) return null;

  const bodyStart = modelExportMatch.index + modelExportMatch[0].length;
  return extractBalancedBraces(content, bodyStart);
}

/**
 * Extracts the model version string from the `export const model` body.
 */
export function extractModelVersion(content: string): string | null {
  const body = extractModelExportBody(content);
  if (!body) return null;

  const match = body.match(/version:\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

/**
 * Extracts the last upgrade `toVersion` from the `export const model` body.
 * Returns null when no upgrades array is present or no toVersion is found.
 */
export function extractLastUpgradeToVersion(
  content: string,
): string | null {
  const modelExportMatch = matchModelExportObject(content);
  if (!modelExportMatch || modelExportMatch.index === undefined) return null;

  const bodyStart = modelExportMatch.index + modelExportMatch[0].length;
  const body = extractBalancedBraces(content, bodyStart);
  if (!body) return null;

  const upgradesMatch = body.match(/upgrades:\s*\[/);
  if (!upgradesMatch || upgradesMatch.index === undefined) return null;

  const arrayStart = upgradesMatch.index + upgradesMatch[0].length;
  const arrayBody = extractBalancedBrackets(body, arrayStart);
  if (!arrayBody) return null;

  const toVersionMatches = [
    ...arrayBody.matchAll(/toVersion:\s*["']([^"']+)["']/g),
  ];
  if (toVersionMatches.length === 0) return null;

  return toVersionMatches[toVersionMatches.length - 1][1];
}

/**
 * Extracts global arguments from the model source.
 * Looks for top-level `globalArguments: z.object({...})` or a named schema reference.
 */
function extractGlobalArguments(content: string): ExtractedArgument[] {
  // Match top-level globalArguments: z.object({...}) — use negative lookbehind
  // to avoid matching nested keys (e.g. inside a method entry).
  const inlineMatch = content.match(
    /(?<![.\w])globalArguments:\s*z\.object\(\s*\{/,
  );
  if (inlineMatch && inlineMatch.index !== undefined) {
    const start = inlineMatch.index + inlineMatch[0].length;
    const schemaBody = extractBalancedBraces(content, start);
    if (schemaBody) {
      return parseZodObjectFields(schemaBody);
    }
  }

  // Check for a named schema reference: globalArguments: SomeSchema
  const refMatch = content.match(/(?<![.\w])globalArguments:\s*(\w+)/);
  if (refMatch) {
    const schemaName = refMatch[1];
    // Skip z.object — already handled above
    if (schemaName !== "z") {
      const namedPattern = new RegExp(
        `(?:const|let)\\s+${schemaName}\\s*=\\s*z\\.object\\(\\s*\\{`,
      );
      const namedMatch = content.match(namedPattern);
      if (namedMatch && namedMatch.index !== undefined) {
        const start = namedMatch.index + namedMatch[0].length;
        const schemaBody = extractBalancedBraces(content, start);
        if (schemaBody) {
          return parseZodObjectFields(schemaBody);
        }
      }
    }
  }

  return [];
}

/**
 * Extracts vault metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable vault definition.
 * Uses `createProvider` as the discriminator to distinguish vault files from model files.
 */
export function extractVaultFromSource(
  content: string,
  filePath: string,
  vaultsDir: string,
): ExtractedVault | null {
  // Must contain createProvider to be a vault file
  if (!/createProvider/.test(content)) return null;

  // Find the vault export object body
  const vaultMatch = content.match(/export\s+const\s+vault\s*=\s*\{/);
  if (!vaultMatch || vaultMatch.index === undefined) return null;

  const vaultStart = vaultMatch.index + vaultMatch[0].length;
  const vaultBody = extractBalancedBraces(content, vaultStart);
  if (!vaultBody) return null;

  // Extract type
  const typeMatch = vaultBody.match(/type:\s*["']([^"']+)["']/);
  if (!typeMatch) return null;

  // Name and description are read at the top level of the definition only,
  // so a nested `name:` is never mistaken for the vault's own.
  const topLevel = topLevelStringValues(vaultBody);

  // Check for configSchema presence
  const hasConfigSchema = /configSchema\s*[:,}]/.test(vaultBody);

  // Extract config fields if configSchema uses z.object
  let configFields: ExtractedArgument[] = [];
  const configInline = vaultBody.match(/configSchema:\s*z\.object\(\s*\{/);
  if (configInline && configInline.index !== undefined) {
    const start = configInline.index + configInline[0].length;
    const schemaBody = extractBalancedBraces(vaultBody, start);
    if (schemaBody) {
      configFields = parseZodObjectFields(schemaBody);
    }
  } else if (hasConfigSchema) {
    // Check for named schema reference: configSchema: SomeName
    const configRef = vaultBody.match(/configSchema:\s*(\w+)/);
    // Also check shorthand property: configSchema,
    const shorthandRef = !configRef
      ? vaultBody.match(/configSchema\s*[,\n}]/)
      : null;
    const schemaName = configRef?.[1] ??
      (shorthandRef ? "configSchema" : null);
    if (schemaName && schemaName !== "z") {
      const namedPattern = new RegExp(
        `(?:const|let)\\s+${schemaName}\\s*=\\s*z\\.object\\(\\s*\\{`,
      );
      const namedMatch = content.match(namedPattern);
      if (namedMatch && namedMatch.index !== undefined) {
        const start = namedMatch.index + namedMatch[0].length;
        const schemaBody = extractBalancedBraces(content, start);
        if (schemaBody) {
          configFields = parseZodObjectFields(schemaBody);
        }
      }
    }
  }

  return {
    fileName: contentFileName(vaultsDir, filePath),
    type: typeMatch[1],
    name: topLevel.get("name") ?? "",
    description: topLevel.get("description") ?? "",
    hasConfigSchema,
    configFields,
  };
}

/**
 * The top-level entries of an object literal body whose whole value is a
 * constant string, by key. A value that only starts with a string literal,
 * such as `"Foo" + suffix` or a template with a substitution, is computed
 * and is left out. A repeated key takes its last entry, as it does at runtime.
 */
function topLevelStringValues(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const entry of extractTopLevelEntries(body)) {
    const value = entry.raw === undefined
      ? undefined
      : evaluateStringExpression(entry.raw);
    if (value === undefined) values.delete(entry.key);
    else values.set(entry.key, value);
  }
  return values;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

// What may follow a constant string without changing its value.
const TYPE_ONLY_SUFFIX = /(?:as\s+const|satisfies\s+string)\b/y;

/**
 * The value of `expression` when it is one string literal or several joined
 * with `+`, with escape sequences decoded. Comments around the literals and a
 * trailing `as const` or `satisfies string` are ignored. Undefined for
 * anything else.
 */
function evaluateStringExpression(expression: string): string | undefined {
  let result = "";
  let i = 0;
  const skipSpace = () => {
    while (i < expression.length) {
      if (/\s/.test(expression[i])) {
        i++;
      } else if (expression.startsWith("//", i)) {
        const end = expression.indexOf("\n", i);
        i = end === -1 ? expression.length : end + 1;
      } else if (expression.startsWith("/*", i)) {
        const end = expression.indexOf("*/", i + 2);
        i = end === -1 ? expression.length : end + 2;
      } else {
        return;
      }
    }
  };
  while (true) {
    skipSpace();
    const quote = expression[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
    i++;
    while (true) {
      if (i >= expression.length) return undefined;
      const c = expression[i];
      if (c === quote) break;
      if (c === "\n" && quote !== "`") return undefined;
      // A template's CRLF line ending reads as a line feed.
      if (c === "\r" && expression[i + 1] === "\n") {
        i++;
        continue;
      }
      if (quote === "`" && c === "$" && expression[i + 1] === "{") {
        return undefined;
      }
      if (c !== "\\") {
        result += c;
        i++;
        continue;
      }
      const escaped = expression[i + 1];
      if (escaped === undefined) return undefined;
      const hex = escaped === "x"
        ? /^[0-9a-fA-F]{2}/.exec(expression.slice(i + 2))?.[0]
        : escaped === "u"
        ? /^(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]{1,6}\})/.exec(
          expression.slice(i + 2),
        )?.[0]
        : undefined;
      if (hex !== undefined) {
        const codePoint = parseInt(hex.replace(/[{}]/g, ""), 16);
        if (codePoint > 0x10ffff) return undefined;
        result += String.fromCodePoint(codePoint);
        i += 2 + hex.length;
        continue;
      }
      result += SIMPLE_ESCAPES[escaped] ?? escaped;
      i += 2;
    }
    i++;
    skipSpace();
    if (i >= expression.length) return result;
    if (expression[i] === "+") {
      i++;
      continue;
    }
    TYPE_ONLY_SUFFIX.lastIndex = i;
    if (!TYPE_ONLY_SUFFIX.test(expression)) return undefined;
    i = TYPE_ONLY_SUFFIX.lastIndex;
    skipSpace();
    return i >= expression.length ? result : undefined;
  }
}

/**
 * Extracts method definitions from the source.
 * Handles three patterns:
 *   1. Inline: `methods: { name: { description: "..." } }`
 *   2. Shorthand property: `methods,` (references a variable named `methods`)
 *   3. Variable reference: `methods: someVar` (references a named variable)
 */
function extractMethods(content: string): ExtractedMethod[] {
  // Try inline methods block first: methods: { ... }
  const inlineMethods = extractMethodsFromBlock(content, content);
  if (inlineMethods.length > 0) return inlineMethods;

  // Try variable reference: methods: someVar or shorthand methods,
  const refName = resolveMethodsReference(content);
  if (!refName) return [];

  // Look up the referenced variable in the same file
  const varBlock = findVariableObjectBody(content, refName);
  if (varBlock) {
    return extractMethodsFromBlock(varBlock, content);
  }

  return [];
}

/**
 * Extracts methods from an inline `methods: { ... }` block within the content.
 */
function extractMethodsFromBlock(
  searchContent: string,
  fullContent: string,
): ExtractedMethod[] {
  const methods: ExtractedMethod[] = [];

  const methodsBlockMatch = searchContent.match(/methods:\s*\{/);
  if (!methodsBlockMatch || methodsBlockMatch.index === undefined) {
    return methods;
  }

  const methodsStart = methodsBlockMatch.index + methodsBlockMatch[0].length;
  const methodsBlock = extractBalancedBraces(searchContent, methodsStart);
  if (!methodsBlock) return methods;

  // Each top-level key whose value is an inline object is a method, whether
  // the key is a bare identifier or a quoted string ("list-subscriptions").
  return extractMethodsFromEntries(methodsBlock, fullContent);
}

/**
 * Resolves the variable name referenced by the `methods` property.
 * Returns the variable name for `methods: someVar` or `methods` (shorthand).
 * Returns null if methods are defined inline or not found.
 */
function resolveMethodsReference(content: string): string | null {
  // Match shorthand property: methods, or methods } (end of object)
  // This pattern appears when an imported variable named `methods` is used
  // as a shorthand property in the model object literal.
  const shorthandMatch = content.match(
    /(?:export\s+const\s+(?:model|extension)\s*=\s*\{[\s\S]*?)(?<![.\w])methods\s*[,}]/,
  ) ?? content.match(
    /(?:export\s+const\s+behavior\s*=\s*\{[\s\S]*?)(?<![.\w])methods\s*[,}]/,
  );
  if (shorthandMatch) {
    // Verify it's not `methods: {` (inline) or `methods: someRef` (reference)
    const beforeMethods = content.slice(
      0,
      (shorthandMatch.index ?? 0) + shorthandMatch[0].length,
    );
    if (!beforeMethods.match(/methods\s*:\s*[{\w]/)) {
      return "methods";
    }
  }

  // Match reference: methods: someVar (not followed by { which is inline)
  const refMatch = content.match(/methods:\s*(\w+)\s*[,}\n]/);
  if (refMatch && refMatch[1] !== "{") {
    return refMatch[1];
  }

  return null;
}

/**
 * Finds the body of a `const varName = { ... }` or `export const varName = { ... }`
 * declaration and returns the full declaration text including `varName: { ... }` wrapper
 * so that extractMethodsFromBlock can find `methodName: { description: ... }` entries.
 */
function findVariableObjectBody(
  content: string,
  varName: string,
): string | null {
  const pattern = new RegExp(
    `(?:export\\s+)?(?:const|let)\\s+${varName}\\s*=\\s*\\{`,
  );
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  const body = extractBalancedBraces(content, start);
  if (!body) return null;

  // Wrap as `methods: { <body> }` so the method extraction regex works
  return `methods: {${body}}`;
}

/**
 * Builds one method per top-level object entry of a methods block. The
 * description and arguments are read from the entry's own body, so values
 * nested inside it (e.g. `checks: { ... }`) are never mistaken for the
 * method's own.
 */
function extractMethodsFromEntries(
  methodsBlock: string,
  fullContent: string,
): ExtractedMethod[] {
  const methods: ExtractedMethod[] = [];
  for (const entry of extractTopLevelEntries(methodsBlock)) {
    if (entry.body === undefined) continue;
    const description = extractTopLevelEntries(entry.body).find((e) =>
      e.key === "description"
    )?.value ?? "";
    methods.push({
      name: entry.key,
      description,
      arguments: extractMethodArguments(entry.body, fullContent),
    });
  }
  return methods;
}

/**
 * Returns the bodies of the object literals that are direct elements of an
 * array body, e.g. the records in `methods: [{ ... }, { ... }]`.
 */
function extractArrayObjectBodies(arrayBody: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < arrayBody.length) {
    if (arrayBody[i] !== "{") {
      i++;
      continue;
    }
    const body = extractBalancedBraces(arrayBody, i + 1);
    if (body === null) break;
    bodies.push(body);
    i += body.length + 2;
  }
  return bodies;
}

/**
 * A top-level entry of an object literal body. `body` is set when the value
 * is an inline object; `value` is set when the value starts with a string
 * literal (the first literal, so `"a " + "b"` yields `a `).
 */
interface TopLevelEntry {
  key: string;
  body?: string;
  value?: string;
  /** Source text of a value that starts with a string literal, up to its comma. */
  raw?: string;
}

const TOP_LEVEL_KEY =
  /\s*(?:([A-Za-z_$][\w$]*)|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')\s*:/y;
const LEADING_STRING_LITERAL =
  /\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/y;

/**
 * Walks the top-level entries of an object literal body. Only text at brace
 * depth 0 is interpreted: keys (bare or quoted), the start of each value, and
 * comments. Nested bodies and the rest of each value are skipped with the
 * same literal-aware scan extractBalancedBraces uses, so braces, quotes or
 * commas inside strings, comments or regex literals cannot throw the walk
 * off. Spreads, computed keys and shorthand entries are skipped.
 */
function extractTopLevelEntries(block: string): TopLevelEntry[] {
  const entries: TopLevelEntry[] = [];
  let i = 0;

  // noRegexBefore stays shared because it holds positions in this block; paren
  // tracking starts afresh for each value so one value's unbalanced paren
  // cannot change how a later value is read.
  const scan = newScanState();

  // Advances past the rest of the current value to just after the next
  // comma at depth 0. Parentheses and brackets are tracked here because, at
  // depth 0 of the block, they can only be call arguments or arrays.
  const skipValue = () => {
    let nesting = 0;
    let prev = ":";
    scan.controlParens = [];
    scan.lastParenWasControl = false;
    while (i < block.length) {
      const next = skipNonCode(block, i, prev, scan);
      if (next !== i) {
        if (!isComment(block, i)) prev = '"';
        i = next;
        continue;
      }
      const c = block[i];
      if (c === "{") {
        const body = extractBalancedBraces(block, i + 1);
        if (body === null) {
          i = block.length;
          return;
        }
        i += body.length + 2;
        prev = "}";
        continue;
      }
      if (c === "(" || c === "[") nesting++;
      else if (c === ")" || c === "]") nesting--;
      else if (c === "," && nesting <= 0) {
        i++;
        return;
      }
      trackParen(block, i, scan);
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  };

  while (i < block.length) {
    const c = block[i];
    if (c === "," || /\s/.test(c)) {
      i++;
      continue;
    }
    if (block.startsWith("//", i)) {
      const end = block.indexOf("\n", i);
      i = end === -1 ? block.length : end + 1;
      continue;
    }
    if (block.startsWith("/*", i)) {
      const end = block.indexOf("*/", i + 2);
      i = end === -1 ? block.length : end + 2;
      continue;
    }

    TOP_LEVEL_KEY.lastIndex = i;
    const keyMatch = TOP_LEVEL_KEY.exec(block);
    if (!keyMatch) {
      skipValue();
      continue;
    }
    const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3];
    i = TOP_LEVEL_KEY.lastIndex;
    while (i < block.length && /\s/.test(block[i])) i++;

    if (block[i] === "{") {
      const body = extractBalancedBraces(block, i + 1);
      if (body === null) break;
      entries.push({ key, body });
      i += body.length + 2;
      continue;
    }

    LEADING_STRING_LITERAL.lastIndex = i;
    const literal = LEADING_STRING_LITERAL.exec(block);
    if (literal) {
      const valueStart = i;
      i = LEADING_STRING_LITERAL.lastIndex;
      skipValue();
      entries.push({
        key,
        value: literal[1] ?? literal[2] ?? literal[3],
        raw: block.slice(valueStart, i).replace(/,\s*$/, ""),
      });
      continue;
    }
    entries.push({ key });
    skipValue();
  }

  return entries;
}

/**
 * Extracts method arguments from a Zod schema.
 * Looks for `arguments: z.object({ ... })` or a reference to a named schema.
 */
function extractMethodArguments(
  methodEntry: string,
  fullContent: string,
): ExtractedArgument[] {
  // Check for inline z.object({...})
  const inlineMatch = methodEntry.match(/arguments:\s*z\.object\(\s*\{/);
  if (inlineMatch && inlineMatch.index !== undefined) {
    const start = inlineMatch.index + inlineMatch[0].length;
    const schemaBody = extractBalancedBraces(methodEntry, start);
    if (schemaBody) {
      return parseZodObjectFields(schemaBody);
    }
  }

  // Check for reference to a named schema variable
  const refMatch = methodEntry.match(/arguments:\s*(\w+)/);
  if (refMatch) {
    const schemaName = refMatch[1];
    // Look up the named schema in the full file content
    const namedPattern = new RegExp(
      `(?:const|let)\\s+${schemaName}\\s*=\\s*z\\.object\\(\\s*\\{`,
    );
    const namedMatch = fullContent.match(namedPattern);
    if (namedMatch && namedMatch.index !== undefined) {
      const start = namedMatch.index + namedMatch[0].length;
      const schemaBody = extractBalancedBraces(fullContent, start);
      if (schemaBody) {
        return parseZodObjectFields(schemaBody);
      }
    }
  }

  return [];
}

/**
 * Parses individual fields from a z.object({...}) body.
 * Extracts field name, type, description, and whether it's required.
 */
/**
 * A `.describe("...")` call, removed from a field's chain before looking for
 * the sensitive marker so describe text that mentions it does not count.
 */
const DESCRIBE_CALL =
  /\.describe\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*\)/g;

function parseZodObjectFields(schemaBody: string): ExtractedArgument[] {
  const args: ExtractedArgument[] = [];

  // Find field starts: fieldName: z.type( or "field-name": z.type(, where
  // the type may be namespaced, as in z.iso.datetime( or z.coerce.number(
  const fieldStartPattern =
    /(?:(\w+)|"([^"\\\n]+)"|'([^'\\\n]+)')\s*:\s*z\.(\w+(?:\.\w+)*)\(/g;
  let startMatch;
  while ((startMatch = fieldStartPattern.exec(schemaBody)) !== null) {
    const name = startMatch[1] ?? startMatch[2] ?? startMatch[3];
    const baseType = startMatch[4];
    const afterParen = startMatch.index + startMatch[0].length;

    // Use balanced paren matching to find the end of z.type(...)
    const parenEnd = findBalancedParen(schemaBody, afterParen);
    if (parenEnd === -1) continue;

    // Extract chain methods after the initial z.type(...) call
    // e.g. .optional().describe("...")
    let chain = "";
    const calls: ChainCall[] = [];
    let pos = parenEnd + 1;
    while (pos < schemaBody.length) {
      const chainMatch = schemaBody.slice(pos).match(/^\s*\.(\w+)\(/);
      if (!chainMatch) break;
      const chainCallStart = pos + chainMatch[0].length;
      const chainCallEnd = findBalancedParen(schemaBody, chainCallStart);
      if (chainCallEnd === -1) break;
      chain += schemaBody.slice(pos, chainCallEnd + 1);
      calls.push({
        method: chainMatch[1],
        args: schemaBody.slice(chainCallStart, chainCallEnd),
      });
      pos = chainCallEnd + 1;
    }

    const description = fieldDescription(calls, chain);

    // A field is required unless its chain lets undefined through
    // (optional, nullish) or replaces it (default, catch, prefault), or
    // the field itself is written as z.optional(...) / z.nullish(...).
    // nullable stays here for compatibility with what was published
    // before, although Zod itself still rejects undefined for it.
    const wrapperBase = baseType === "optional" || baseType === "nullish";
    const required = !wrapperBase &&
      !chain.includes(".optional()") &&
      !chain.includes(".nullable()") &&
      !chain.includes(".nullish()") &&
      !chain.includes(".default(") &&
      !chain.includes(".catch(") &&
      !chain.includes(".prefault(");

    args.push({
      name,
      type: baseType,
      description,
      required,
      ...(MARKED_SENSITIVE.test(chain.replace(DESCRIBE_CALL, ""))
        ? { sensitive: true as const }
        : {}),
    });

    // Advance past this field
    fieldStartPattern.lastIndex = pos;
  }

  return args;
}

/** One call chained directly on a field, such as `.describe("...")`. */
interface ChainCall {
  method: string;
  /** The text between the call's parentheses. */
  args: string;
}

/**
 * The text of a string literal at the start of `text`, up to the first quote
 * of the same kind, as the describe pattern has always read it. A template
 * literal counts only without interpolation.
 */
function leadingStringLiteral(text: string): string | undefined {
  const match = text.match(/^\s*(?:"([^"]*?)"|'([^']*?)'|`([^`]*?)`)/);
  if (!match) return undefined;
  if (match[3] !== undefined) {
    return match[3].includes("${") ? undefined : match[3];
  }
  return match[1] ?? match[2];
}

const META_DESCRIPTION_KEY = /^(?:description|"description"|'description')\s*:/;

/**
 * The `description` set by a `.meta({...})` call's own object literal: its
 * text, "" when the key is there but its value is not a string literal, or
 * undefined when the object sets no description.
 */
function metaDescription(args: string): string | undefined {
  const body = args.trimStart();
  if (!body.startsWith("{")) return undefined;
  let depth = 0;
  let quote: string | undefined;
  let previous = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (depth === 1 && (previous === "{" || previous === ",")) {
      const key = body.slice(i).match(META_DESCRIPTION_KEY);
      if (key) {
        return leadingStringLiteral(body.slice(i + key[0].length)) ?? "";
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return undefined;
    }
    if (!/\s/.test(ch)) previous = ch;
  }
  return undefined;
}

/**
 * A field's description. The first `.describe` with a quoted string anywhere
 * in the chain is used, as it always has been. Otherwise the last call on the
 * field that sets one decides, as zod keeps the last: a `.describe` with a
 * template literal, or a `.meta({...})` with a `description` key.
 */
function fieldDescription(calls: ChainCall[], chain: string): string {
  const descMatch = chain.match(
    /\.describe\(\s*(?:"([^"]*?)"|'([^']*?)')/,
  );
  if (descMatch) return descMatch[1] ?? descMatch[2] ?? "";
  for (let i = calls.length - 1; i >= 0; i--) {
    const { method, args } = calls[i];
    if (method === "describe") return leadingStringLiteral(args) ?? "";
    if (method === "meta") {
      const text = metaDescription(args);
      if (text !== undefined) return text;
    }
  }
  return "";
}

/**
 * Finds the position of the closing parenthesis matching an opening one.
 * `start` is the position right after the opening `(`.
 * Returns the index of the closing `)` or -1 if not found.
 */
function findBalancedParen(text: string, start: number): number {
  let depth = 1;
  let i = start;

  while (i < text.length && depth > 0) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Extracts resource output specs from the source.
 */
function extractResources(content: string): ExtractedResource[] {
  const resources: ExtractedResource[] = [];

  // Find the resources block (but not inside methods)
  const match = content.match(/(?<![.\w])resources:\s*\{/);
  if (!match || match.index === undefined) return resources;

  const start = match.index + match[0].length;
  const block = extractBalancedBraces(content, start);
  if (!block) return resources;

  // Find each entry key and extract its balanced block
  const keyPattern = /["']?(\w[\w-]*)["']?\s*:\s*\{/g;
  let keyMatch;
  while ((keyMatch = keyPattern.exec(block)) !== null) {
    const entryStart = keyMatch.index! + keyMatch[0].length;
    const entryBody = extractBalancedBraces(block, entryStart);
    if (!entryBody) continue;

    const descMatch = entryBody.match(
      /description:\s*(?:"([^"]*?)"|'([^']*?)')/,
    );
    const lifetimeMatch = entryBody.match(/lifetime:\s*["'](\w+)["']/);
    if (!descMatch || !lifetimeMatch) continue;

    resources.push({
      key: keyMatch[1],
      description: descMatch[1] ?? descMatch[2] ?? "",
      lifetime: lifetimeMatch[1],
    });

    // Advance past this entry to avoid re-matching nested braces
    keyPattern.lastIndex = entryStart + (entryBody?.length ?? 0) + 1;
  }

  return resources;
}

/**
 * Extracts file output specs from the source.
 */
function extractFiles(content: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];

  // Find the files block
  const match = content.match(/(?<![.\w])files:\s*\{/);
  if (!match || match.index === undefined) return files;

  const start = match.index + match[0].length;
  const block = extractBalancedBraces(content, start);
  if (!block) return files;

  // Find each entry key and extract its balanced block
  const keyPattern = /["']?(\w[\w-]*)["']?\s*:\s*\{/g;
  let keyMatch;
  while ((keyMatch = keyPattern.exec(block)) !== null) {
    const entryStart = keyMatch.index! + keyMatch[0].length;
    const entryBody = extractBalancedBraces(block, entryStart);
    if (!entryBody) continue;

    const descMatch = entryBody.match(
      /description:\s*(?:"([^"]*?)"|'([^']*?)')/,
    );
    const ctMatch = entryBody.match(/contentType:\s*["']([^"']+)["']/);
    if (!descMatch || !ctMatch) continue;

    files.push({
      key: keyMatch[1],
      description: descMatch[1] ?? descMatch[2] ?? "",
      contentType: ctMatch[1],
    });

    // Advance past this entry
    keyPattern.lastIndex = entryStart + (entryBody?.length ?? 0) + 1;
  }

  return files;
}

/**
 * A step's task in its stored form: a behavior-spelled task is rewritten to
 * `model_method` (swamp-club#3334). Metadata extraction is best-effort, so a
 * task the rewrite refuses is read as written.
 */
function readTask(raw: unknown): Record<string, unknown> | undefined {
  let task: unknown = raw;
  try {
    task = normalizeBehaviorTask(raw);
  } catch {
    // A mixed-spelling task: leave it as written.
  }
  return task && typeof task === "object"
    ? task as Record<string, unknown>
    : undefined;
}

/**
 * Extracts workflow metadata from a YAML file content.
 * Returns null if the content doesn't contain a valid workflow structure.
 */
function extractWorkflowFromYaml(
  content: string,
  fileName: string,
): ExtractedWorkflow | null {
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== "object") return null;

  const data = parsed as Record<string, unknown>;

  const id = typeof data.id === "string" ? data.id : "";
  const name = typeof data.name === "string" ? data.name : "";
  if (!name) return null;

  const description = typeof data.description === "string"
    ? data.description
    : "";

  const jobs: ExtractedWorkflowJob[] = [];
  if (Array.isArray(data.jobs)) {
    for (const job of data.jobs) {
      if (!job || typeof job !== "object") continue;
      const jobData = job as Record<string, unknown>;

      const jobName = typeof jobData.name === "string" ? jobData.name : "";
      const jobDescription = typeof jobData.description === "string"
        ? jobData.description
        : "";

      const steps: ExtractedWorkflowStep[] = [];
      if (Array.isArray(jobData.steps)) {
        for (const step of jobData.steps) {
          if (!step || typeof step !== "object") continue;
          const stepData = step as Record<string, unknown>;

          const stepName = typeof stepData.name === "string"
            ? stepData.name
            : "";
          const stepDescription = typeof stepData.description === "string"
            ? stepData.description
            : "";

          const task = readTask(stepData.task);
          const taskType = task && typeof task.type === "string"
            ? task.type
            : "";
          const modelIdOrName = task && typeof task.modelIdOrName === "string"
            ? task.modelIdOrName
            : "";
          const methodName = task && typeof task.methodName === "string"
            ? task.methodName
            : "";

          steps.push({
            name: stepName,
            description: stepDescription,
            taskType,
            modelIdOrName,
            methodName,
          });
        }
      }

      jobs.push({ name: jobName, description: jobDescription, steps });
    }
  }

  return { fileName, id, name, description, jobs };
}

/**
 * Extracts datastore metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable datastore definition.
 * Uses `createProvider` as the discriminator combined with `export const datastore`.
 */
export function extractDatastoreFromSource(
  content: string,
  filePath: string,
  datastoresDir: string,
): ExtractedDatastore | null {
  const datastoreMatch = content.match(
    /export\s+const\s+datastore\s*=\s*\{/,
  );
  if (!datastoreMatch || datastoreMatch.index === undefined) return null;

  // Must contain createProvider to be a datastore file
  if (!/createProvider/.test(content)) return null;

  const datastoreStart = datastoreMatch.index + datastoreMatch[0].length;
  const datastoreBody = extractBalancedBraces(content, datastoreStart);
  if (!datastoreBody) return null;

  const typeMatch = datastoreBody.match(/type:\s*["']([^"']+)["']/);
  if (!typeMatch) return null;

  const topLevel = topLevelStringValues(datastoreBody);
  const hasConfigSchema = /configSchema\s*[:,}]/.test(datastoreBody);

  let configFields: ExtractedArgument[] = [];
  const configInline = datastoreBody.match(
    /configSchema:\s*z\.object\(\s*\{/,
  );
  if (configInline && configInline.index !== undefined) {
    const start = configInline.index + configInline[0].length;
    const schemaBody = extractBalancedBraces(datastoreBody, start);
    if (schemaBody) {
      configFields = parseZodObjectFields(schemaBody);
    }
  } else if (hasConfigSchema) {
    // Check for named schema reference: configSchema: SomeName
    const configRef = datastoreBody.match(/configSchema:\s*(\w+)/);
    // Also check shorthand property: configSchema,
    const shorthandRef = !configRef
      ? datastoreBody.match(/configSchema\s*[,\n}]/)
      : null;
    const schemaName = configRef?.[1] ??
      (shorthandRef ? "configSchema" : null);
    if (schemaName && schemaName !== "z") {
      const namedPattern = new RegExp(
        `(?:const|let)\\s+${schemaName}\\s*=\\s*z\\.object\\(\\s*\\{`,
      );
      const namedMatch = content.match(namedPattern);
      if (namedMatch && namedMatch.index !== undefined) {
        const start = namedMatch.index + namedMatch[0].length;
        const schemaBody = extractBalancedBraces(content, start);
        if (schemaBody) {
          configFields = parseZodObjectFields(schemaBody);
        }
      }
    }
  }

  return {
    fileName: contentFileName(datastoresDir, filePath),
    type: typeMatch[1],
    name: topLevel.get("name") ?? "",
    description: topLevel.get("description") ?? "",
    hasConfigSchema,
    configFields,
  };
}

/**
 * Extracts report metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable report definition.
 * Uses `execute` as the discriminator combined with `export const report`.
 */
function extractReportFromSource(
  content: string,
  filePath: string,
  reportsDir: string,
): ExtractedReport | null {
  const reportMatch = content.match(/export\s+const\s+report\s*=\s*\{/);
  if (!reportMatch || reportMatch.index === undefined) return null;

  // Must contain execute to be a report file
  if (!/execute/.test(content)) return null;

  const reportStart = reportMatch.index + reportMatch[0].length;
  const reportBody = extractBalancedBraces(content, reportStart);
  if (!reportBody) return null;

  const nameMatch = reportBody.match(/(?<![.\w])name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;

  const descMatch = reportBody.match(
    /(?<![.\w])description:\s*(?:"([^"]*?)"|'([^']*?)')/,
  );

  const scopeMatch = reportBody.match(/(?<![.\w])scope:\s*["']([^"']+)["']/);

  // Extract labels array
  const labels: string[] = [];
  const labelsMatch = reportBody.match(/(?<![.\w])labels:\s*\[([^\]]*)\]/);
  if (labelsMatch) {
    const labelsContent = labelsMatch[1];
    const labelPattern = /["']([^"']+)["']/g;
    let labelMatch;
    while ((labelMatch = labelPattern.exec(labelsContent)) !== null) {
      labels.push(labelMatch[1]);
    }
  }

  return {
    fileName: contentFileName(reportsDir, filePath),
    name: nameMatch[1],
    description: descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "",
    scope: scopeMatch ? scopeMatch[1] : "",
    labels,
  };
}

/**
 * Extracts webhook metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable webhook definition.
 * Uses `createHandler` as the discriminator combined with `export const webhook`.
 */
function extractWebhookFromSource(
  content: string,
  filePath: string,
  webhooksDir: string,
): ExtractedWebhook | null {
  const webhookMatch = content.match(
    /export\s+const\s+webhook\s*(?::[^=]*)?=\s*\{/,
  );
  if (!webhookMatch || webhookMatch.index === undefined) return null;

  // Must contain createHandler to be a webhook file
  if (!/createHandler/.test(content)) return null;

  const webhookStart = webhookMatch.index + webhookMatch[0].length;
  const webhookBody = extractBalancedBraces(content, webhookStart);
  if (!webhookBody) return null;

  const typeMatch = webhookBody.match(/type:\s*["']([^"']+)["']/);
  if (!typeMatch) return null;

  const nameMatch = webhookBody.match(/(?<![.\w])name:\s*["']([^"']+)["']/);
  const descMatch = webhookBody.match(
    /(?<![.\w])description:\s*(?:"([^"]*?)"|'([^']*?)')/,
  );

  return {
    fileName: contentFileName(webhooksDir, filePath),
    type: typeMatch[1],
    name: nameMatch ? nameMatch[1] : "",
    description: descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "",
  };
}

/**
 * Extracts the content between balanced braces, starting after an opening brace.
 * Returns the content between the braces (excluding the outer braces themselves).
 * Braces inside string, template, comment and regex literals are not counted.
 */
function extractBalancedBraces(
  text: string,
  startAfterBrace: number,
): string | null {
  const start = startAfterBrace - 1;
  if (text[start] !== "{") return null;
  const end = findClosingBrace(text, start, newScanState());
  return end === -1 ? null : text.slice(startAfterBrace, end);
}

/**
 * Returns the index of the brace that closes the one at `start`, or -1 when
 * it never closes. Literals are skipped with skipNonCode, so a brace inside a
 * string, template, comment or regex does not change the depth.
 */
function findClosingBrace(
  source: string,
  start: number,
  scan: ScanState,
): number {
  let depth = 0;
  let prev = "";
  let i = start;
  while (i < source.length) {
    const next = skipNonCode(source, i, prev, scan);
    if (next !== i) {
      if (!isComment(source, i)) prev = '"';
      i = next;
      continue;
    }
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
    else trackParen(source, i, scan);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return -1;
}

const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "throw",
  "yield",
  "await",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "new",
  "else",
  "do",
]);
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);
const MAX_TEMPLATE_DEPTH = 64;

/**
 * State carried through one brace scan. `noRegexBefore` records that a regex
 * failed to close before its newline; every later slash before that newline
 * is then read as division. That is a heuristic, not a proof (a slash inside
 * a failed `[` class can hide a real regex after it), and it is what keeps
 * the scan linear on lines full of slashes. `controlParens` holds one
 * entry per open paren: whether it opens an if/while/for/with header, after
 * which a slash starts a regex.
 */
interface ScanState {
  noRegexBefore: number;
  controlParens: boolean[];
  lastParenWasControl: boolean;
  templateDepth: number;
}

function newScanState(): ScanState {
  return {
    noRegexBefore: -1,
    controlParens: [],
    lastParenWasControl: false,
    templateDepth: 0,
  };
}

function trackParen(source: string, i: number, scan: ScanState): void {
  if (source[i] === "(") {
    let word = wordBefore(source, i);
    if (word === "await") {
      word = wordBefore(source, source.lastIndexOf("await", i));
    }
    scan.controlParens.push(CONTROL_KEYWORDS.has(word));
  } else if (source[i] === ")") {
    scan.lastParenWasControl = scan.controlParens.pop() ?? false;
  }
}

/** The identifier ending just before `i`, or "" when it is a property name. */
function wordBefore(source: string, i: number): string {
  let end = i;
  while (end > 0 && /\s/.test(source[end - 1])) end--;
  let start = end;
  while (start > 0 && /[\w$]/.test(source[start - 1])) start--;
  return start > 0 && source[start - 1] === "." ? "" : source.slice(start, end);
}

function isComment(source: string, i: number): boolean {
  return source.startsWith("//", i) || source.startsWith("/*", i);
}

/**
 * Returns the index past a string, template, comment or regex literal at `i`,
 * or `i` when there is none. An unterminated string or regex ends at its
 * newline so one stray quote cannot swallow the file. Template expressions
 * are scanned as code, up to MAX_TEMPLATE_DEPTH levels deep.
 *
 * Telling a regex from division is a heuristic. Known misreadings: a
 * variable named like a keyword (`of`, `in`, `yield`, `await`) followed by
 * division is taken as a regex start, and JSX text (`</tag>`, an apostrophe
 * in `Don't`) is read as regex or string syntax. Each can only affect the
 * rest of one line, since unclosed regexes and strings stop at the newline.
 */
function skipNonCode(
  source: string,
  i: number,
  prev: string,
  scan: ScanState,
): number {
  const c = source[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < source.length; j++) {
      if (source[j] === "\\") j++;
      else if (source[j] === c) return j + 1;
      else if (source[j] === "\n") return j;
    }
    return source.length;
  }
  if (c === "`") {
    for (let j = i + 1; j < source.length; j++) {
      if (source[j] === "\\") j++;
      else if (source[j] === "`") return j + 1;
      else if (source[j] === "$" && source[j + 1] === "{") {
        // Past the cap the template reads as unterminated rather than
        // recursing toward a stack overflow.
        if (scan.templateDepth >= MAX_TEMPLATE_DEPTH) return source.length;
        scan.templateDepth++;
        const close = findClosingBrace(source, j + 1, scan);
        scan.templateDepth--;
        if (close === -1) return source.length;
        j = close;
      }
    }
    return source.length;
  }
  if (c !== "/") return i;
  if (source[i + 1] === "/") {
    const end = source.indexOf("\n", i);
    return end === -1 ? source.length : end + 1;
  }
  if (source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  // A slash after a value is division; after an operator, opener, keyword or
  // control header it starts a regex. A postfix `++` or `--` ends a value, so
  // the slash after it is division.
  if (
    prev !== "" && !REGEX_PRECEDERS.includes(prev) &&
    !REGEX_KEYWORDS.has(wordBefore(source, i)) &&
    !(prev === ")" && scan.lastParenWasControl)
  ) return i;
  if (prev === "+" || prev === "-") {
    let k = i - 1;
    while (k > 0 && /\s/.test(source[k])) k--;
    if (source[k - 1] === prev) return i;
  }
  if (i < scan.noRegexBefore) return i;
  let inClass = false;
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") j++;
    else if (ch === "\n") {
      scan.noRegexBefore = j;
      return i;
    } else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "/") {
      let k = j + 1;
      while (k < source.length && /\w/.test(source[k])) k++;
      return k;
    }
  }
  scan.noRegexBefore = source.length;
  return i;
}
