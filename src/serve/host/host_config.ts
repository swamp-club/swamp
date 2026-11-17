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

import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import type { ListenerProtocol } from "./forwarding_headers.ts";

export const HOST_CONFIG_FILE = "host.yaml";
export const WORKSPACES_DIR = "workspaces";

// the same set serve's own off-loopback check uses
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

const HostYamlSchema = z.object({
  listen: z.object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(0).max(65_535).optional(),
    "cert-file": z.string().min(1).optional(),
    "key-file": z.string().min(1).optional(),
  }).strict().optional(),
  address: z.string().min(1),
  root: z.string().min(1).optional(),
  "trust-proxy": z.boolean().optional(),
  "allow-unauthenticated-behind-proxy": z.boolean().optional(),
}).strict();

export interface HostListen {
  readonly host: string;
  readonly port: number;
  readonly certFile: string | null;
  readonly keyFile: string | null;
}

/** every path in host.yaml is resolved against the host folder */
export class HostConfig {
  private constructor(
    readonly hostDir: string,
    readonly listen: HostListen,
    readonly address: string,
    readonly root: string | null,
    readonly trustProxy: boolean,
    readonly allowUnauthenticatedBehindProxy: boolean,
  ) {}

  static parse(text: string, hostDir: string): HostConfig {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw invalid(`it is not valid YAML: ${reason}`);
    }
    const parsed = HostYamlSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path.join(".");
      throw invalid(
        field === "" ? issue.message : `${field}: ${issue.message}`,
      );
    }
    const yaml = parsed.data;
    const dir = resolve(hostDir);

    const certFile = yaml.listen?.["cert-file"];
    const keyFile = yaml.listen?.["key-file"];
    if ((certFile === undefined) !== (keyFile === undefined)) {
      throw invalid(
        "listen.cert-file and listen.key-file must be given together",
      );
    }
    const tls = certFile !== undefined;
    const listenHost = yaml.listen?.host ?? "127.0.0.1";
    const offLoopback = !LOOPBACK_HOSTS.has(listenHost);
    if (offLoopback && !tls) {
      throw invalid(
        `listen.host ${listenHost} is off loopback, which requires TLS: set listen.cert-file and listen.key-file, or listen on 127.0.0.1`,
      );
    }
    const listen: HostListen = {
      host: listenHost,
      port: yaml.listen?.port ?? (tls ? 443 : 8080),
      certFile: certFile === undefined ? null : resolve(dir, certFile),
      keyFile: keyFile === undefined ? null : resolve(dir, keyFile),
    };

    const address = parseAddress(yaml.address);

    let root: string | null = null;
    if (yaml.root !== undefined) {
      root = resolve(dir, yaml.root);
      if (isWithin(join(dir, WORKSPACES_DIR), root)) {
        throw markErrorPaths(
          invalid(
            `root ${yaml.root} is inside ${WORKSPACES_DIR}/, where every repo is a workspace`,
          ),
          [yaml.root],
        );
      }
    }

    const trustProxy = yaml["trust-proxy"] ?? false;
    const allowBehindProxy = yaml["allow-unauthenticated-behind-proxy"] ??
      false;
    if (
      allowBehindProxy &&
      (offLoopback || (!trustProxy && isLoopbackName(address)))
    ) {
      throw invalid(
        "allow-unauthenticated-behind-proxy applies only to a host on loopback behind a proxy: one with trust-proxy: true, or whose address is not a loopback name",
      );
    }

    return new HostConfig(
      dir,
      listen,
      address,
      root,
      trustProxy,
      allowBehindProxy,
    );
  }

  get workspacesDir(): string {
    return join(this.hostDir, WORKSPACES_DIR);
  }

  get protocol(): ListenerProtocol {
    return this.listen.certFile === null ? "http" : "https";
  }

  get offLoopback(): boolean {
    return !LOOPBACK_HOSTS.has(this.listen.host);
  }

  /** the name a child trusts in Host and Origin: host, or host:port off the default port */
  get trustedHost(): string {
    return new URL(this.address).host;
  }

  childAddress(name: string): string {
    return `${this.address}/w/${name}`;
  }

  /** why a child in auth mode none may not run behind this host, or null */
  noAuthRefusal(): string | null {
    if (this.offLoopback) {
      return `the host listens off loopback on ${this.listen.host}, so a workspace must use auth mode token or oauth`;
    }
    if (this.allowUnauthenticatedBehindProxy) return null;
    const override =
      "for a proxy that authenticates every caller, set allow-unauthenticated-behind-proxy: true in host.yaml";
    if (this.trustProxy) {
      return `the host is behind a proxy (trust-proxy: true), so a workspace must use auth mode token or oauth; ${override}`;
    }
    // a loopback listener serving a public name has something forwarding to
    // it, and each child trusts that name, so its Host check no longer hides it
    if (!isLoopbackName(this.address)) {
      return `the host's address names ${
        new URL(this.address).hostname
      }, which is not loopback, so something forwards to this host and a workspace must use auth mode token or oauth; ${override}`;
    }
    return null;
  }
}

function parseAddress(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`address ${raw} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid(`address ${raw} must be an http or https URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalid("address must not carry credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw invalid(`address ${raw} must not carry a query or fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function isLoopbackName(address: string): boolean {
  const hostname = new URL(address).hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${SEPARATOR}`));
}

function invalid(reason: string): UserError {
  return new UserError(`Invalid ${HOST_CONFIG_FILE}: ${reason}.`);
}
