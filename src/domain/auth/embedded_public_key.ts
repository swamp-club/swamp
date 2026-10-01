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

// Fallback Ed25519 public key for verifying proofs when no cached key
// matches, chiefly SWAMP_SIGNIN_TOKEN, which carries no public key. It is
// swamp-club.com's production signing key (kid 6aab0d1b1c656c22adc781d5),
// as returned in /api/whoami's publicKeys.
//
// On a planned rotation, replace it here in a release before the old key
// leaves the whoami response (the grace period is 30 days). On an emergency
// rotation, every proof signed with the old key stops verifying at once:
// interactive users re-verify on their next run, and CI signin tokens need
// a CLI release carrying the new key plus newly issued tokens.
export const EMBEDDED_PUBLIC_KEY: string | undefined =
  "rIXC70V_y64Se9pDjifRLMBWMhOmsa5z3mMCyCZXKns";
