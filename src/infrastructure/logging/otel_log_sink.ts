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

import type { LogRecord, Sink } from "@logtape/logtape";
import type { LogAttributes, LoggerProvider } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { runFileSink } from "./run_file_sink.ts";

// imports nothing from tracing, keeping the dependency one-way (logger pulls
// initLogs from tracing) and avoiding an import cycle; the provider is injected

const LOGGER_NAME = "swamp";

function toSeverityNumber(level: LogRecord["level"]): SeverityNumber {
  switch (level) {
    case "trace":
      return SeverityNumber.TRACE;
    case "debug":
      return SeverityNumber.DEBUG;
    case "info":
      return SeverityNumber.INFO;
    case "warning":
      return SeverityNumber.WARN;
    case "error":
      return SeverityNumber.ERROR;
    case "fatal":
      return SeverityNumber.FATAL;
    default:
      return SeverityNumber.INFO;
  }
}

/**
 * follows the OTel short names (WARN, not warning) so records group with other
 * services' logs in the backend
 */
function toSeverityText(level: LogRecord["level"]): string {
  switch (level) {
    case "trace":
      return "TRACE";
    case "debug":
      return "DEBUG";
    case "info":
      return "INFO";
    case "warning":
      return "WARN";
    case "error":
      return "ERROR";
    case "fatal":
      return "FATAL";
    default:
      return "INFO";
  }
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderBody(message: readonly unknown[]): string {
  return message.map(renderValue).join("");
}

/**
 * OTel attribute values may only be primitives, so objects and arrays are
 * stringified
 */
function toAttributeValue(value: unknown): string | number | boolean {
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return renderValue(value);
}

/**
 * emit takes no context so the SDK stamps the active span ids; body and
 * attributes are redacted, secret numbers or booleans sent as ***, matching run
 * log files since OTLP leaves the process
 */
export function createOtelLogRecordSink(provider: LoggerProvider): Sink {
  const otelLogger = provider.getLogger(LOGGER_NAME);

  return (record: LogRecord) => {
    const attributes: LogAttributes = {
      "logger.name": record.category.join("."),
    };
    for (const [key, value] of Object.entries(record.properties ?? {})) {
      const coerced = toAttributeValue(value);
      attributes[key] = typeof coerced === "string"
        ? runFileSink.redactActive(coerced)
        // a secret delivered as a number or boolean is masked too
        : runFileSink.isActiveSecret(String(coerced))
        ? "***"
        : coerced;
    }

    otelLogger.emit({
      severityNumber: toSeverityNumber(record.level),
      severityText: toSeverityText(record.level),
      body: runFileSink.redactActive(renderBody(record.message)),
      timestamp: record.timestamp,
      attributes,
    });
  };
}
