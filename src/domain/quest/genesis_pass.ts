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
 * mirrors swamp-club's GenesisPassView field-for-field, camelCase as on the
 * wire; that endpoint is the single source of truth for the web profile and
 * this CLI
 */

export type ClaimState = "claimed" | "claimable" | "locked";

export interface GenesisReward {
  readonly kind: string;
  readonly name: string;
  readonly note: string;
  readonly badgeId: string;
  readonly claimState: ClaimState;
  /** Premium lane only: reached by XP but not entitled — render as an offer. */
  readonly offer: boolean;
}

export interface GenesisTier {
  readonly n: number;
  readonly cumXp: number;
  readonly isCapstone: boolean;
  readonly free: GenesisReward;
  readonly premium: GenesisReward;
}

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

export interface GenesisNextTier {
  readonly n: number;
  readonly name: string;
  readonly cumXp: number;
  readonly premiumName: string;
}

export interface GenesisPass {
  readonly campaign: "genesis";
  readonly username: string;
  readonly passXp: number;
  readonly currentTier: number;
  readonly totalTiers: number;
  readonly hasPremium: boolean;
  /** Only the profile owner may claim. */
  readonly canClaim: boolean;
  readonly claimableTier: number | null;
  readonly nextTier: GenesisNextTier | null;
  readonly xpIntoCurrent: number;
  readonly xpForNext: number;
  readonly toNext: number;
  readonly ladderFraction: number;
  readonly tiers: GenesisTier[];
  readonly challenges: GenesisChallenge[];
}
