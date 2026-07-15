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

// This module is a LogTape sink — a logging concern — so it lives in the
// logging module alongside run_file_sink.ts (which it uses for redaction) and
// receives the OTel LoggerProvider by injection. It imports nothing from
// src/infrastructure/tracing, keeping the dependency one-way (logger.ts pulls
// initLogs from tracing; tracing never pulls logging) and avoiding an import
// cycle.

/** Instrumentation scope name for swamp's log records. */
const LOGGER_NAME = "swamp";

/** Maps a LogTape level to the OTel {@link SeverityNumber}. */
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

/** Renders a single non-string message part into a readable string. */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Renders a LogTape message (an array of alternating literal strings and
 * interpolated values) into a single human-readable body string. Non-string
 * parts are rendered via {@link renderValue} so structured values never collapse
 * to `[object Object]`.
 */
function renderBody(message: readonly unknown[]): string {
  return message.map(renderValue).join("");
}

/**
 * Coerces a LogTape property value into an OTel-attribute-safe value. OTel
 * attribute values may only be primitives (or arrays of primitives); objects
 * and arrays are stringified.
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
 * Creates a LogTape {@link Sink} that forwards each log record to the OTel
 * `logs` signal via the supplied {@link LoggerProvider}.
 *
 * - **Correlation** is automatic: `emit()` is called with no explicit context,
 *   so the OTel SDK stamps the active span's `trace_id`/`span_id` onto the
 *   record from `context.active()` at emit time.
 * - **Redaction**: the rendered body and every string attribute value pass
 *   through {@link runFileSink.redactActive}, so secrets from the active run are
 *   scrubbed before the record leaves the process — parity with the persisted
 *   per-run log files, which matters because OTLP export is a new external
 *   egress to a third-party collector.
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
        : coerced;
    }

    otelLogger.emit({
      severityNumber: toSeverityNumber(record.level),
      severityText: record.level.toUpperCase(),
      body: runFileSink.redactActive(renderBody(record.message)),
      timestamp: record.timestamp,
      attributes,
    });
  };
}
