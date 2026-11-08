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

import { exitDeadline, untilDeadline } from "./otlp_export_queue.ts";
import type { Context } from "@opentelemetry/api";
import { parseOtlpHeaders, resolveOtlpEndpoint } from "./otel_config.ts";

let providerRef: { shutdown(): Promise<void> } | undefined;

export interface InitTracingConfig {
  endpoint?: string;
  exporterKind?: string;
  bspUse?: boolean;
  traceparent?: string;
  tracestate?: string;
  envGet?: (key: string) => string | undefined;
}

export async function initTracing(
  config?: InitTracingConfig,
): Promise<Context | undefined> {
  const envGet = config?.envGet ?? Deno.env.get.bind(Deno.env);
  const endpoint = config?.endpoint !== undefined
    ? resolveOtlpEndpoint("traces", { genericEndpoint: config.endpoint })
    : resolveOtlpEndpoint("traces");
  const exporterKind = config?.exporterKind ??
    envGet("OTEL_TRACES_EXPORTER") ?? "otlp";

  if (!endpoint && exporterKind !== "console") {
    return undefined;
  }

  const [
    {
      BasicTracerProvider,
      BatchSpanProcessor,
      SimpleSpanProcessor,
      ConsoleSpanExporter,
    },
    { AsyncLocalStorageContextManager },
    { Resource, envDetectorSync },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    contextApi,
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/api"),
  ]);

  // Deno.exit can beat BatchSpanProcessor's window, so default to
  // SimpleSpanProcessor; OTEL_BSP_USE=1 opts into batching for long-running
  // modes like serve
  const useBatch = config?.bspUse ?? envGet("OTEL_BSP_USE") === "1";

  const contextManager = new AsyncLocalStorageContextManager();
  contextApi.context.setGlobalContextManager(contextManager);

  const { buildOtelResource } = await import("./otel_resource.ts");
  const resource = buildOtelResource(Resource, envDetectorSync, {
    serviceNameAttr: ATTR_SERVICE_NAME,
    serviceVersionAttr: ATTR_SERVICE_VERSION,
  });

  const provider = new BasicTracerProvider({ resource });

  const wrapProcessor = (
    e: ConstructorParameters<typeof SimpleSpanProcessor>[0],
  ) => useBatch ? new BatchSpanProcessor(e) : new SimpleSpanProcessor(e);

  if (exporterKind === "console") {
    provider.addSpanProcessor(wrapProcessor(new ConsoleSpanExporter()));
  } else {
    // native fetch exporter, since Node http/https modules fail TLS in compiled
    // binaries
    const { FetchOtlpExporter } = await import("./fetch_otlp_exporter.ts");
    const headers = parseOtlpHeaders("traces");

    const exporter = new FetchOtlpExporter({
      url: endpoint!,
      headers,
    });
    provider.addSpanProcessor(wrapProcessor(exporter));
  }

  provider.register();

  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
  contextApi.propagation.setGlobalPropagator(
    new W3CTraceContextPropagator(),
  );

  providerRef = provider;

  const { installExecutionObserver } = await import("./execution_observer.ts");
  installExecutionObserver();

  const traceparent = config?.traceparent ?? envGet("TRACEPARENT");
  if (traceparent) {
    const headers: Record<string, string> = { traceparent };
    const tracestate = config?.tracestate ?? envGet("TRACESTATE");
    if (tracestate) headers.tracestate = tracestate;
    return contextApi.propagation.extract(
      contextApi.context.active(),
      headers,
    );
  }
  return undefined;
}

export async function shutdownTracing(
  deadline: number = exitDeadline(),
): Promise<void> {
  const { setExecutionObserver } = await import(
    "../../domain/remote/observability.ts"
  );
  setExecutionObserver(undefined);
  if (providerRef) {
    await untilDeadline(providerRef.shutdown(), deadline);
    providerRef = undefined;

    const contextApi = await import("@opentelemetry/api");
    contextApi.trace.disable();
    contextApi.context.disable();
    contextApi.propagation.disable();
  }
}
