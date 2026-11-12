import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StringDecoder } from "node:string_decoder";
import { LineSplitter, encodeLine } from "../src/shared.ts";

describe("LineSplitter", () => {
  const record = { type: "history", text: "héllo — wörld 🙂 日本語 ".repeat(20) };
  const wire = Buffer.from(encodeLine(record) + encodeLine({ n: 2 }));

  it("returns the same lines at every chunk size", () => {
    for (const size of [1, 2, 3, 5, 7, 64, 1000]) {
      const splitter = new LineSplitter();
      const decoder = new StringDecoder("utf8");
      const lines: string[] = [];
      for (let i = 0; i < wire.length; i += size) {
        lines.push(...splitter.push(decoder.write(wire.subarray(i, i + size))));
      }
      assert.equal(lines.length, 2, `chunk size ${size}`);
      assert.deepEqual(JSON.parse(lines[0]), record, `chunk size ${size}`);
    }
  });

  it("holds a partial line until its newline arrives, however it is split", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push('{"a"'), []);
    assert.deepEqual(splitter.push(":1}"), []);
    assert.deepEqual(splitter.push("\n{"), ['{"a":1}']);
    assert.deepEqual(splitter.push('"b":2}\r\n\n'), ['{"b":2}']);
  });

  it("does not split on U+2028/U+2029", () => {
    const splitter = new LineSplitter();
    assert.equal(splitter.push(encodeLine({ t: "a b c" })).length, 1);
  });
});
