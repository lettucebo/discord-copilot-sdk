import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { downloadBounded } from "../src/core/download.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/ok") {
      const body = Buffer.from("hello-bytes");
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    } else if (url === "/big-declared") {
      // Honestly declares an oversized Content-Length → rejected before streaming.
      res.writeHead(200, { "content-length": "999999" });
      res.end(Buffer.alloc(10));
    } else if (url === "/big-stream") {
      // Lies (no/short content-length) but streams more than the cap.
      res.writeHead(200, {});
      res.end(Buffer.alloc(5000));
    } else if (url === "/404") {
      res.writeHead(404);
      res.end("nope");
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("downloadBounded", () => {
  it("returns the bytes for an OK response under the cap", async () => {
    const buf = await downloadBounded(`${base}/ok`, 1024);
    expect(buf?.toString()).toBe("hello-bytes");
  });

  it("rejects when the declared Content-Length exceeds the cap", async () => {
    expect(await downloadBounded(`${base}/big-declared`, 1024)).toBeNull();
  });

  it("aborts and rejects when the streamed body exceeds the cap", async () => {
    expect(await downloadBounded(`${base}/big-stream`, 1024)).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    expect(await downloadBounded(`${base}/404`, 1024)).toBeNull();
  });

  it("returns null on a connection error", async () => {
    // Nothing listening on this port.
    expect(await downloadBounded("http://127.0.0.1:1/x", 1024, 1000)).toBeNull();
  });
});
