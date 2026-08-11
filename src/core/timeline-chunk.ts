import { chunkText } from "./chunk.js";

/** Pack pre-formatted timeline items greedily, keeping completed prefixes stable. */
export function chunkTimeline(items: readonly string[], max = 1_900): string[] {
  if (max <= 0) throw new Error("max must be a positive number");
  const chunks: string[] = [];
  let tail = "";

  for (const item of items) {
    if (!item) continue;
    const parts = splitItem(item, max);
    if (parts.length === 1) {
      const part = parts[0]!;
      const combined = tail ? `${tail}\n\n${part}` : part;
      if (combined.length <= max) {
        tail = combined;
      } else {
        if (tail) chunks.push(tail);
        tail = part;
      }
      continue;
    }

    if (tail) chunks.push(tail);
    chunks.push(...parts.slice(0, -1));
    tail = parts[parts.length - 1]!;
  }

  if (tail) chunks.push(tail);
  return chunks;
}

function splitItem(item: string, max: number): string[] {
  if (item.length <= max) return [item];
  const spoiler = splitSpoiler(item, max);
  if (spoiler) return spoiler;
  return item.includes("```") ? splitFenced(item, max) : chunkText(item, max);
}

/** Each Discord message must contain a complete spoiler marker pair. */
function splitSpoiler(item: string, max: number): string[] | undefined {
  const match = /^(.*?\n\|\|)([\s\S]*)(\|\|)$/.exec(item);
  if (!match) return undefined;
  const [, open, content, close] = match;
  const capacity = max - open!.length - close!.length;
  if (capacity <= 0) throw new Error("max is too small to contain a spoiler wrapper");
  return chunkText(content!, capacity).map((part) => open! + part + close!);
}

/**
 * Splits a fenced item line-by-line. At every boundary inside a code block, the
 * preceding chunk closes the fence and the following chunk reopens the same
 * fence. Discord parses each message independently, so this is required for a
 * table that is larger than one message.
 */
function splitFenced(item: string, max: number): string[] {
  const lines = item.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  let openFence: string | undefined;

  const flush = (): void => {
    if (!current) return;
    chunks.push(openFence ? closeFence(current) : current);
    current = openFence ?? "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const closesFence = openFence !== undefined && trimmed.startsWith("```");
    const opensFence = openFence === undefined && trimmed.startsWith("```");
    const reserve = closesFence ? 0 : openFence !== undefined || opensFence ? 4 : 0;

    if (current && current.length + line.length + reserve > max) flush();
    if (current.length + line.length + reserve > max) {
      // An unbroken source line can still exceed the limit. Reserve closing
      // fence space, then keep emitting independently balanced fragments.
      const capacity = max - current.length - reserve;
      if (capacity <= 0) throw new Error("max is too small to contain a fenced item");
      const fragments = chunkText(line, capacity);
      for (let i = 0; i < fragments.length; i++) {
        current += fragments[i]!;
        if (i < fragments.length - 1) flush();
      }
    } else {
      current += line;
    }

    if (opensFence) {
      openFence = line.endsWith("\n") ? line : `${line}\n`;
    } else if (closesFence) {
      openFence = undefined;
    }
  }

  if (current) chunks.push(openFence ? closeFence(current) : current);
  return chunks;
}

function closeFence(content: string): string {
  return content.endsWith("\n") ? `${content}\`\`\`` : `${content}\n\`\`\``;
}
