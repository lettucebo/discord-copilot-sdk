import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readReleaseWorkflow(): string {
  return fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
}

describe("release workflow contract", () => {
  it("publishes curated release notes before GitHub-generated notes from tag pushes", () => {
    const workflow = readReleaseWorkflow();

    expect(workflow).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\["v\*"\]/);
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*write/);
    expect(workflow).toMatch(/- uses: actions\/checkout@v5\s*\n\s*with:\s*\n\s*fetch-depth:\s*0/);
    expect(workflow).toMatch(/- uses: actions\/setup-node@v5\s*\n\s*with:\s*\n\s*node-version:\s*"22\.12"/);
    expect(workflow).toContain(
      "# Do not run npm install: scripts/release.mjs and scripts/lib/release-core.mjs depend only on Node built-ins."
    );
    expect(workflow).toMatch(/version="\$\{GITHUB_REF_NAME#v\}"/);
    expect(workflow).toMatch(/node scripts\/release\.mjs --notes "\$version" > release-notes\.md/);
    expect(workflow).toMatch(/- uses: softprops\/action-gh-release@v2\s*\n\s*with:\s*\n(?:\s+.*\n)*\s*body_path:\s*release-notes\.md\n(?:\s+.*\n)*\s*generate_release_notes:\s*true/);
    expect(workflow).not.toMatch(/\bappend_body\s*:/);
    expect(workflow).not.toMatch(/run:\s*npm install\b/);
    expect(workflow).not.toMatch(/\bgh release create\b/);
    expect(workflow).not.toMatch(/\bprevious_tag\s*:/);
  });
});
