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

import { extname, join, resolve, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import {
  type AcceptanceDirective,
  commentFormFor,
  type InvalidAcceptance,
  MAX_ACCEPTANCE_REASON_LENGTH,
  validateAcceptance,
} from "./extension_acceptances.ts";
import { isSafeRelativePath } from "./extension_manifest.ts";
import { findRule } from "./extension_rule_catalog.ts";

/**
 * The `quality.yaml` sidecar: declared acceptances that have no line to
 * live on, beside the manifest.
 *
 * It is discovered by location only (`quality.yaml` in the manifest's
 * directory), never named in the manifest: most manifests are regenerated,
 * and the manifest schema drops unknown keys silently. It is packaged into
 * the archive root beside `manifest.yaml` and is part of the content hash.
 *
 * ```yaml
 * version: 1
 * generated:                       # a codegen package (shape agreed with Lab #3065)
 *   by: swamp-extensions/codegen
 *   source: https://api.example.com/openapi.yaml
 *   commit: 0123abcd
 * accept:
 *   - rule: bare-specifiers        # an extension-scoped rule
 *     reason: scored locally; the server cannot resolve the import map
 *   - rule: ipv4-address-literals  # a site-scoped rule in a .txt file, which has no comment form
 *     file: docs/hosts.txt
 *     reason: documented lab addresses
 * ```
 *
 * The sidecar cannot accept a site-scoped rule in a file that has a comment
 * form; that acceptance belongs on the line. It cannot accept an
 * error-level rule, and it cannot name a file outside the manifest's
 * directory.
 */

/** The sidecar's file name, beside `manifest.yaml`. */
export const QUALITY_SIDECAR_FILENAME = "quality.yaml";

/** The largest sidecar read, in bytes. */
export const MAX_SIDECAR_BYTES = 64 * 1024;

/** The most `accept` entries a sidecar may carry. */
export const MAX_SIDECAR_ENTRIES = 50;

/** The longest value a `generated` field may carry. */
export const MAX_GENERATED_FIELD_LENGTH = 200;

const generatedField = z.string().trim().min(1).max(MAX_GENERATED_FIELD_LENGTH);

/** The `generated` declaration: who generated the package, from what, at which commit. */
const GeneratedDeclarationSchema = z.object({
  by: generatedField,
  source: generatedField,
  commit: generatedField,
}).strict();

const SidecarAcceptanceSchema = z.object({
  rule: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1, "a reason is required").max(
    MAX_ACCEPTANCE_REASON_LENGTH,
  ),
  file: z.string().min(1).max(512).refine(isSafeRelativePath, {
    message:
      "Path must be relative and must not contain '..' components or start with '/'",
  }).optional(),
}).strict();

const QualitySidecarSchema = z.object({
  version: z.literal(1),
  generated: GeneratedDeclarationSchema.optional(),
  accept: z.array(SidecarAcceptanceSchema).max(MAX_SIDECAR_ENTRIES).optional(),
}).strict();

/** The `generated` declaration. */
export type GeneratedDeclaration = z.infer<typeof GeneratedDeclarationSchema>;

/** One `accept` entry. */
export type SidecarAcceptance = z.infer<typeof SidecarAcceptanceSchema>;

/** The parsed sidecar. */
export interface QualitySidecar {
  version: 1;
  generated?: GeneratedDeclaration;
  accept: SidecarAcceptance[];
}

/** Result of parsing a sidecar: the value, or why it was refused. */
export type QualitySidecarParseResult =
  | { ok: true; sidecar: QualitySidecar }
  | { ok: false; errors: string[] };

/** Parses and validates sidecar text. Never throws. */
export function parseQualitySidecar(raw: string): QualitySidecarParseResult {
  if (raw.length > MAX_SIDECAR_BYTES) {
    return {
      ok: false,
      errors: [
        `${QUALITY_SIDECAR_FILENAME} is larger than ${MAX_SIDECAR_BYTES} bytes`,
      ],
    };
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `${QUALITY_SIDECAR_FILENAME} is not valid YAML: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
  const result = QualitySidecarSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) =>
        `${QUALITY_SIDECAR_FILENAME}: ${
          issue.path.length > 0 ? issue.path.join(".") + ": " : ""
        }${issue.message}`
      ),
    };
  }
  return {
    ok: true,
    sidecar: {
      version: 1,
      ...(result.data.generated ? { generated: result.data.generated } : {}),
      accept: result.data.accept ?? [],
    },
  };
}

/** The path a sidecar would have beside the given manifest directory. */
export function qualitySidecarPath(manifestDir: string): string {
  return join(manifestDir, QUALITY_SIDECAR_FILENAME);
}

/** True when `candidate`, resolved against `manifestDir`, stays inside it. */
function isInside(manifestDir: string, candidate: string): boolean {
  const root = resolve(manifestDir);
  const target = resolve(root, candidate);
  return target === root || target.startsWith(root + SEPARATOR);
}

/** The reason text a generated declaration carries on the findings it accepts. */
export function generatedReason(generated: GeneratedDeclaration): string {
  return `generated by ${generated.by} from ${generated.source} at ${generated.commit}`;
}

/**
 * Turns a parsed sidecar into acceptance directives, validating each entry
 * against the rule catalog. `sidecarPath` is recorded as where the entries
 * were declared, with the entry's 1-based index as the line; the generated
 * declaration is recorded at line 0.
 */
export function sidecarDirectives(
  sidecar: QualitySidecar,
  sidecarPath: string,
  manifestDir: string,
): { directives: AcceptanceDirective[]; invalid: InvalidAcceptance[] } {
  const directives: AcceptanceDirective[] = [];
  const invalid: InvalidAcceptance[] = [];

  if (sidecar.generated) {
    directives.push({
      ruleId: "testing-completeness",
      reason: generatedReason(sidecar.generated),
      target: { kind: "extension" },
      source: "generated",
      declaredAt: { file: sidecarPath, line: 0 },
    });
  }

  sidecar.accept.forEach((entry, index) => {
    const line = index + 1;
    const text = `accept[${index}]: ${entry.rule}${
      entry.file ? ` (${entry.file})` : ""
    }`;
    const reject = (problem: string) =>
      invalid.push({ file: sidecarPath, line, text, problem });

    if (entry.file === undefined) {
      const problem = validateAcceptance(entry.rule, entry.reason, "sidecar");
      if (problem !== undefined) {
        reject(problem);
        return;
      }
      directives.push({
        ruleId: entry.rule,
        reason: entry.reason,
        target: { kind: "extension" },
        source: "sidecar",
        declaredAt: { file: sidecarPath, line },
      });
      return;
    }

    const problem = validateAcceptance(
      entry.rule,
      entry.reason,
      "sidecar-file",
    );
    if (problem !== undefined) {
      reject(problem);
      return;
    }
    if (!isInside(manifestDir, entry.file)) {
      reject(`"${entry.file}" is outside the manifest's directory`);
      return;
    }
    const scope = findRule(entry.rule)!.scope;
    if (scope !== "site") {
      reject(
        `"${entry.rule}" is file-scoped; declare it in ${entry.file} itself, or use the generated declaration for a generated package`,
      );
      return;
    }
    if (commentFormFor(entry.file) !== "none") {
      reject(
        `"${entry.rule}" is site-scoped and ${
          extname(entry.file)
        } files take the acceptance as a comment on the line; the sidecar names a file only for kinds with no comment form (.txt)`,
      );
      return;
    }
    directives.push({
      ruleId: entry.rule,
      reason: entry.reason,
      target: { kind: "file", file: resolve(manifestDir, entry.file) },
      source: "sidecar",
      declaredAt: { file: sidecarPath, line },
    });
  });

  return { directives, invalid };
}
