import { sanitizeForCodeBlock, sanitizeForInlineCode, sanitizeForSpoiler } from "./text-safety.js";
import type { TimelineItem } from "./turn-render.js";

const MAX_REASONING_CHARS = 1_200;
const MAX_TABLE_ROWS = 20;
const MAX_TABLE_WIDTH = 110;
const MAX_TABLE_COLUMN_WIDTH = 32;

/** Format the ordered timeline as independent display items for boundary-safe chunking. */
export function formatTimelineItems(items: readonly TimelineItem[]): string[] {
  return items.map(formatItem).filter((item): item is string => item.length > 0);
}

/** Format the ordered timeline into Discord markdown with predictable two-line spacing. */
export function formatTimeline(items: readonly TimelineItem[]): string {
  return formatTimelineItems(items).join("\n\n");
}

function formatItem(item: TimelineItem): string {
  switch (item.kind) {
    case "text":
      return normalizeMarkdown(item.text, item.open);
    case "reasoning":
      return formatReasoning(item.text);
    case "intent":
      return formatReasoning(item.text);
    case "tool":
      return formatTool(item);
    case "audit":
      return `-# ${item.display}${item.count > 1 ? ` ×${item.count}` : ""}`;
    case "notice":
      return `-# ℹ ${normalizeMarkdown(item.text)}`;
    case "todos":
      return `-# 📋 Progress\n${normalizeMarkdown(item.text)}`;
  }
}

function formatReasoning(text: string): string {
  const safe = sanitizeForSpoiler(text);
  const capped = safe.length > MAX_REASONING_CHARS ? safe.slice(0, MAX_REASONING_CHARS) + "…" : safe;
  return capped ? `-# 💭 Thinking\n||${capped}||` : "";
}

function formatTool(item: Extract<TimelineItem, { kind: "tool" }>): string {
  const name = sanitizeForInlineCode(item.name || "tool", 80);
  const target = toolTarget(item);
  const status = item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : "…";
  const error = item.error ? ` — ${sanitizeForInlineCode(item.error, 120)}` : "";
  return `-# ⚙ \`${name}\`${target ? ` \`${target}\`` : ""} ${status}${error}`;
}

function toolTarget(item: Extract<TimelineItem, { kind: "tool" }>): string | undefined {
  const path = item.possiblePaths?.[0];
  if (path) return sanitizeForInlineCode(path, 200);
  for (const key of ["command", "path", "url", "query", "pattern"]) {
    const value = item.arguments?.[key];
    if (typeof value === "string" && value.trim()) return sanitizeForInlineCode(value, 200);
  }
  return undefined;
}

/**
 * Discord does not support GFM tables. Convert only well-formed table runs and
 * leave all other markdown untouched, including text inside fenced code blocks.
 */
function normalizeMarkdown(text: string, streaming = false): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inFence = false;
  let outsideBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      outsideBlank = false;
      output.push(line);
      continue;
    }
    if (!inFence) {
      if (!line) {
        if (outsideBlank) continue;
        outsideBlank = true;
      } else {
        outsideBlank = false;
      }
      const header = parseTableRow(line);
      const separator = parseTableRow(lines[i + 1] ?? "");
      if (header && separator && isSeparator(separator) && header.length === separator.length) {
        const rows = [header];
        let end = i + 2;
        for (; end < lines.length; end++) {
          const row = parseTableRow(lines[end]!);
          if (!row || row.length !== header.length) break;
          rows.push(row);
        }
        output.push(formatTable(rows, streaming));
        i = end - 1;
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function parseTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return undefined;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => cell.length > 0) ? cells : undefined;
}

function isSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function formatTable(rows: string[][], streaming: boolean): string {
  if (!streaming) return formatFinalTable(rows);
  const columnWidth = Math.min(
    MAX_TABLE_COLUMN_WIDTH,
    Math.floor((MAX_TABLE_WIDTH - Math.max(0, rows[0]!.length - 1) * 2) / rows[0]!.length)
  );
  if (rows.length - 1 > MAX_TABLE_ROWS || columnWidth < 4) return tableBullets(rows);
  const widths = rows[0]!.map(() => columnWidth);

  const body = rows
    .map((row) =>
      row
        .map((cell, column) => padDisplay(truncateDisplay(cell, widths[column]!), widths[column]!))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
  return `\`\`\`text\n${sanitizeForCodeBlock(body)}\n\`\`\``;
}

function formatFinalTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => displayWidth(row[column]!))));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2;
  if (rows.length - 1 > MAX_TABLE_ROWS || totalWidth > MAX_TABLE_WIDTH) return tableBullets(rows);
  const body = rows
    .map((row) => row.map((cell, column) => padDisplay(cell, widths[column]!)).join("  ").trimEnd())
    .join("\n");
  return `\`\`\`text\n${sanitizeForCodeBlock(body)}\n\`\`\``;
}

function tableBullets(rows: string[][]): string {
  const [headers, ...data] = rows;
  return data
    .map((row) => `- ${row.map((cell, index) => `**${headers![index]!}**: ${cell}`).join(" · ")}`)
    .join("\n");
}

function displayWidth(value: string): number {
  return Array.from(value).reduce((width, char) => width + (isWide(char) ? 2 : 1), 0);
}

function padDisplay(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

function truncateDisplay(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  let output = "";
  let used = 0;
  for (const char of Array.from(value)) {
    const next = displayWidth(char);
    if (used + next > width - 1) break;
    output += char;
    used += next;
  }
  return output + "…";
}

function isWide(char: string): boolean {
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(
    char
  );
}
