const RESET_SGR = "\u001b[0m";
const SGR_PATTERN = /\u001b\[[0-9;]*m/uy;
const MARK_PATTERN = /\p{Mark}/u;
const WIDE_PATTERN = /(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000\uFF01-\uFF60\uFFE0-\uFFE6])/u;

function tokenize(text) {
  const tokens = [];

  for (let index = 0; index < text.length; ) {
    SGR_PATTERN.lastIndex = index;
    const match = SGR_PATTERN.exec(text);
    if (match && match.index === index) {
      tokens.push({
        type: "sgr",
        value: match[0],
        resets: isResetSgr(match[0]),
      });
      index += match[0].length;
      continue;
    }

    const codePoint = text.codePointAt(index);
    const value = String.fromCodePoint(codePoint);
    tokens.push({
      type: "text",
      value,
      width: codePointWidth(codePoint, value),
    });
    index += value.length;
  }

  return tokens;
}

function isResetSgr(sequence) {
  const body = sequence.slice(2, -1);
  return body === "" || body.split(";").every((part) => part === "" || part === "0");
}

function codePointWidth(codePoint, char) {
  if (MARK_PATTERN.test(char) || isVariationSelector(codePoint)) return 0;
  if (WIDE_PATTERN.test(char)) return 2;
  return 1;
}

function isVariationSelector(codePoint) {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function appendAnsiSafe(text, state) {
  for (const token of tokenize(text)) {
    state.output += token.value;
    if (token.type === "sgr") state.activeSgr = !token.resets;
  }
}

function assertSummaryWidth(width) {
  if (!Number.isInteger(width) || width < 1) throw new TypeError("width must be an integer at least 1");
}

function assertSummaryRow(row) {
  if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string") {
    throw new TypeError("rows must contain [key, value] string pairs");
  }
}

export function displayWidth(text) {
  let width = 0;

  for (const token of tokenize(String(text))) {
    if (token.type === "text") width += token.width;
  }

  return width;
}

export function truncateDisplayWidth(text, maxWidth, suffix = "…") {
  const source = String(text);
  const limit = Number.isFinite(maxWidth) ? Math.floor(maxWidth) : 0;
  if (limit <= 0) return "";

  if (displayWidth(source) <= limit) return source;

  const suffixText = String(suffix);
  const suffixWidth = displayWidth(suffixText);
  const trailing = suffixWidth <= limit ? suffixText : "";
  const availableWidth = limit - displayWidth(trailing);
  const state = { output: "", activeSgr: false };
  let usedWidth = 0;

  for (const token of tokenize(source)) {
    if (token.type === "sgr") {
      state.output += token.value;
      state.activeSgr = !token.resets;
      continue;
    }

    if (usedWidth + token.width > availableWidth) break;
    state.output += token.value;
    usedWidth += token.width;
  }

  if (trailing) appendAnsiSafe(trailing, state);
  if (state.activeSgr) state.output += RESET_SGR;
  return state.output;
}

export function formatStage(current, total, title) {
  return `[${current}/${total}] ${title}`;
}

export function formatSection(title) {
  return `\n${title}`;
}

export function formatKeyValue(key, value, keyWidth = 16) {
  return `${key}${" ".repeat(Math.max(0, keyWidth - displayWidth(key)))}  ${value}`;
}

export function formatSummary(rows, width = 60) {
  assertSummaryWidth(width);
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");

  const body = rows.map((row) => {
    assertSummaryRow(row);
    return formatKeyValue(row[0], row[1]);
  });

  const boundary = "-".repeat(width);
  return [boundary, ...body, boundary].join("\n");
}

export function supportsDynamicProgress({ isTTY, noColor }) {
  return isTTY === true && noColor !== true;
}

export function noColorRequested(env) {
  return Object.hasOwn(env, "NO_COLOR");
}

export function supportsColor({ isTTY, env }) {
  return isTTY === true && !noColorRequested(env);
}
