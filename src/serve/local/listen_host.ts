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

import { UserError } from "../../domain/errors.ts";

export type ListenHostKind = "loopback" | "wildcard" | "interface";

/** one address from `Deno.networkInterfaces()` */
export interface MachineAddress {
  readonly family: "IPv4" | "IPv6";
  readonly address: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function canonicalIp(raw: string): string | null {
  const v4 = IPV4.exec(raw);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return octets.join(".");
  }
  const bare = raw.replace(/^\[|\]$/g, "");
  if (!bare.includes(":")) return null;
  try {
    return new URL(`http://[${bare}]`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function isV6(address: string): boolean {
  return address.includes(":");
}

function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}

function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.") || /^fe[89ab]/i.test(address);
}

/** an IP address as it goes in a URL authority, IPv6 in brackets */
export function urlHost(address: string): string {
  return isV6(address) ? `[${address}]` : address;
}

/**
 * the address `swamp start` and `swamp dashboard` serve their page on: an IP
 * literal, never a name, so the bind, the probe and the printed URL agree
 */
export class ListenHost {
  static readonly DEFAULT = new ListenHost("127.0.0.1", "loopback");

  private constructor(
    readonly address: string,
    readonly kind: ListenHostKind,
  ) {}

  static parse(raw: string | undefined): ListenHost {
    if (raw === undefined) return ListenHost.DEFAULT;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "localhost") return ListenHost.DEFAULT;
    const address = canonicalIp(trimmed);
    if (address === null) {
      throw new UserError(
        `--host must be an IP address of this machine, e.g. --host 0.0.0.0 to listen on every address, got ${
          JSON.stringify(raw)
        }.`,
      );
    }
    if (address === "0.0.0.0" || address === "::") {
      return new ListenHost(address, "wildcard");
    }
    return new ListenHost(
      address,
      isLoopback(address) ? "loopback" : "interface",
    );
  }

  /** reachable from other machines, so the page warns and adds their names */
  get exposed(): boolean {
    return this.kind !== "loopback";
  }

  /** where another swamp process on this machine reaches the page */
  get probeAddress(): string {
    if (this.address === "0.0.0.0") return "127.0.0.1";
    if (this.address === "::") return "::1";
    return this.address;
  }
}

/** link-local addresses are left out: an IPv6 one needs a zone id in a URL */
export function networkHosts(
  listen: ListenHost,
  machineName: string | null,
  addresses: readonly MachineAddress[],
): string[] {
  if (!listen.exposed) return [];
  if (listen.kind === "interface") return [urlHost(listen.address)];
  const family = isV6(listen.address) ? "IPv6" : "IPv4";
  const hosts: string[] = [];
  const name = machineName?.trim().toLowerCase();
  if (name && name !== "localhost") hosts.push(name);
  for (const { family: addressFamily, address } of addresses) {
    if (addressFamily !== family) continue;
    const canonical = canonicalIp(address);
    if (
      canonical === null || isLoopback(canonical) || isLinkLocal(canonical)
    ) continue;
    const host = urlHost(canonical);
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
