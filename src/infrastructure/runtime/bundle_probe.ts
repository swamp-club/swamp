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

// Probes one bundle: imports it and answers with what it exports, as plain
// data (swamp-club#3374). The probe host process runs this after
// installProbeIsolation, so whatever the bundle does at import stays in
// that process, not in the command's.

import { installZodGlobal } from "../../domain/models/bundle.ts";
import type {
  BundleProbeRequest,
  BundleProbeResult,
} from "../../domain/extensions/bundle_prober.ts";
import {
  type KindAdapter,
  type LoaderKind,
  primaryExport,
} from "../../domain/extensions/kind_adapter.ts";

class ExitAtImport extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

/** What {@link installProbeIsolation} leaves the host to use. */
export interface ProbeIsolation {
  /** Lines a bundle wrote through `console`; taken by each answer. */
  readonly output: string[];
  /** The real `Deno.exit`, which a bundle's call no longer reaches. */
  readonly exit: (code?: number) => never;
}

/**
 * Makes this isolate safe to import bundles into: `console` output is
 * captured, `Deno.exit` throws instead of exiting, and errors a bundle's
 * leftover work raises later are swallowed, so they never end the host
 * under the next bundle. For the probe host only: it takes over the whole
 * isolate.
 */
export function installProbeIsolation(): ProbeIsolation {
  globalThis.addEventListener("error", (event) => event.preventDefault());
  globalThis.addEventListener(
    "unhandledrejection",
    (event) => event.preventDefault(),
  );

  const output: string[] = [];
  const capture = (...args: unknown[]) => {
    output.push(
      args.map((arg) => typeof arg === "string" ? arg : Deno.inspect(arg))
        .join(" "),
    );
  };
  for (
    const method of ["log", "info", "warn", "error", "debug", "trace"] as const
  ) {
    console[method] = capture;
  }

  const exit = Deno.exit.bind(Deno);
  Deno.exit = (code?: number): never => {
    throw new ExitAtImport(code ?? 0);
  };
  return { output, exit };
}

async function adapterFor(kind: LoaderKind): Promise<KindAdapter> {
  switch (kind) {
    case "model":
      return (await import("../../domain/extensions/model_kind_adapter.ts"))
        .modelKindAdapter;
    case "vault":
      return (await import("../../domain/extensions/vault_kind_adapter.ts"))
        .vaultKindAdapter;
    case "datastore":
      return (await import(
        "../../domain/extensions/datastore_kind_adapter.ts"
      )).datastoreKindAdapter;
    case "report":
      return (await import("../../domain/extensions/report_kind_adapter.ts"))
        .reportKindAdapter;
    case "webhook":
      return (await import("../../domain/extensions/webhook_kind_adapter.ts"))
        .webhookKindAdapter;
  }
}

function findExit(error: unknown): ExitAtImport | undefined {
  // Bounded: a cause chain can point back at itself.
  let e = error;
  for (let depth = 0; depth < 16 && e instanceof Error; depth++) {
    if (e instanceof ExitAtImport) return e;
    e = e.cause;
  }
  return undefined;
}

/**
 * Imports the bundle `request` names and reports its export. `onStarted`
 * is called once the kind adapter is loaded and the bundle's own import is
 * about to begin, so a caller can time that import alone. Never throws.
 */
export async function probeModule(
  request: BundleProbeRequest,
  onStarted: () => void = () => {},
): Promise<BundleProbeResult> {
  try {
    installZodGlobal();
    const adapter = await adapterFor(request.kind);
    onStarted();

    let module: Record<string, unknown>;
    try {
      module = await import(request.importUrl);
    } catch (error) {
      const exit = findExit(error);
      if (exit) return { tag: "exited", code: exit.code };
      return {
        tag: "import-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const primary = primaryExport(module, adapter);
    if (primary) {
      const parsed = adapter.validatePrimaryExport(primary);
      if (!parsed.success) {
        return {
          tag: "validation-failed",
          message: adapter.formatValidationError(parsed.error),
        };
      }
      return {
        tag: "primary",
        typeNormalized: adapter.normalizeType(parsed.data),
        version: String(parsed.data.version ?? ""),
        description: String(parsed.data.description ?? ""),
      };
    }

    const secondary = adapter.secondaryExportKey
      ? module[adapter.secondaryExportKey]
      : undefined;
    if (secondary && adapter.validateSecondaryExport) {
      const parsed = adapter.validateSecondaryExport(secondary);
      if (!parsed.success) {
        return { tag: "validation-failed", message: parsed.error.message };
      }
      return {
        tag: "secondary",
        typeNormalized: adapter.normalizeType(parsed.data),
      };
    }

    return { tag: "no-export" };
  } catch (error) {
    return {
      tag: "import-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
