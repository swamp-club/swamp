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

/**
 * The `swamp quest` linear-pass view — the read model returned by swamp-club's
 * `GET /api/u/:username/genesis` endpoint. This mirrors swamp-club's
 * `GenesisPassView` (lib/app/views/genesis-pass-view.ts) field-for-field, since
 * that endpoint is the single source of truth both the web profile and this CLI
 * render from. Field names are camelCase to match the wire format verbatim.
 */

/** Claim state of one tier reward in a lane. */
export type ClaimState = "claimed" | "claimable" | "locked";

/** A single lane reward (free or premium) at a tier. */
export interface GenesisReward {
  readonly kind: string;
  readonly name: string;
  readonly note: string;
  readonly badgeId: string;
  readonly claimState: ClaimState;
  /** Premium lane only: reached by XP but not entitled — render as an offer. */
  readonly offer: boolean;
}

/** One rung on the 15-tier ladder, with both lanes. */
export interface GenesisTier {
  readonly n: number;
  readonly cumXp: number;
  readonly isCapstone: boolean;
  readonly free: GenesisReward;
  readonly premium: GenesisReward;
}

/** A challenge (the XP "spike" source), with live progress. */
export interface GenesisChallenge {
  readonly id: string;
  readonly name: string;
  readonly verb: string;
  readonly xp: number;
  readonly kind: "first" | "counter";
  readonly target: number | null;
  readonly bridge: boolean;
  readonly category: {
    readonly key: string;
    readonly label: string;
    readonly color: string;
  };
  readonly progress: number;
  readonly done: boolean;
}

/** A single event in the display-only XP heartbeat stream. */
export interface GenesisHeartbeat {
  readonly kind: "drip" | "spike";
  readonly amount: number;
  readonly label: string;
  readonly at: string;
}

/** Summary of the next tier above the operative's current position. */
export interface GenesisNextTier {
  readonly n: number;
  readonly name: string;
  readonly cumXp: number;
  readonly premiumName: string;
}

/**
 * The full linear-pass read model for one operative's Genesis campaign.
 * A pure projection — no invariants, no writes.
 */
export interface GenesisPass {
  readonly campaign: "genesis";
  readonly username: string;
  readonly passXp: number;
  readonly currentTier: number;
  readonly totalTiers: number;
  readonly hasPremium: boolean;
  /** Only the profile owner may claim. */
  readonly canClaim: boolean;
  /** First free-lane tier awaiting a claim (the centerpiece), or null. */
  readonly claimableTier: number | null;
  readonly nextTier: GenesisNextTier | null;
  readonly xpIntoCurrent: number;
  readonly xpForNext: number;
  readonly toNext: number;
  readonly ladderFraction: number;
  readonly tiers: GenesisTier[];
  readonly challenges: GenesisChallenge[];
  readonly heartbeat: GenesisHeartbeat[];
}
