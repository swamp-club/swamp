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

import type { AppDescriptor } from "./app_descriptor.ts";

export type AppOrigin = "extension" | "source" | "local";

export interface InstalledApp {
  readonly descriptor: AppDescriptor;
  readonly root: string;
  readonly origin: AppOrigin;
  readonly built: boolean;
  /** The extension's version, when it came from one. */
  readonly version?: string;
  /** Set for a running `swamp app dev` server. */
  readonly devUrl?: string;
}

export interface AppCatalogProblem {
  readonly path: string;
  readonly message: string;
}

export interface AppCatalogListing {
  readonly apps: readonly InstalledApp[];
  /** Descriptors or folders that could not be read; one never hides the rest. */
  readonly problems: readonly AppCatalogProblem[];
}

export interface AppCatalog {
  list(): Promise<AppCatalogListing>;
}
