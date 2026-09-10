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

import dgram from "node:dgram";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type {
  AuditCategory,
  AuditEvent,
  AuditOutcome,
} from "../../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../../domain/serve_audit/audit_sink.ts";
import {
  matchesSinkFilter,
  type SinkFilterConfig,
} from "../../domain/serve_audit/sink_filter.ts";

const logger = getSwampLogger(["serve", "audit", "syslog-sink"]);

export type SyslogTransport = "tcp" | "tcp+tls" | "udp";

export interface SyslogSinkOptions {
  readonly host: string;
  readonly port: number;
  readonly transport?: SyslogTransport;
  readonly hostname?: string;
  readonly filter?: SinkFilterConfig;
  readonly caCert?: string;
  readonly signal?: AbortSignal;
}

const FACILITY_MAP: Record<AuditCategory, number> = {
  auth: 4,
  access: 4,
  secrets: 4,
  admin: 10,
  execution: 1,
  data: 1,
  system: 3,
};

const SEVERITY_MAP: Record<AuditOutcome, number> = {
  denied: 4,
  failure: 3,
  success: 6,
};

const encoder = new TextEncoder();

function escapeSD(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\]/g, "\\]");
}

function formatRfc5424(
  event: AuditEvent,
  hostname: string,
): string {
  const facility = FACILITY_MAP[event.category] ?? 1;
  const severity = SEVERITY_MAP[event.outcome] ?? 6;
  const priority = facility * 8 + severity;

  const sd = [
    `action="${escapeSD(event.action)}"`,
    `category="${escapeSD(event.category)}"`,
    `outcome="${escapeSD(event.outcome)}"`,
    `principal="${escapeSD(`${event.principalKind}:${event.principalId}`)}"`,
    `resource="${escapeSD(`${event.resourceKind}:${event.resourceName}`)}"`,
  ];

  if (event.decision?.grantId) {
    sd.push(`grantId="${escapeSD(event.decision.grantId)}"`);
  }

  return `<${priority}>1 ${event.timestamp} ${hostname} swamp-serve ${event.instanceId} audit - [swamp ${
    sd.join(" ")
  }]`;
}

export { formatRfc5424 };

export class SyslogSink implements AuditSink {
  readonly name: string;
  readonly durable = false;

  readonly #host: string;
  readonly #port: number;
  readonly #transport: SyslogTransport;
  readonly #hostname: string;
  readonly #filter: SinkFilterConfig;
  readonly #caCert: string | undefined;

  #tcpConn: Deno.TcpConn | Deno.TlsConn | null = null;
  #udpSocket: ReturnType<typeof dgram.createSocket> | null = null;
  #reconnectAttempts = 0;
  #closed = false;
  #connectionFailed = false;
  #circuitBreakerUntil = 0;

  constructor(options: SyslogSinkOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#transport = options.transport ?? "tcp";
    this.#hostname = options.hostname ?? "swamp-serve";
    this.#filter = options.filter ?? {};
    this.#caCert = options.caCert;
    this.name = `syslog:${options.host}:${options.port}`;

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        this.close().catch((error: unknown) => {
          logger.warn("Shutdown close failed: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, { once: true });
    }
  }

  async write(events: readonly AuditEvent[]): Promise<void> {
    if (Date.now() < this.#circuitBreakerUntil) return;
    this.#connectionFailed = false;
    this.#reconnectAttempts = 0;
    for (const event of events) {
      if (this.#connectionFailed) break;
      if (!matchesSinkFilter(event, this.#filter)) continue;
      const message = formatRfc5424(event, this.#hostname);
      await this.#send(message);
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#closed = true;
    if (this.#tcpConn) {
      try {
        this.#tcpConn.close();
      } catch {
        // already closed
      }
      this.#tcpConn = null;
    }
    if (this.#udpSocket) {
      try {
        this.#udpSocket.close();
      } catch {
        // already closed
      }
      this.#udpSocket = null;
    }
    return Promise.resolve();
  }

  async #send(message: string): Promise<void> {
    if (this.#closed) return;

    if (this.#transport === "udp") {
      await this.#sendUdp(message);
      return;
    }

    await this.#sendTcp(message);
  }

  #getUdpSocket(): ReturnType<typeof dgram.createSocket> {
    if (!this.#udpSocket) {
      this.#udpSocket = dgram.createSocket("udp4");
    }
    return this.#udpSocket;
  }

  async #sendUdp(message: string): Promise<void> {
    try {
      const socket = this.#getUdpSocket();
      let data = encoder.encode(message);
      if (data.byteLength > 2048) {
        data = data.subarray(0, 2048);
      }
      await new Promise<void>((resolve, reject) => {
        socket.send(data, this.#port, this.#host, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (error: unknown) {
      logger.warn("Syslog {target} UDP send failed: {error}", {
        target: `${this.#host}:${this.#port}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #sendTcp(message: string): Promise<void> {
    const conn = await this.#getConnection();
    if (!conn) return;

    const msgBytes = encoder.encode(message);
    const header = encoder.encode(`${msgBytes.byteLength} `);
    const framed = new Uint8Array(header.byteLength + msgBytes.byteLength);
    framed.set(header, 0);
    framed.set(msgBytes, header.byteLength);

    try {
      await conn.write(framed);
      this.#reconnectAttempts = 0;
    } catch (error: unknown) {
      logger.warn("Syslog {target} TCP send failed, reconnecting: {error}", {
        target: `${this.#host}:${this.#port}`,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#tcpConn = null;
      this.#connectionFailed = true;
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  }

  async #getConnection(): Promise<Deno.TcpConn | Deno.TlsConn | null> {
    if (this.#tcpConn) return this.#tcpConn;
    if (this.#closed) return null;

    const maxAttempts = 3;
    while (this.#reconnectAttempts < maxAttempts && !this.#closed) {
      try {
        if (this.#transport === "tcp+tls") {
          const options: Deno.ConnectTlsOptions = {
            hostname: this.#host,
            port: this.#port,
          };
          if (this.#caCert) {
            options.caCerts = [this.#caCert];
          }
          this.#tcpConn = await Deno.connectTls(options);
        } else {
          this.#tcpConn = await Deno.connect({
            hostname: this.#host,
            port: this.#port,
          });
        }
        this.#reconnectAttempts = 0;
        if (this.#closed) {
          this.#tcpConn.close();
          this.#tcpConn = null;
          return null;
        }
        return this.#tcpConn;
      } catch (error: unknown) {
        this.#reconnectAttempts++;
        logger.warn(
          "Syslog {target} connection attempt {attempt}/{max} failed: {error}",
          {
            target: `${this.#host}:${this.#port}`,
            attempt: this.#reconnectAttempts,
            max: maxAttempts,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        if (this.#reconnectAttempts < maxAttempts) {
          const delay = 1000 * Math.pow(2, this.#reconnectAttempts - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.#connectionFailed = true;
    this.#circuitBreakerUntil = Date.now() + 60_000;
    logger.warn(
      "Syslog {target} connection failed after {max} attempts, circuit breaker open for 60s",
      { target: `${this.#host}:${this.#port}`, max: maxAttempts },
    );
    return null;
  }
}
