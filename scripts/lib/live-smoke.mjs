export function matchesExpectedShellPermission(view, expectedCommand) {
  if (
    view.kind !== "shell" ||
    view.supported !== true ||
    // SessionActor sets this only for one simple, safe executable. In
    // particular, multiline/chained commands never reach the auto-approve path.
    view.canOfferSession !== true
  ) {
    return false;
  }

  const lines = view.summary.split(/\r?\n/);
  const commandLine = `$ ${expectedCommand}`;
  return (
    lines.filter((line) => line === commandLine).length === 1 &&
    lines.every(
      (line) =>
        line === commandLine ||
        line.startsWith("intent: ") ||
        line.startsWith("• paths: ")
    )
  );
}
