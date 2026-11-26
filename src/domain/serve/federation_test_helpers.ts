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

import { Fingerprint, type FingerprintProps } from "./fingerprint.ts";

export function sampleFingerprintProps(
  overrides: Partial<FingerprintProps> = {},
): FingerprintProps {
  return {
    swampVersion: "20261125.1629.0",
    platform: "linux",
    arch: "x86_64",
    serveYamlVersion: 2,
    deploymentMode: "durable",
    datastoreKind: "@swamp/s3-datastore",
    datastoreFormat: "v3",
    vaultKinds: ["@swamp/aws-sm-vault"],
    authMode: "token",
    tls: true,
    remoteOnly: false,
    loopbackOnly: false,
    federationRole: "member",
    extensions: [],
    settingsHash: "0".repeat(64),
    workers: { total: 0, byVersion: {}, byLabelKey: {} },
    team: null,
    startedAt: null,
    ready: null,
    ...overrides,
  };
}

export function sampleFingerprint(
  overrides: Partial<FingerprintProps> = {},
): Fingerprint {
  return Fingerprint.create(sampleFingerprintProps(overrides));
}
