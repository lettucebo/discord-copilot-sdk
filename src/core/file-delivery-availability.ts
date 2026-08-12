/** The SDK accepts only a mutable cwd pathname. Windows is the sole supported
 * platform because its retained root handle prevents pathname replacement while
 * that cwd is handed to the SDK; POSIX cannot provide an equivalent handoff. */
export function isFileDeliveryAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
