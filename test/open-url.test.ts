import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCommand, openUrl } from "../src/open-url.ts";

describe("openCommand", () => {
  it("opens http and https links with the platform opener", () => {
    assert.deepEqual(openCommand("https://example.com/a?b=1#c", "linux"), { cmd: "xdg-open", args: ["https://example.com/a?b=1#c"] });
    assert.deepEqual(openCommand("http://example.com", "darwin"), { cmd: "open", args: ["http://example.com/"] });
    assert.deepEqual(openCommand("https://example.com/", "win32"), { cmd: "cmd", args: ["/c", "start", "", "https://example.com/"] });
  });

  it("refuses anything that is not a web link", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ssh://host", "mailto:a@b.c", "rm -rf /", "example.com"]) {
      assert.ok("refused" in openCommand(url, "linux"), url);
    }
  });

  it("refuses links with whitespace or control characters, and absurdly long ones", () => {
    assert.ok("refused" in openCommand("https://example.com/a b", "linux"));
    assert.ok("refused" in openCommand("https://example.com/\x1b[31m", "linux"));
    assert.ok("refused" in openCommand(`https://example.com/${"a".repeat(3000)}`, "linux"));
  });

  it("hands the normalised href over, so a trick like a userinfo prefix is not reinterpreted by the shell", () => {
    const c = openCommand("https://example.com;touch@evil.test/", "linux");
    assert.ok(!("refused" in c));
    assert.equal(c.args.length, 1);
  });
});

describe("openUrl", () => {
  it("reports a refused link instead of spawning", () => {
    const seen: string[] = [];
    openUrl("file:///etc/passwd", (t) => seen.push(t));
    assert.equal(seen.length, 1);
    assert.match(seen[0] as string, /not opened: only http and https/);
  });
});
