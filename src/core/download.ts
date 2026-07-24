/**
 * Bounded HTTP download for untrusted-size content (Discord image CDN URLs).
 *
 * Guards against: a stalled response (AbortSignal timeout), a lying/oversized
 * body (Content-Length pre-check AND a cumulative streaming cap that aborts mid
 * stream), and non-OK responses. Returns the bytes as a Buffer, or null when the
 * download failed or exceeded `maxBytes`.
 */
export async function downloadBounded(
  url: string,
  maxBytes: number,
  timeoutMs = 15_000
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;

    const reader = res.body?.getReader();
    if (!reader) {
      // No streaming body: fall back to a buffered read with a post-check.
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.byteLength > maxBytes ? null : buf;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  } catch {
    return null; // timeout, network error, abort — treat as a failed download
  }
}
