/**
 * Run `send` only if `signal` has NOT been aborted by the time the async
 * `prepare` step (e.g. downloading Discord image attachments) completes.
 *
 * This closes the /stop-during-download gap: a turn is reserved and its
 * attachments downloaded before the prompt is handed to the agent, so an abort
 * that arrives during the download must prevent the send. There is no `await`
 * between the abort check and `send`, so a single-threaded /stop can't slip in
 * between them.
 */
export async function sendUnlessAborted<T>(
  signal: AbortSignal,
  prepare: () => Promise<T>,
  send: (payload: T) => Promise<void>
): Promise<"sent" | "aborted"> {
  const payload = await prepare();
  if (signal.aborted) return "aborted";
  await send(payload);
  return "sent";
}
