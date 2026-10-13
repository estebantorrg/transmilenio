/**
 * The spellings one destination name is tried under (spec §5.2.4).
 *
 * The troncal live endpoint only answers to the exact name it files a direction
 * under, and the catalog writes "A - B" where the endpoint may know "B", "A" or
 * the whole string. The server's cascade and the app's own lookup both expand a
 * name this way; each used to keep its own copy (spec §1.1 R2).
 */

/** Adds `text` to `candidates`: each half of a hyphenated name (last half first), then the whole. */
export function addUniqueLiveName(candidates, text) {
  if (!text) return;
  const has = (name) => candidates.some((candidate) => candidate.toLowerCase() === name.toLowerCase());

  const parts = text.split(/\s+[-–—]\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 1 ? [...parts].reverse() : parts) {
    if (!has(part)) candidates.push(part);
  }
  if (!has(text)) candidates.push(text);
}
