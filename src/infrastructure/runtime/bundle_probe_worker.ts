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

// Worker entry point for WorkerBundleProber. It imports one bundle at a
// time and answers with what the bundle exports, as plain data. Whatever
// the bundle does at import happens in this isolate, not in the command's
// (swamp-club#3374). The worker shares the process's permissions: this is
// robustness isolation, not a sandbox.

import { installZodGlobal } from "../../domain/models/bundle.ts";
import type {
  BundleProbeRequest,
  BundleProbeResult,
} from "../../domain/extensions/bundle_prober.ts";
import type {
  KindAdapter,
  LoaderKind,
} from "../../domain/extensions/kind_adapter.ts";

/** What the worker posts back for one request. */
export interface BundleProbeReply {
  readonly result: BundleProbeResult;
  /** Lines the bundle wrote through `console` while it was imported. */
  readonly output: readonly string[];
}

class ExitAtImport extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BundleProbeRequest>) => void) | null;
  postMessage(message: BundleProbeReply): void;
};

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

// Deno.exit in a worker only closes the worker, after the import has gone
// on to finish; throwing instead stops the import where it asked to exit.
Deno.exit = (code?: number): never => {
  throw new ExitAtImport(code ?? 0);
};

installZodGlobal();

// Each adapter is loaded on first use, so probing one kind does not pay for
// the other four.
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
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e instanceof ExitAtImport) return e;
  }
  return undefined;
}

async function probe(request: BundleProbeRequest): Promise<BundleProbeResult> {
  const adapter = await adapterFor(request.kind);

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

  const primary = module[adapter.primaryExportKey];
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
}

scope.onmessage = async (event) => {
  let result: BundleProbeResult;
  try {
    result = await probe(event.data);
  } catch (error) {
    result = {
      tag: "import-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  scope.postMessage({ result, output: output.splice(0) });
};
