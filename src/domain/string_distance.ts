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
 * Computes Levenshtein distance between two strings for typo detection.
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Finds the closest match to a key among available keys using Levenshtein distance.
 *
 * @param key - The unknown key to find a match for
 * @param availableKeys - The set of valid keys to search
 * @returns The closest matching key, or undefined if none is within threshold
 */
export function findClosestMatch(
  key: string,
  availableKeys: string[],
): string | undefined {
  if (availableKeys.length === 0) return undefined;

  let closest: string | undefined;
  let minDistance = Infinity;
  const threshold = Math.max(2, Math.floor(key.length / 2));

  for (const available of availableKeys) {
    const distance = levenshteinDistance(
      key.toLowerCase(),
      available.toLowerCase(),
    );
    if (distance < minDistance && distance <= threshold) {
      minDistance = distance;
      closest = available;
    }
  }

  return closest;
}
