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

export interface ServiceConfig {
  readonly binaryPath: string;
  readonly repoDir: string;
  readonly port: number;
  readonly host: string;
  readonly certFile?: string;
  readonly keyFile?: string;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** replaces serve's arguments; repoDir stays the working directory */
  readonly argv?: readonly string[];
}

/** names one installed service, so two daemons never share a unit or label */
export interface ServiceIdentity {
  readonly unitName: string;
  readonly label: string;
  readonly description: string;
  readonly logName: string;
  /** the command that manages it, for messages */
  readonly command: string;
}

export const SERVE_SERVICE: ServiceIdentity = {
  unitName: "swamp-serve",
  label: "club.swamp.serve",
  description: "Swamp serve daemon",
  logName: "serve",
  command: "swamp serve daemon",
};

export const HUB_SERVICE: ServiceIdentity = {
  unitName: "swamp-hub",
  label: "club.swamp.hub",
  description: "Swamp hub",
  logName: "hub",
  command: "swamp hub daemon",
};
