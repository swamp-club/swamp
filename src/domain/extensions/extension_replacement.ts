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

import { CalVer } from "../models/calver.ts";
import { ReleaseChannel } from "./release_channel.ts";

/**
 * One side of a replacement: a version and the two channels it relates to.
 *
 * `channel` is the channel the install follows — what the lockfile records
 * and what `extension update` and `extension outdated` look for newer
 * versions on. `publishedChannel` is the channel the registry lists the
 * version on. They differ when an exact version is pulled from another
 * channel, or when the version was promoted after it was pulled. Either is
 * null when it is not known.
 */
export interface ExtensionIdentity {
  readonly version: string;
  readonly channel: string | null;
  readonly publishedChannel: string | null;
}

/** How the incoming version relates to the installed one. */
export type ReplacementChange = "upgrade" | "downgrade" | "same" | "unknown";

/**
 * What an install is about to replace: the extension's current install and
 * the incoming version. A value object: it is never stored, and `change` and
 * `channelChanged` are derived from the two sides.
 */
export class ExtensionReplacement {
  private constructor(
    readonly name: string,
    /** The installed identity, or null when it cannot be determined. */
    readonly current: ExtensionIdentity | null,
    readonly incoming: ExtensionIdentity,
    readonly change: ReplacementChange,
    /**
     * True when both published channels are known and differ, so a pull
     * from stable to beta reads as a channel change.
     */
    readonly channelChanged: boolean,
  ) {}

  static create(input: {
    name: string;
    current: ExtensionIdentity | null;
    incoming: ExtensionIdentity;
  }): ExtensionReplacement {
    // An installed version read from the lockfile or a manifest is
    // repo-controlled; one that is not CalVer is reported as unknown
    // rather than shown.
    const current = input.current && CalVer.isValid(input.current.version)
      ? normalize(input.current)
      : null;
    const incoming = normalize(input.incoming);
    return new ExtensionReplacement(
      input.name,
      current,
      incoming,
      compareVersions(current?.version ?? null, incoming.version),
      current !== null &&
        current.publishedChannel !== null &&
        incoming.publishedChannel !== null &&
        current.publishedChannel !== incoming.publishedChannel,
    );
  }
}

/** Drops a channel that is not a release channel name: it is never shown. */
function normalize(identity: ExtensionIdentity): ExtensionIdentity {
  return {
    version: identity.version,
    channel: validChannel(identity.channel),
    publishedChannel: validChannel(identity.publishedChannel),
  };
}

function validChannel(channel: string | null): string | null {
  return channel !== null && ReleaseChannel.isValid(channel) ? channel : null;
}

function compareVersions(
  current: string | null,
  incoming: string,
): ReplacementChange {
  if (current === null) return "unknown";
  if (current === incoming) return "same";
  if (!CalVer.isValid(current) || !CalVer.isValid(incoming)) return "unknown";
  switch (CalVer.compare(CalVer.create(current), CalVer.create(incoming))) {
    case -1:
      return "upgrade";
    case 1:
      return "downgrade";
    default:
      return "same";
  }
}
