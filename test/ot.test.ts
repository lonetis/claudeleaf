import { describe, it, expect } from "vitest";

import * as ot from "../src/ot.js";

describe("ot apply", () => {
  it("inserts", () => {
    expect(ot.applyOp("hello world", [ot.insert(5, " big")])).toBe("hello big world");
  });
  it("deletes", () => {
    expect(ot.applyOp("hello big world", [ot.del(5, " big")])).toBe("hello world");
  });
  it("replace = delete then insert at same pos", () => {
    expect(ot.applyOp("foobaz", [ot.del(0, "foo"), ot.insert(0, "bar")])).toBe("barbaz");
  });
  it("throws on delete mismatch", () => {
    expect(() => ot.applyOp("hello", [ot.del(0, "xyz")])).toThrow();
  });
  it("throws on out-of-range", () => {
    expect(() => ot.applyOp("hi", [ot.insert(99, "x")])).toThrow();
  });
});

describe("diffToOp", () => {
  it("is empty for identical", () => {
    expect(ot.diffToOp("same", "same")).toEqual([]);
  });
  it("property: apply(old, diff(old,new)) === new", () => {
    const alphabet = ["a", "b", "c", " ", "\n"];
    for (let seed = 0; seed < 200; seed++) {
      const rng = mulberry32(seed);
      const make = () =>
        Array.from({ length: Math.floor(rng() * 30) }, () => alphabet[Math.floor(rng() * alphabet.length)]).join("");
      const oldText = make();
      const newText = make();
      expect(ot.applyOp(oldText, ot.diffToOp(oldText, newText))).toBe(newText);
    }
  });
});

describe("offset/rowcol", () => {
  it("round-trips", () => {
    const text = "line0\nline1\nlonger line2";
    for (let offset = 0; offset <= text.length; offset++) {
      const [row, col] = ot.offsetToRowcol(text, offset);
      expect(ot.rowcolToOffset(text, row, col)).toBe(offset);
    }
  });
  it("specific positions", () => {
    const text = "ab\ncde\nf";
    expect(ot.offsetToRowcol(text, 0)).toEqual([0, 0]);
    expect(ot.offsetToRowcol(text, 3)).toEqual([1, 0]);
    expect(ot.offsetToRowcol(text, 4)).toEqual([1, 1]);
    expect(ot.rowcolToOffset(text, 2, 0)).toBe(7);
  });
  it("clamps past end", () => {
    expect(ot.rowcolToOffset("a\nb", 99, 99)).toBe(3);
  });
});

describe("wire encoding", () => {
  it("decodeWireText recovers real text", () => {
    expect(ot.decodeWireText("cafÃ©")).toBe("café");
    expect(ot.decodeWireText("plain ascii")).toBe("plain ascii");
  });
  it("decodeWireText round-trips via byte-view", () => {
    for (const text of ["café résumé", "中文测试", "α+β=γ — ok", "ascii"]) {
      const byteView = Buffer.from(text, "utf8").toString("latin1");
      expect(ot.decodeWireText(byteView)).toBe(text);
    }
  });
  it("decodeWireOp decodes text, keeps positions", () => {
    expect(ot.decodeWireOp([ot.insert(5, "Ã©")])).toEqual([{ p: 5, i: "é" }]);
    expect(ot.decodeWireOp([ot.del(2, "cafÃ©")])).toEqual([{ p: 2, d: "café" }]);
  });
});

describe("gitBlobHash", () => {
  it("matches git hash-object", () => {
    expect(ot.gitBlobHash("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(ot.gitBlobHash("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
