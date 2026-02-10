/**
 * Computes a SHA-256 checksum for the given data.
 *
 * @param data - The data to compute the checksum for
 * @returns The hex-encoded checksum
 */
export async function computeChecksum(data: Uint8Array): Promise<string> {
  // Convert Uint8Array to ArrayBuffer to satisfy TypeScript's strict typing
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
