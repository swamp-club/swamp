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

/** Handle to the provider so we can flush on shutdown. */
let providerRef: { shutdown(): Promise<void> } | undefined;

/**
 * Initializes OpenTelemetry tracing if `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * All SDK packages are dynamically imported so they impose zero cost when
 * tracing is disabled. `@opentelemetry/api` is statically imported because it
 * returns no-op implementations by default.
 */
export async function initTracing(): Promise<void> {
  const endpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const exporterKind = Deno.env.get("OTEL_TRACES_EXPORTER") ?? "otlp";

  if (!endpoint && exporterKind !== "console") {
    // No endpoint configured and not console mode — tracing stays disabled.
    return;
  }

  // Dynamic imports — only loaded when tracing is actually enabled.
  const [
    { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter },
    { AsyncLocalStorageContextManager },
    { Resource },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    contextApi,
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/api"),
  ]);

  // Register AsyncLocalStorage-based context manager
  const contextManager = new AsyncLocalStorageContextManager();
  contextApi.context.setGlobalContextManager(contextManager);

  const serviceName = Deno.env.get("OTEL_SERVICE_NAME") ?? "swamp";

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: Deno.env.get("SWAMP_VERSION") ?? "dev",
  });

  const provider = new BasicTracerProvider({ resource });

  if (exporterKind === "console") {
    provider.addSpanProcessor(
      new BatchSpanProcessor(new ConsoleSpanExporter()),
    );
  } else {
    // Fetch-based OTLP/HTTP exporter — uses Deno's native fetch instead of
    // Node.js http/https modules, which fail TLS in compiled binaries.
    const { FetchOtlpExporter } = await import("./fetch_otlp_exporter.ts");

    const headers: Record<string, string> = {};
    const rawHeaders = Deno.env.get("OTEL_EXPORTER_OTLP_HEADERS");
    if (rawHeaders) {
      for (const pair of rawHeaders.split(",")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
      }
    }

    const exporter = new FetchOtlpExporter({
      url: `${endpoint!.replace(/\/+$/, "")}/v1/traces`,
      headers,
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  }

  // Register as global tracer provider
  provider.register();

  providerRef = provider;
}

/**
 * Flushes pending spans and shuts down the tracer provider.
 * No-op when tracing was not initialized.
 */
export async function shutdownTracing(): Promise<void> {
  if (providerRef) {
    try {
      await providerRef.shutdown();
    } catch {
      // Silently swallow shutdown errors — tracing should never block the CLI.
    }
    providerRef = undefined;

    // Disable the global context manager
    const contextApi = await import("@opentelemetry/api");
    contextApi.context.disable();
  }
}
