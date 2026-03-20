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

import { relative } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type {
  ExtensionContentMetadata,
  ExtractedArgument,
  ExtractedDatastore,
  ExtractedDriver,
  ExtractedFile,
  ExtractedMethod,
  ExtractedModel,
  ExtractedReport,
  ExtractedResource,
  ExtractedVault,
  ExtractedWorkflow,
  ExtractedWorkflowJob,
  ExtractedWorkflowStep,
} from "./extension_content.ts";

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
  driverFiles: string[] = [],
  driversDir = "",
  datastoreFiles: string[] = [],
  datastoresDir = "",
  reportFiles: string[] = [],
  reportsDir = "",
): Promise<ExtensionContentMetadata> {
  const models: ExtractedModel[] = [];
  const workflows: ExtractedWorkflow[] = [];
  const vaults: ExtractedVault[] = [];
  const drivers: ExtractedDriver[] = [];
  const datastores: ExtractedDatastore[] = [];
  const reports: ExtractedReport[] = [];

  for (const filePath of modelFiles) {
    try {
      const content = await Deno.readTextFile(filePath);
      const model = extractModelFromSource(content, filePath, modelsDir);
      if (model) {
        models.push(model);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const wf of workflowFiles) {
    try {
      const content = await Deno.readTextFile(wf.sourcePath);
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
      const content = await Deno.readTextFile(filePath);
      const vault = extractVaultFromSource(content, filePath, vaultsDir);
      if (vault) {
        vaults.push(vault);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const filePath of driverFiles) {
    try {
      const content = await Deno.readTextFile(filePath);
      const driver = extractDriverFromSource(content, filePath, driversDir);
      if (driver) {
        drivers.push(driver);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  for (const filePath of datastoreFiles) {
    try {
      const content = await Deno.readTextFile(filePath);
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
      const content = await Deno.readTextFile(filePath);
      const report = extractReportFromSource(content, filePath, reportsDir);
      if (report) {
        reports.push(report);
      }
    } catch {
      // Non-fatal: skip files that can't be read or parsed
    }
  }

  return { models, workflows, vaults, drivers, datastores, reports };
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
    fileName: relative(modelsDir, filePath),
    type,
    version,
    globalArguments,
    methods,
    resources,
    files,
  };
}

/**
 * Extracts the model type string.
 * Matches `ModelType.create("...")` or `type: "..."` patterns.
 */
function extractModelType(content: string): string | null {
  // Match ModelType.create("type-name") or ModelType.create('type-name')
  const modelTypeMatch = content.match(
    /ModelType\.create\(\s*["']([^"']+)["']\s*\)/,
  );
  if (modelTypeMatch) return modelTypeMatch[1];

  // Match type: "type-name" or type: 'type-name' in object literal
  const typeLiteralMatch = content.match(
    /type:\s*["']([^"']+)["']/,
  );
  if (typeLiteralMatch) return typeLiteralMatch[1];

  return null;
}

/**
 * Extracts the model version string.
 * Matches `version: "YYYY.MM.DD.N"` patterns.
 */
function extractModelVersion(content: string): string | null {
  const match = content.match(/version:\s*["']([^"']+)["']/);
  return match ? match[1] : null;
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
function extractVaultFromSource(
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

  // Extract name
  const nameMatch = vaultBody.match(/(?<![.\w])name:\s*["']([^"']+)["']/);

  // Extract description
  const descMatch = vaultBody.match(
    /(?<![.\w])description:\s*(?:"([^"]*?)"|'([^']*?)')/,
  );

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
    fileName: relative(vaultsDir, filePath),
    type: typeMatch[1],
    name: nameMatch ? nameMatch[1] : "",
    description: descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "",
    hasConfigSchema,
    configFields,
  };
}

/**
 * Extracts method definitions from the source.
 * Matches the `methods: { name: { description: "..." } }` pattern.
 */
function extractMethods(content: string): ExtractedMethod[] {
  const methods: ExtractedMethod[] = [];

  // Find the methods block
  const methodsBlockMatch = content.match(/methods:\s*\{/);
  if (!methodsBlockMatch || methodsBlockMatch.index === undefined) {
    return methods;
  }

  const methodsStart = methodsBlockMatch.index + methodsBlockMatch[0].length;
  const methodsBlock = extractBalancedBraces(content, methodsStart);
  if (!methodsBlock) return methods;

  // Match individual method entries: methodName: { description: "..." }
  const methodPattern =
    /(\w+)\s*:\s*\{[^}]*?description:\s*(?:"([^"]*?)"|'([^']*?)'|`([^`]*?)`)/gs;
  let match;
  while ((match = methodPattern.exec(methodsBlock)) !== null) {
    const name = match[1];
    const description = match[2] ?? match[3] ?? match[4] ?? "";

    // Try to extract arguments for this method
    const methodEntry = extractMethodEntry(methodsBlock, name);
    const args = methodEntry
      ? extractMethodArguments(methodEntry, content)
      : [];

    methods.push({ name, description, arguments: args });
  }

  return methods;
}

/**
 * Extracts the full text of a single method entry from the methods block.
 */
function extractMethodEntry(
  methodsBlock: string,
  methodName: string,
): string | null {
  const pattern = new RegExp(`${methodName}\\s*:\\s*\\{`);
  const match = methodsBlock.match(pattern);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  return extractBalancedBraces(methodsBlock, start);
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
function parseZodObjectFields(schemaBody: string): ExtractedArgument[] {
  const args: ExtractedArgument[] = [];

  // Find field starts: fieldName: z.type(
  const fieldStartPattern = /(\w+)\s*:\s*z\.(\w+)\(/g;
  let startMatch;
  while ((startMatch = fieldStartPattern.exec(schemaBody)) !== null) {
    const name = startMatch[1];
    const baseType = startMatch[2];
    const afterParen = startMatch.index + startMatch[0].length;

    // Use balanced paren matching to find the end of z.type(...)
    const parenEnd = findBalancedParen(schemaBody, afterParen);
    if (parenEnd === -1) continue;

    // Extract chain methods after the initial z.type(...) call
    // e.g. .optional().describe("...")
    let chain = "";
    let pos = parenEnd + 1;
    while (pos < schemaBody.length) {
      const chainMatch = schemaBody.slice(pos).match(/^\s*\.\w+\(/);
      if (!chainMatch) break;
      const chainCallStart = pos + chainMatch[0].length;
      const chainCallEnd = findBalancedParen(schemaBody, chainCallStart);
      if (chainCallEnd === -1) break;
      chain += schemaBody.slice(pos, chainCallEnd + 1);
      pos = chainCallEnd + 1;
    }

    // Extract description from .describe("...")
    const descMatch = chain.match(
      /\.describe\(\s*(?:"([^"]*?)"|'([^']*?)')/,
    );
    const description = descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "";

    // Determine if optional
    const required = !chain.includes(".optional()") &&
      !chain.includes(".nullable()");

    args.push({ name, type: baseType, description, required });

    // Advance past this field
    fieldStartPattern.lastIndex = pos;
  }

  return args;
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

          const task = stepData.task as Record<string, unknown> | undefined;
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
 * Extracts driver metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable driver definition.
 * Uses `createDriver` as the discriminator.
 */
function extractDriverFromSource(
  content: string,
  filePath: string,
  driversDir: string,
): ExtractedDriver | null {
  if (!/createDriver/.test(content)) return null;

  const driverMatch = content.match(/export\s+const\s+driver\s*=\s*\{/);
  if (!driverMatch || driverMatch.index === undefined) return null;

  const driverStart = driverMatch.index + driverMatch[0].length;
  const driverBody = extractBalancedBraces(content, driverStart);
  if (!driverBody) return null;

  const typeMatch = driverBody.match(/type:\s*["']([^"']+)["']/);
  if (!typeMatch) return null;

  const nameMatch = driverBody.match(/(?<![.\w])name:\s*["']([^"']+)["']/);
  const descMatch = driverBody.match(
    /(?<![.\w])description:\s*(?:"([^"]*?)"|'([^']*?)')/,
  );
  const hasConfigSchema = /configSchema\s*[:,}]/.test(driverBody);

  let configFields: ExtractedArgument[] = [];
  const configInline = driverBody.match(/configSchema:\s*z\.object\(\s*\{/);
  if (configInline && configInline.index !== undefined) {
    const start = configInline.index + configInline[0].length;
    const schemaBody = extractBalancedBraces(driverBody, start);
    if (schemaBody) {
      configFields = parseZodObjectFields(schemaBody);
    }
  } else if (hasConfigSchema) {
    // Check for named schema reference: configSchema: SomeName
    const configRef = driverBody.match(/configSchema:\s*(\w+)/);
    // Also check shorthand property: configSchema,
    const shorthandRef = !configRef
      ? driverBody.match(/configSchema\s*[,\n}]/)
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
    fileName: relative(driversDir, filePath),
    type: typeMatch[1],
    name: nameMatch ? nameMatch[1] : "",
    description: descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "",
    hasConfigSchema,
    configFields,
  };
}

/**
 * Extracts datastore metadata from a TypeScript source file.
 * Returns null if the file doesn't contain a recognizable datastore definition.
 * Uses `createProvider` as the discriminator combined with `export const datastore`.
 */
function extractDatastoreFromSource(
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

  const nameMatch = datastoreBody.match(
    /(?<![.\w])name:\s*["']([^"']+)["']/,
  );
  const descMatch = datastoreBody.match(
    /(?<![.\w])description:\s*(?:"([^"]*?)"|'([^']*?)')/,
  );
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
    fileName: relative(datastoresDir, filePath),
    type: typeMatch[1],
    name: nameMatch ? nameMatch[1] : "",
    description: descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "",
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
    fileName: relative(reportsDir, filePath),
    name: nameMatch[1],
    description: descMatch ? (descMatch[1] ?? descMatch[2] ?? "") : "",
    scope: scopeMatch ? scopeMatch[1] : "",
    labels,
  };
}

/**
 * Extracts the content between balanced braces, starting after an opening brace.
 * Returns the content between the braces (excluding the outer braces themselves).
 */
function extractBalancedBraces(
  text: string,
  startAfterBrace: number,
): string | null {
  let depth = 1;
  let i = startAfterBrace;

  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    i++;
  }

  if (depth !== 0) return null;
  // Return content between the braces (exclude closing brace)
  return text.slice(startAfterBrace, i - 1);
}
