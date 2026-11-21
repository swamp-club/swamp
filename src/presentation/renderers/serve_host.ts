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

import type { OutputMode } from "../output/output.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "host"]);

export interface ServeHostListening {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly address: string;
  readonly root: boolean;
  /** the root workspace's name; null when host.yaml names the root, or there is none */
  readonly rootWorkspace: string | null;
  readonly workspaces: number;
}

export interface ServeHostRootWorkspace {
  readonly name: string;
  readonly folder: string;
  readonly created: boolean;
  /** the serve.yaml its auth comes from */
  readonly serveConfig: string;
  /** an earlier root workspace's folder, left on disk when a new one replaced it */
  readonly leftFolder: string | null;
}

export interface ServeHostChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface ServeHostCreated {
  readonly file: string;
  /** the root workspace the host uses, since the created file names no root */
  readonly rootWorkspace: string;
}

export interface ServeHostRenderer {
  created(event: ServeHostCreated): void;
  rootWorkspace(event: ServeHostRootWorkspace): void;
  listening(event: ServeHostListening): void;
  workspacesChanged(change: ServeHostChange): void;
  stopped(): void;
}

class LogServeHostRenderer implements ServeHostRenderer {
  created(event: ServeHostCreated): void {
    logger.info(
      "Created {file}, which listens on 127.0.0.1:8080 only. It names no root, the repo that swamp serve workspace commands talk to and that issues sign-in codes, so the host uses its root workspace {rootWorkspace}, an ordinary workspace it makes on its first start; to use a repo of your own, set root: to its folder there",
      { file: event.file, rootWorkspace: event.rootWorkspace },
    );
  }

  rootWorkspace(event: ServeHostRootWorkspace): void {
    // the host never resolves the root's auth, so the caveat is stated whatever it is
    const properties = {
      name: event.name,
      folder: event.folder,
      serveConfig: event.serveConfig,
    };
    if (event.created) {
      logger.warn(
        "Created root workspace {name} at {folder}. It runs with serve's default auth until {serveConfig} sets auth.mode; while that default is none, anyone on this machine can create, resume and delete workspaces through it, and run code as this user",
        properties,
      );
    } else {
      logger.info(
        "Starting root workspace {name} from {folder}, with the auth {serveConfig} sets, or serve's default; while that is none, anyone on this machine can create, resume and delete workspaces through it",
        properties,
      );
    }
    if (event.leftFolder !== null) {
      logger.warn(
        "The earlier root workspace's folder {leftFolder} is no longer registered and is left on disk; import or delete it",
        { leftFolder: event.leftFolder },
      );
    }
  }

  listening(event: ServeHostListening): void {
    const properties = {
      url: event.url,
      address: event.address,
      workspaces: event.workspaces,
    };
    if (event.rootWorkspace !== null) {
      logger.info(
        "Serve host listening on {url} for {address}, with root workspace {rootWorkspace} and {workspaces} workspace(s)",
        { ...properties, rootWorkspace: event.rootWorkspace },
      );
    } else if (event.root) {
      logger.info(
        "Serve host listening on {url} for {address}, with a root and {workspaces} workspace(s)",
        properties,
      );
    } else {
      logger.info(
        "Serve host listening on {url} for {address}, with {workspaces} workspace(s) and no root",
        properties,
      );
    }
  }

  workspacesChanged(change: ServeHostChange): void {
    for (const name of change.added) {
      logger.info("Workspace {name} added", { name });
    }
    for (const name of change.removed) {
      logger.info("Workspace {name} removed", { name });
    }
  }

  stopped(): void {
    logger.info("Serve host stopped");
  }
}

class JsonServeHostRenderer implements ServeHostRenderer {
  created(event: ServeHostCreated): void {
    writeOutput(JSON.stringify({ status: "created", ...event }));
  }

  rootWorkspace(event: ServeHostRootWorkspace): void {
    writeOutput(JSON.stringify({ status: "root_workspace", ...event }));
  }

  listening(event: ServeHostListening): void {
    writeOutput(JSON.stringify({ status: "listening", ...event }));
  }

  workspacesChanged(change: ServeHostChange): void {
    writeOutput(JSON.stringify({ status: "workspaces", ...change }));
  }

  stopped(): void {
    writeOutput(JSON.stringify({ status: "stopped" }));
  }
}

export function createServeHostRenderer(mode: OutputMode): ServeHostRenderer {
  switch (mode) {
    case "json":
      return new JsonServeHostRenderer();
    case "log":
      return new LogServeHostRenderer();
  }
}
