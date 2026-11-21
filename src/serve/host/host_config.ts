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

import { isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import type { ListenerProtocol } from "./forwarding_headers.ts";
import { HOST_CONFIG_FILE, type HostLayout } from "./host_layout.ts";
import { hostedWorkspaceAddress } from "./workspace_path.ts";

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
  "oauth-client": z.object({
    id: z.string().min(1),
    "secret-file": z.string().min(1),
  }).strict().optional(),
}).strict();

export interface HostListen {
  readonly host: string;
  readonly port: number;
  readonly certFile: string | null;
  readonly keyFile: string | null;
}

/** the client every child is started with; the host holds the path, never the secret */
export interface HostOAuthClient {
  readonly id: string;
  readonly secretFile: string;
}

export class HostConfig {
  private constructor(
    readonly layout: HostLayout,
    readonly listen: HostListen,
    readonly address: string,
    readonly root: string | null,
    readonly trustProxy: boolean,
    readonly allowUnauthenticatedBehindProxy: boolean,
    readonly oauthClient: HostOAuthClient | null,
  ) {}

  static parse(text: string, layout: HostLayout): HostConfig {
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
    const dir = resolve(layout.baseDir);
    const stateDir = resolve(layout.stateDir);
    const stateName = `the host's state folder ${stateDir}`;

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
      const refusal = rootPlacementRefusal(
        `root ${yaml.root}`,
        root,
        stateDir,
      );
      if (refusal !== null) {
        throw markErrorPaths(invalid(refusal), [yaml.root]);
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

    const oauthClient = parseOAuthClient(yaml["oauth-client"], {
      dir,
      stateDir,
      stateName,
      root,
    });

    return new HostConfig(
      { ...layout, baseDir: dir, stateDir },
      listen,
      address,
      root,
      trustProxy,
      allowBehindProxy,
      oauthClient,
    );
  }

  /** the wanted, status and lock files */
  get stateDir(): string {
    return this.layout.stateDir;
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
    return hostedWorkspaceAddress(this.address, name);
  }

  /** why `folder`, a root not named in host.yaml, cannot be the root, or null */
  rootRefusal(folder: string): string | null {
    const placement = rootPlacementRefusal(folder, folder, this.stateDir);
    if (placement !== null) return placement;
    const secretFile = this.oauthClient?.secretFile;
    if (secretFile !== undefined && isWithin(folder, secretFile)) {
      return `${folder} holds oauth-client.secret-file ${secretFile}; keep the secret outside every repo the host runs`;
    }
    return null;
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

// a file in a repo can be copied or committed by that repo's own git, sync or team
function parseOAuthClient(
  raw: { id: string; "secret-file": string } | undefined,
  at: {
    readonly dir: string;
    readonly stateDir: string;
    readonly stateName: string;
    readonly root: string | null;
  },
): HostOAuthClient | null {
  if (raw === undefined) return null;
  const { root } = at;
  const given = raw["secret-file"];
  const secretFile = resolve(at.dir, given);
  const holder = isWithin(at.stateDir, secretFile)
    ? at.stateName
    : root !== null && isWithin(root, secretFile)
    ? "the root repo"
    : null;
  if (holder !== null) {
    throw markErrorPaths(
      invalid(
        `oauth-client.secret-file ${given} is inside ${holder}; keep the secret outside every repo the host runs`,
      ),
      [given],
    );
  }
  return { id: raw.id, secretFile };
}

// one rule for an explicit root and the root workspace; `named` is how the message names it
function rootPlacementRefusal(
  named: string,
  root: string,
  stateDir: string,
): string | null {
  const stateName = `the host's state folder ${stateDir}`;
  if (isWithin(stateDir, root)) {
    return `${named} is inside ${stateName}, which holds no repo`;
  }
  if (isWithin(root, stateDir)) {
    return `${named} contains ${stateName}, so its repo would hold the host's wanted and status files`;
  }
  return null;
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

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${SEPARATOR}`));
}

function invalid(reason: string): UserError {
  return new UserError(`Invalid ${HOST_CONFIG_FILE}: ${reason}.`);
}
