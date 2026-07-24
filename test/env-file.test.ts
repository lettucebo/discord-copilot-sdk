import { describe, it, expect } from "vitest";
import { parseEnv } from "node:util";
import { mergeEnv, serializeLine, detectEol, parseLines } from "../scripts/lib/env-file.mjs";

describe("serializeLine → round-trips through Node parseEnv", () => {
  const roundtrip = (key, value) => parseEnv(serializeLine(key, value))[key];

  it("simple, spaces, #, quotes, paths, unicode all round-trip", () => {
    for (const v of [
      "simple",
      "has space",
      "with # hash",
      "trailing   ", // trailing whitespace must be preserved (→ quoted)
      "C:\\Program Files\\repo",
      "it's",
      "123456789012345678",
      "MT1abc.def-ghi_jkl",
      "long_context",
      "繁體中文路徑",
      "",
    ]) {
      expect(roundtrip("K", v)).toBe(v);
    }
  });

  it("quotes exactly the values that need it", () => {
    expect(serializeLine("K", "simple")).toBe("K=simple");
    expect(serializeLine("K", "")).toBe("K=");
    expect(serializeLine("K", "a b")).toBe('K="a b"');
    expect(serializeLine("K", "a#b")).toBe('K="a#b"');
    expect(serializeLine("K", "C:\\x y")).toBe('K="C:\\x y"');
  });

  it("rejects values .env cannot represent (embedded quote / newline)", () => {
    expect(() => serializeLine("K", 'a"b')).toThrow(/double-quote/);
    expect(() => serializeLine("K", "a\nb")).toThrow(/newline/);
  });
});

describe("mergeEnv", () => {
  it("updates only managed keys and preserves comments, order, and unmanaged keys", () => {
    const src = [
      "# header comment",
      "DISCORD_BOT_TOKEN=",
      "DISCORD_GUILD_ID=111",
      "",
      "# keep me",
      "UNMANAGED=leave-alone",
      "",
    ].join("\n");
    const out = mergeEnv(src, { DISCORD_BOT_TOKEN: "secret.tok", DISCORD_GUILD_ID: "222" });
    const parsed = parseEnv(out);
    expect(parsed.DISCORD_BOT_TOKEN).toBe("secret.tok");
    expect(parsed.DISCORD_GUILD_ID).toBe("222");
    expect(parsed.UNMANAGED).toBe("leave-alone");
    expect(out).toContain("# header comment");
    expect(out).toContain("# keep me");
    // order preserved: token line still before guild line
    expect(out.indexOf("DISCORD_BOT_TOKEN")).toBeLessThan(out.indexOf("DISCORD_GUILD_ID"));
  });

  it("appends keys that are absent", () => {
    const out = mergeEnv("EXISTING=1\n", { NEWKEY: "v" });
    const parsed = parseEnv(out);
    expect(parsed.EXISTING).toBe("1");
    expect(parsed.NEWKEY).toBe("v");
  });

  it("updates the FIRST occurrence of a duplicated key in place", () => {
    const out = mergeEnv("K=old\nK=older\n", { K: "new" });
    // first line rewritten; the merge changes only the first occurrence
    expect(out.split(/\r?\n/)[0]).toBe("K=new");
  });

  it("preserves CRLF when the source uses CRLF", () => {
    const src = "A=1\r\nB=2\r\n";
    const out = mergeEnv(src, { A: "9" });
    expect(detectEol(out)).toBe("\r\n");
    expect(out).toBe("A=9\r\nB=2\r\n");
  });

  it("preserves LF when the source uses LF", () => {
    const out = mergeEnv("A=1\nB=2\n", { A: "9" });
    expect(out).toBe("A=9\nB=2\n");
  });

  it("skips undefined/null updates (does not write them)", () => {
    const out = mergeEnv("A=1\n", { A: "2", B: undefined, C: null });
    const parsed = parseEnv(out);
    expect(parsed.A).toBe("2");
    expect("B" in parsed).toBe(false);
    expect("C" in parsed).toBe(false);
  });

  it("works from an empty file", () => {
    const out = mergeEnv("", { A: "1" });
    expect(parseEnv(out).A).toBe("1");
  });

  it("does not treat a commented key as managed", () => {
    const out = mergeEnv("# DISCORD_GUILD_ID=commented\n", { DISCORD_GUILD_ID: "222" });
    // the comment stays; the real key is appended
    expect(out).toContain("# DISCORD_GUILD_ID=commented");
    expect(parseEnv(out).DISCORD_GUILD_ID).toBe("222");
  });
});

describe("parseLines", () => {
  it("classifies kv vs other and keeps raw text", () => {
    const lines = parseLines("# c\nA=1\n\nexport B=2");
    expect(lines[0]).toEqual({ kind: "other", raw: "# c" });
    expect(lines[1]).toEqual({ kind: "kv", key: "A", raw: "A=1" });
    expect(lines[2]).toEqual({ kind: "other", raw: "" });
    expect(lines[3]).toEqual({ kind: "kv", key: "B", raw: "export B=2" });
  });
});
