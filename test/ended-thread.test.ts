import { describe, it, expect } from "vitest";
import { isOurEndedThread } from "../src/app.js";

const PARENT = "parent-123";
const OTHER_PARENT = "parent-456";
const BOT = "bot-999";

const base = {
  channelIsThread: true,
  threadParentId: PARENT,
  threadOwnerId: BOT,
  enabledParentChannelIds: new Set([PARENT, OTHER_PARENT]),
  botUserId: BOT,
};

describe("isOurEndedThread (who may we tell 'this session ended'?)", () => {
  it("recognises a bot-created thread under an enabled parent", () => {
    expect(isOurEndedThread(base)).toBe(true);
  });

  it("stays silent in the parent channel itself", () => {
    // Only threads carry sessions; talking here would interrupt normal chat.
    expect(isOurEndedThread({ ...base, channelIsThread: false })).toBe(false);
  });

  it("recognises a bot-created thread under another enabled channel", () => {
    expect(isOurEndedThread({ ...base, threadParentId: OTHER_PARENT })).toBe(true);
  });

  it("stays silent in a thread under a disabled channel", () => {
    expect(isOurEndedThread({ ...base, threadParentId: "some-other-channel" })).toBe(false);
  });

  it("stays silent in a thread a HUMAN created, even under our parent", () => {
    // The operator's own threads are not ours to comment in.
    expect(isOurEndedThread({ ...base, threadOwnerId: "human-1" })).toBe(false);
  });

  it("fails closed when the ownership or parent is unknown", () => {
    // A partial/uncached channel object must not be read as "ours".
    expect(isOurEndedThread({ ...base, threadOwnerId: undefined })).toBe(false);
    expect(isOurEndedThread({ ...base, threadParentId: undefined })).toBe(false);
    expect(isOurEndedThread({ ...base, botUserId: undefined })).toBe(false);
  });
});
