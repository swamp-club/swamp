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
import { MARKED_SENSITIVE } from "@swamp-club/extension-scoring/secret-docs";

/**
 * refuses a symlink: the safety gate refuses it later, and what its target
 * declares must not reach the content-collective check, which quotes it
 */
async function readSourceText(path: string): Promise<string> {
  if ((await Deno.lstat(path)).isSymlink) {
    throw new Error("symlinked source");
  }
  return await Deno.readTextFile(path);
}

/**
 * relative to dir with forward slashes on every OS, so a Windows push sends
 * what macOS and Linux send
 */
export function contentFileName(dir: string, filePath: string): string {
  const rel = relative(dir, filePath);
  return SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
}

/**
 * extraction is best-effort: files that fail to read or parse are skipped and
 * partial results returned
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
 * both spellings read the same; the model spelling is tried first so a model
 * file that also exports an unrelated behavior object reads as before
 */
function matchModelExportObject(content: string): RegExpMatchArray | null {
  const model = content.match(/export\s+const\s+model\s*=\s*\{/);
  if (model) return model;
  // the behavior spelling is read only in a file with a behavior definition (an
  // object declaring methods); a helper exporting an unrelated config like {
  // type: "retry" } has none
  return hasBehaviorDefinition(content)
    ? content.match(/export\s+const\s+behavior\s*=\s*\{/)
    : null;
}

/**
 * the first object after the = counts, whether plain, wrapped in a call or
 * annotated; an unrelated config like { type: "retry" } does not
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

export function declaresMethods(body: string): boolean {
  return /(?<![.\w])methods\s*(?:[:,}(]|$)/.test(body);
}

/**
 * the type: literal search is scoped to the model export body to avoid false
 * positives from strings elsewhere, such as embedded LLM prompts
 */
export function extractModelType(content: string): string | null {
  const modelTypeMatch = content.match(
    /ModelType\.create\(\s*["']([^"']+)["']\s*\)/,
  );
  if (modelTypeMatch) return modelTypeMatch[1];

  const body = extractModelExportBody(content);
  if (!body) return null;

  const typeLiteralMatch = body.match(/type:\s*["']([^"']+)["']/);
  if (typeLiteralMatch) return typeLiteralMatch[1];

  return null;
}

/**
 * null when the export is not a plain object literal or its braces do not
 * balance; every catalog field for a model comes from this body
 */
export function extractModelExportBody(content: string): string | null {
  const modelExportMatch = matchModelExportObject(content);
  if (!modelExportMatch || modelExportMatch.index === undefined) return null;

  const bodyStart = modelExportMatch.index + modelExportMatch[0].length;
  return extractBalancedBraces(content, bodyStart);
}

export function extractModelVersion(content: string): string | null {
  const body = extractModelExportBody(content);
  if (!body) return null;

  const match = body.match(/version:\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

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

function extractGlobalArguments(content: string): ExtractedArgument[] {
  // the negative lookbehind avoids matching nested keys, such as inside a
  // method entry
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

  const refMatch = content.match(/(?<![.\w])globalArguments:\s*(\w+)/);
  if (refMatch) {
    const schemaName = refMatch[1];
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

export function extractVaultFromSource(
  content: string,
  filePath: string,
  vaultsDir: string,
): ExtractedVault | null {
  if (!/createProvider/.test(content)) return null;

  const vaultMatch = content.match(/export\s+const\s+vault\s*=\s*\{/);
  if (!vaultMatch || vaultMatch.index === undefined) return null;

  const vaultStart = vaultMatch.index + vaultMatch[0].length;
  const vaultBody = extractBalancedBraces(content, vaultStart);
  if (!vaultBody) return null;

  const typeMatch = vaultBody.match(/type:\s*["']([^"']+)["']/);
  if (!typeMatch) return null;

  // Name and description are read at the top level of the definition only,
  // so a nested `name:` is never mistaken for the vault's own.
  const topLevel = topLevelStringValues(vaultBody);

  const hasConfigSchema = /configSchema\s*[:,}]/.test(vaultBody);

  let configFields: ExtractedArgument[] = [];
  const configInline = vaultBody.match(/configSchema:\s*z\.object\(\s*\{/);
  if (configInline && configInline.index !== undefined) {
    const start = configInline.index + configInline[0].length;
    const schemaBody = extractBalancedBraces(vaultBody, start);
    if (schemaBody) {
      configFields = parseZodObjectFields(schemaBody);
    }
  } else if (hasConfigSchema) {
    const configRef = vaultBody.match(/configSchema:\s*(\w+)/);
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
 * only a whole constant-string value counts; computed values like "Foo" +
 * suffix or a template with a substitution are left out; a repeated key takes
 * its last entry, as at runtime
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

const TYPE_ONLY_SUFFIX = /(?:as\s+const|satisfies\s+string)\b/y;

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

function extractMethods(content: string): ExtractedMethod[] {
  const inlineMethods = extractMethodsFromBlock(content, content);
  if (inlineMethods.length > 0) return inlineMethods;

  const refName = resolveMethodsReference(content);
  if (!refName) return [];

  const varBlock = findVariableObjectBody(content, refName);
  if (varBlock) {
    return extractMethodsFromBlock(varBlock, content);
  }

  return [];
}

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

function resolveMethodsReference(content: string): string | null {
  // shorthand methods appears when an imported variable named methods is used
  // in the model object literal
  const shorthandMatch = content.match(
    /(?:export\s+const\s+(?:model|extension)\s*=\s*\{[\s\S]*?)(?<![.\w])methods\s*[,}]/,
  ) ?? content.match(
    /(?:export\s+const\s+behavior\s*=\s*\{[\s\S]*?)(?<![.\w])methods\s*[,}]/,
  );
  if (shorthandMatch) {
    const beforeMethods = content.slice(
      0,
      (shorthandMatch.index ?? 0) + shorthandMatch[0].length,
    );
    if (!beforeMethods.match(/methods\s*:\s*[{\w]/)) {
      return "methods";
    }
  }

  const refMatch = content.match(/methods:\s*(\w+)\s*[,}\n]/);
  if (refMatch && refMatch[1] !== "{") {
    return refMatch[1];
  }

  return null;
}

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
 * description and arguments come from the entry's own body, so nested values
 * like checks: { ... } are never mistaken for the method's own
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

/** value is the first string literal only, so "a " + "b" yields "a " */
interface TopLevelEntry {
  key: string;
  body?: string;
  value?: string;
  raw?: string;
}

const TOP_LEVEL_KEY =
  /\s*(?:([A-Za-z_$][\w$]*)|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')\s*:/y;
const LEADING_STRING_LITERAL =
  /\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/y;

/**
 * only brace-depth-0 text is interpreted; nested bodies are skipped with the
 * same literal-aware scan as extractBalancedBraces, so braces or quotes in
 * strings, comments or regexes cannot throw it off
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

function extractMethodArguments(
  methodEntry: string,
  fullContent: string,
): ExtractedArgument[] {
  const inlineMatch = methodEntry.match(/arguments:\s*z\.object\(\s*\{/);
  if (inlineMatch && inlineMatch.index !== undefined) {
    const start = inlineMatch.index + inlineMatch[0].length;
    const schemaBody = extractBalancedBraces(methodEntry, start);
    if (schemaBody) {
      return parseZodObjectFields(schemaBody);
    }
  }

  const refMatch = methodEntry.match(/arguments:\s*(\w+)/);
  if (refMatch) {
    const schemaName = refMatch[1];
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

    const parenEnd = findBalancedParen(schemaBody, afterParen);
    if (parenEnd === -1) continue;

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

    // required unless the chain lets undefined through or replaces it
    // (optional, nullish, default, catch, prefault); nullable counts too, kept
    // for compatibility though Zod rejects undefined for it
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

    fieldStartPattern.lastIndex = pos;
  }

  return args;
}

interface ChainCall {
  method: string;
  args: string;
}

/**
 * reads up to the first quote of the same kind; a template literal counts only
 * without interpolation
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
 * the first .describe with a quoted string wins; otherwise the last call that
 * sets a description decides, as zod keeps the last
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

function extractResources(content: string): ExtractedResource[] {
  const resources: ExtractedResource[] = [];

  const match = content.match(/(?<![.\w])resources:\s*\{/);
  if (!match || match.index === undefined) return resources;

  const start = match.index + match[0].length;
  const block = extractBalancedBraces(content, start);
  if (!block) return resources;

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

    keyPattern.lastIndex = entryStart + (entryBody?.length ?? 0) + 1;
  }

  return resources;
}

function extractFiles(content: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];

  const match = content.match(/(?<![.\w])files:\s*\{/);
  if (!match || match.index === undefined) return files;

  const start = match.index + match[0].length;
  const block = extractBalancedBraces(content, start);
  if (!block) return files;

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

    keyPattern.lastIndex = entryStart + (entryBody?.length ?? 0) + 1;
  }

  return files;
}

/**
 * a behavior-spelled task is rewritten to model_method; extraction is
 * best-effort, so a task the rewrite refuses is read as written
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

export function extractDatastoreFromSource(
  content: string,
  filePath: string,
  datastoresDir: string,
): ExtractedDatastore | null {
  const datastoreMatch = content.match(
    /export\s+const\s+datastore\s*=\s*\{/,
  );
  if (!datastoreMatch || datastoreMatch.index === undefined) return null;

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
    const configRef = datastoreBody.match(/configSchema:\s*(\w+)/);
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

function extractReportFromSource(
  content: string,
  filePath: string,
  reportsDir: string,
): ExtractedReport | null {
  const reportMatch = content.match(/export\s+const\s+report\s*=\s*\{/);
  if (!reportMatch || reportMatch.index === undefined) return null;

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

function extractWebhookFromSource(
  content: string,
  filePath: string,
  webhooksDir: string,
): ExtractedWebhook | null {
  const webhookMatch = content.match(
    /export\s+const\s+webhook\s*(?::[^=]*)?=\s*\{/,
  );
  if (!webhookMatch || webhookMatch.index === undefined) return null;

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

function extractBalancedBraces(
  text: string,
  startAfterBrace: number,
): string | null {
  const start = startAfterBrace - 1;
  if (text[start] !== "{") return null;
  const end = findClosingBrace(text, start, newScanState());
  return end === -1 ? null : text.slice(startAfterBrace, end);
}

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
 * after a regex fails to close, later slashes on that line read as division (a
 * heuristic that keeps the scan linear); controlParens flags if/while/for/with
 * headers, after which a slash starts a regex
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
 * regex vs division is a heuristic: a keyword-named variable (of, in, yield,
 * await) before division reads as a regex, and JSX text can read as regex or
 * string; damage ends at the newline
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
