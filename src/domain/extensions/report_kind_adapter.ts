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

import { z } from "zod";
import type { ReportContext } from "../reports/report_context.ts";
import type { ReportResult } from "../reports/report.ts";
import { reportRegistry } from "../reports/report_registry.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { KindAdapter, ValidationResult } from "./kind_adapter.ts";

const USER_REPORT_NAME_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

const UserReportSchema = z.object({
  name: z.string().refine(
    (n) => USER_REPORT_NAME_PATTERN.test(n),
    {
      message:
        "Report name must match @collective/name or collective/name with optional nested segments",
    },
  ),
  description: z.string(),
  scope: z.enum(["method", "model", "workflow"]),
  labels: z.array(z.string()).optional(),
  execute: z.custom<(ctx: ReportContext) => Promise<ReportResult>>(
    (val) => typeof val === "function",
  ),
});

export const reportKindAdapter: KindAdapter = {
  kind: "report",
  bundleSubdir: SWAMP_SUBDIRS.reportBundles,
  catalogKinds: ["report"],
  primaryExportKey: "report",
  exportRegex: /export\s+const\s+report\s*[=:]/,
  useResolver: true,

  validatePrimaryExport(exported: unknown): ValidationResult {
    const result = UserReportSchema.safeParse(exported);
    if (result.success) {
      return { success: true, data: result.data as Record<string, unknown> };
    }
    return { success: false, error: result.error };
  },

  formatValidationError(error: z.ZodError): string {
    return error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  },

  normalizeType(validated: Record<string, unknown>): string {
    return String(validated.name).toLowerCase();
  },

  extractTypeFromSource(source: string) {
    if (!/export\s+const\s+report\s*[=:]/.test(source)) return null;
    const nameMatch = source.match(
      /export\s+const\s+report\s*=\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/,
    );
    if (!nameMatch) return null;
    return {
      typeNormalized: nameMatch[1].toLowerCase(),
      version: "",
      kind: "report" as const,
      extendsType: "",
    };
  },

  register(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
  ): void {
    const v = validated as z.infer<typeof UserReportSchema>;
    reportRegistry.register(v.name, {
      description: v.description,
      scope: v.scope,
      labels: v.labels,
      execute: v.execute,
    });
  },

  registerLazy(entry: ExtensionTypeRow): void {
    reportRegistry.registerLazy({
      type: entry.type_normalized,
      bundlePath: entry.bundle_path,
      sourcePath: entry.source_path,
      version: entry.version,
    });
  },

  promoteFromLazy(
    _typeNormalized: string,
    validated: Record<string, unknown>,
    _module: Record<string, unknown>,
  ): void {
    const v = validated as z.infer<typeof UserReportSchema>;
    reportRegistry.promoteFromLazy(v.name, {
      description: v.description,
      scope: v.scope,
      labels: v.labels,
      execute: v.execute,
    });
  },

  hasType(typeNormalized: string): boolean {
    return reportRegistry.has(typeNormalized);
  },

  isFullyLoaded(typeNormalized: string): boolean {
    return reportRegistry.get(typeNormalized) !== undefined;
  },
};
