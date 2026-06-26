/**
 * ShareJS text operation helpers.
 *
 * A document is a single string (lines joined by "\n"). An *op* is an ordered list of
 * *components*, each an insert `{p, i}` or a delete `{p, d}`. Components apply left to
 * right, so each `p` is an offset into the text produced by the components before it.
 *
 * Positions are codepoint offsets of the real text. JavaScript string indices are UTF-16
 * code units, which equal codepoints for BMP characters - and Overleaf only preserves BMP
 * text - so plain string indexing is correct for all real documents.
 *
 * Pure / side-effect free (except gitBlobHash which uses node:crypto).
 */

import { createHash } from "node:crypto";

export type InsertComponent = { p: number; i: string };
export type DeleteComponent = { p: number; d: string };
export type Component = InsertComponent | DeleteComponent;
export type Op = Component[];

export function insert(pos: number, text: string): InsertComponent {
  return { p: pos, i: text };
}

export function del(pos: number, text: string): DeleteComponent {
  return { p: pos, d: text };
}

function isInsert(c: Component): c is InsertComponent {
  return (c as InsertComponent).i !== undefined;
}

/** Apply an op to `text`. Throws if a delete does not match (local mirror diverged). */
export function applyOp(text: string, op: Op): string {
  for (const comp of op) {
    const pos = comp.p;
    if (pos < 0 || pos > text.length) {
      throw new Error(`op position ${pos} out of range for length ${text.length}`);
    }
    if (isInsert(comp)) {
      text = text.slice(0, pos) + comp.i + text.slice(pos);
    } else {
      const dele = comp.d;
      const actual = text.slice(pos, pos + dele.length);
      if (actual !== dele) {
        throw new Error(
          `delete mismatch at ${pos}: expected ${JSON.stringify(dele)} but found ${JSON.stringify(actual)}`,
        );
      }
      text = text.slice(0, pos) + text.slice(pos + dele.length);
    }
  }
  return text;
}

/**
 * Compute an op that turns `oldText` into `newText` (used for whole-document replace).
 * Uses a common prefix/suffix diff: one delete + one insert of the changed middle.
 */
export function diffToOp(oldText: string, newText: string): Op {
  if (oldText === newText) return [];
  const min = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < min && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const op: Op = [];
  const removed = oldText.slice(start, endOld);
  const added = newText.slice(start, endNew);
  if (removed) op.push(del(start, removed));
  if (added) op.push(insert(start, added));
  return op;
}

/** Convert a character offset into a 0-based `[row, column]`. */
export function offsetToRowcol(text: string, offset: number): [number, number] {
  if (offset < 0) throw new Error("offset must be non-negative");
  offset = Math.min(offset, text.length);
  const prefix = text.slice(0, offset);
  const row = (prefix.match(/\n/g) ?? []).length;
  const lastNl = prefix.lastIndexOf("\n");
  return [row, offset - (lastNl + 1)];
}

/** Convert a 0-based `[row, column]` into a character offset (clamped to bounds). */
export function rowcolToOffset(text: string, row: number, column: number): number {
  if (row < 0 || column < 0) throw new Error("row and column must be non-negative");
  const lines = text.split("\n");
  row = Math.min(row, lines.length - 1);
  let offset = 0;
  for (let i = 0; i < row; i++) offset += lines[i].length + 1;
  column = Math.min(column, lines[row].length);
  return offset + column;
}

/**
 * Decode server text into real Unicode. Overleaf surfaces each UTF-8 byte as a separate
 * Latin-1 code unit; mapping those back to bytes and decoding UTF-8 recovers the text.
 * Identity for ASCII. (Outgoing text needs no fix: JSON.stringify + ws send it as UTF-8.)
 */
export function decodeWireText(wire: string): string {
  return Buffer.from(wire, "latin1").toString("utf8");
}

/** Decode the text of an incoming server op. Positions are already codepoint offsets. */
export function decodeWireOp(op: Op): Op {
  return op.map((c) =>
    isInsert(c) ? insert(c.p, decodeWireText(c.i)) : del(c.p, decodeWireText(c.d)),
  );
}

/**
 * git-blob style SHA-1: `sha1("blob " + byteLength + "\0" + content)`. Claudeleaf omits
 * the hash on the wire (the server treats it as optional and a mismatch is fatal); kept
 * for protocol completeness and tests.
 */
export function gitBlobHash(text: string): string {
  const body = Buffer.from(text, "utf8");
  const blob = Buffer.concat([Buffer.from(`blob ${body.length}\0`, "latin1"), body]);
  return createHash("sha1").update(blob).digest("hex");
}
