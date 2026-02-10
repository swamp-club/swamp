/**
 * CalVer version string in the format YYYY.MM.DD.MICRO.
 *
 * Value object — equality by value.
 *
 * The micro counter allows multiple version bumps per day and resets
 * for each new date.  Comparison splits on `.`, compares the first
 * three segments as zero-padded strings, and the fourth as a number.
 */
export class CalVer {
  private static readonly PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

  private constructor(readonly value: string) {}

  /**
   * Creates a CalVer instance after validating the format.
   *
   * @throws Error if the version string is not valid CalVer
   */
  static create(version: string): CalVer {
    if (!CalVer.isValid(version)) {
      throw new Error(
        `Invalid CalVer version: "${version}". Expected format YYYY.MM.DD.MICRO (e.g., "2025.01.15.1")`,
      );
    }
    return new CalVer(version);
  }

  /**
   * Checks whether a string is a valid CalVer version.
   *
   * Validates both format (YYYY.MM.DD.MICRO) and semantic date
   * ranges (month 01–12, day 01–31).
   */
  static isValid(version: string): boolean {
    if (!CalVer.PATTERN.test(version)) return false;
    const parts = version.split(".");
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  /**
   * Compares two CalVer values.
   *
   * @returns -1 if a < b, 0 if equal, 1 if a > b
   */
  static compare(a: CalVer, b: CalVer): -1 | 0 | 1 {
    const aParts = a.value.split(".");
    const bParts = b.value.split(".");

    // Compare first three segments as strings (zero-padded)
    for (let i = 0; i < 3; i++) {
      if (aParts[i] < bParts[i]) return -1;
      if (aParts[i] > bParts[i]) return 1;
    }

    // Compare micro segment as numbers
    const aMicro = Number(aParts[3]);
    const bMicro = Number(bParts[3]);
    if (aMicro < bMicro) return -1;
    if (aMicro > bMicro) return 1;

    return 0;
  }

  /**
   * Returns the raw version string.
   */
  toString(): string {
    return this.value;
  }

  /**
   * Value equality.
   */
  equals(other: CalVer): boolean {
    return this.value === other.value;
  }
}
