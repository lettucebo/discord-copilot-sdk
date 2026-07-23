/**
 * Split text into lossless chunks that each fit within `max` characters, so a
 * long agent message can be streamed across multiple Discord messages without
 * dropping any content. Concatenating the returned chunks reproduces the input
 * exactly.
 *
 * Break preference (to keep chunks readable): the last newline in the window,
 * else the last space, else a hard cut at `max`. The `>= max/2` guard avoids
 * emitting tiny fragments when a boundary sits very early in the window.
 */
export function chunkText(text: string, max = 1900): string[] {
  if (max <= 0) throw new Error("max must be a positive number");
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = findCut(rest, max);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function findCut(s: string, max: number): number {
  const window = s.slice(0, max);
  const half = max / 2;
  const nl = window.lastIndexOf("\n");
  if (nl >= half) return nl + 1; // keep the newline at the end of this chunk
  const sp = window.lastIndexOf(" ");
  if (sp >= half) return sp + 1; // keep the space at the end of this chunk
  return max; // no usable boundary — hard cut
}
