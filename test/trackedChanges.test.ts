import { describe, it, expect } from "vitest";

import * as ot from "../src/ot.js";
import { findConflicts, parseChanges, type ParsedChange } from "../src/trackedChanges.js";

// "hello brave world": a pending insertion "brave " at [6, 12), a pending deletion anchored at 12.
const ins: ParsedChange = { id: "ins", kind: "insert", text: "brave ", offset: 6 };
const del: ParsedChange = { id: "del", kind: "delete", text: "big ", offset: 12 };
const ids = (op: ot.Op, changes = [ins, del]) => findConflicts(op, changes).map((c) => c.id);

describe("parseChanges", () => {
  it("decodes inserts and deletes, byte-view text and numeric timestamps", () => {
    const wire = Buffer.from("é", "utf8").toString("latin1");
    const parsed = parseChanges([
      { id: "a", op: { p: 3, i: wire }, metadata: { user_id: "u1", ts: "2026-11-09T10:00:00.000Z" } },
      { id: "b", op: { p: 5, d: "gone" }, metadata: { user_id: "u2", ts: 0 } },
    ]);
    expect(parsed).toEqual([
      { id: "a", kind: "insert", text: "é", offset: 3, userId: "u1", timestamp: "2026-11-09T10:00:00.000Z" },
      { id: "b", kind: "delete", text: "gone", offset: 5, userId: "u2", timestamp: "1970-01-01T00:00:00.000Z" },
    ]);
  });
  it("skips entries it cannot interpret and non-arrays", () => {
    expect(parseChanges(undefined)).toEqual([]);
    expect(parseChanges({})).toEqual([]);
    expect(parseChanges([null, { op: { p: 1, i: "x" } }, { id: "x", op: { i: "x" } }, { id: "y", op: { p: 1 } }])).toEqual([]);
  });
});

describe("findConflicts", () => {
  it("allows edits away from any suggestion", () => {
    expect(ids([ot.insert(0, "Oh, ")])).toEqual([]);
    expect(ids([ot.del(0, "hello")])).toEqual([]);
    expect(ids([ot.del(13, "orld")])).toEqual([]);
  });
  it("refuses an insert strictly inside a tracked insertion, allows one at its edges", () => {
    expect(ids([ot.insert(8, "x")])).toEqual(["ins"]);
    expect(ids([ot.insert(6, "x")], [ins])).toEqual([]);
    expect(ids([ot.insert(12, "x")], [ins])).toEqual([]);
  });
  it("refuses a delete that overlaps a tracked insertion, allows one that only touches it", () => {
    expect(ids([ot.del(4, "o b")])).toEqual(["ins"]);
    expect(ids([ot.del(0, "hello ")], [ins])).toEqual([]);
  });
  it("refuses an insert on a deletion anchor and a delete spanning it, allows one touching it", () => {
    expect(ids([ot.insert(12, "x")], [del])).toEqual(["del"]);
    expect(ids([ot.del(10, "e w")], [del])).toEqual(["del"]);
    expect(ids([ot.del(12, "w")], [del])).toEqual([]);
    expect(ids([ot.del(11, " ")], [del])).toEqual([]);
  });
  it("still refuses replacing the word right after a deletion (the insert lands on the anchor)", () => {
    expect(ids([ot.del(12, "world"), ot.insert(12, "there")], [del])).toEqual(["del"]);
  });
  it("carries positions through earlier components of the same op", () => {
    // Deleting "hello " first moves the insertion to [0, 6); an insert at 3 then lands inside it.
    expect(ids([ot.del(0, "hello "), ot.insert(3, "x")], [ins])).toEqual(["ins"]);
    // Inserting 4 chars at 0 moves the deletion anchor to 16; deleting at 12 no longer reaches it.
    expect(ids([ot.insert(0, "Oh, "), ot.del(12, "a")], [del])).toEqual([]);
  });
  it("ignores comment components", () => {
    expect(ids([ot.comment(6, "brave ", "t1")])).toEqual([]);
  });
  it("reports each change once, in input order", () => {
    expect(ids([ot.del(4, "o brave w")])).toEqual(["ins", "del"]);
  });
});
