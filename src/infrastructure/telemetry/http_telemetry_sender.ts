import type { TelemetrySender } from "../../domain/telemetry/telemetry_sender.ts";
import type { TelemetryEntry } from "../../domain/telemetry/telemetry_entry.ts";

/**
 * HTTP adapter implementing TelemetrySender.
 * Sends telemetry events to a remote /ingest endpoint.
 */
export class HttpTelemetrySender implements TelemetrySender {
  constructor(private readonly endpointUrl: string) {}

  async sendBatch(
    entries: TelemetryEntry[],
    distinctId: string,
  ): Promise<boolean> {
    const events = entries.map((entry) => ({
      event: "cli_invocation",
      distinct_id: distinctId,
      properties: entry.toData(),
    }));

    const body = events.length === 1
      ? JSON.stringify(events[0])
      : JSON.stringify({ events });

    try {
      const response = await fetch(`${this.endpointUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      // Consume the response body to prevent resource leaks
      await response.body?.cancel();
      return response.status === 202;
    } catch {
      return false;
    }
  }
}
