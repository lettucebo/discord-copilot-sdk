import { describe, it, expect } from "vitest";
import { sendUnlessAborted } from "../src/core/turn-gate.js";

describe("sendUnlessAborted", () => {
  it("does NOT send when the signal aborts during prepare (/stop-during-download)", async () => {
    const ac = new AbortController();
    let sent = false;
    const outcome = await sendUnlessAborted(
      ac.signal,
      async () => {
        ac.abort(); // e.g. /stop fired while the image was downloading
        return "payload";
      },
      async () => {
        sent = true;
      }
    );
    expect(outcome).toBe("aborted");
    expect(sent).toBe(false); // the actor was never invoked
  });

  it("sends when the signal is not aborted", async () => {
    const ac = new AbortController();
    let received: string | undefined;
    const outcome = await sendUnlessAborted(
      ac.signal,
      async () => "payload",
      async (p) => {
        received = p;
      }
    );
    expect(outcome).toBe("sent");
    expect(received).toBe("payload");
  });

  it("does not send when already aborted before prepare resolves", async () => {
    const ac = new AbortController();
    ac.abort();
    let sent = false;
    const outcome = await sendUnlessAborted(
      ac.signal,
      async () => 1,
      async () => {
        sent = true;
      }
    );
    expect(outcome).toBe("aborted");
    expect(sent).toBe(false);
  });
});
