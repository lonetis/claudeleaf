/**
 * Tracked changes (review-mode suggestions) as carried in a doc's ranges, and the check that
 * keeps an edit from touching one.
 *
 * Overleaf sends a document's pending suggestions with every `joinDoc {encodeRanges:true}`
 * as `ranges.changes`: `{id, op:{p, i} | {p, d}, metadata:{user_id, ts}}`. A tracked
 * **insertion** is text that is in the snapshot at `[p, p + i.length)`; a tracked **deletion**
 * is text that is no longer in the snapshot, kept only in the range and anchored at the single
 * point `p` (shown struck through in the editor). Text in both is the realtime byte-view.
 *
 * An edit that changes text inside or at the edge of someone's pending suggestion changes or
 * removes that suggestion without the author seeing it as a decision of theirs (Overleaf
 * reports a removed insertion to its author as "rejected"). {@link findConflicts} finds the
 * suggestions an op would touch, so the edit can be refused instead.
 *
 * Pure / side-effect free.
 */

import * as ot from "./ot.js";

/** A raw entry of `ranges.changes` as the server sends it. */
export interface RawChange {
  id?: string;
  op?: { p?: number; i?: string; d?: string };
  metadata?: { user_id?: string; ts?: string | number };
}

/** A pending tracked change in a document, decoded. */
export interface ParsedChange {
  id: string;
  kind: "insert" | "delete";
  /** The inserted text (in the snapshot) or the deleted text (no longer in the snapshot). */
  text: string;
  /** Character offset in the `\n`-joined snapshot where the change sits. */
  offset: number;
  userId?: string;
  /** ISO timestamp of the change, as the server sent it (normalised to a string). */
  timestamp?: string;
}

/** Decode `ranges.changes`, skipping entries whose shape is not understood. */
export function parseChanges(raw: unknown): ParsedChange[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedChange[] = [];
  for (const entry of raw as RawChange[]) {
    if (!entry || typeof entry !== "object") continue;
    const op = entry.op;
    const offset = op?.p;
    if (!entry.id || typeof offset !== "number" || offset < 0) continue;
    let kind: "insert" | "delete";
    let wire: string;
    if (typeof op?.i === "string") {
      kind = "insert";
      wire = op.i;
    } else if (typeof op?.d === "string") {
      kind = "delete";
      wire = op.d;
    } else {
      continue;
    }
    const ts = entry.metadata?.ts;
    out.push({
      id: entry.id,
      kind,
      text: ot.decodeWireText(wire),
      offset,
      userId: entry.metadata?.user_id,
      timestamp: ts === undefined ? undefined : typeof ts === "number" ? new Date(ts).toISOString() : String(ts),
    });
  }
  return out;
}

/**
 * Return the pending changes that `op` would touch, in their original order (each at most
 * once). Components apply left to right, so the change positions are carried through each
 * component before the next one is checked.
 *
 * The rules lean conservative - a false refusal costs a question to a human, a missed one
 * silently rewrites a co-author's suggestion - but leave the text next to a suggestion
 * editable, since replacing the neighbouring word is the common case:
 * - an insert conflicts with a tracked insertion if it lands strictly inside it (Overleaf's
 *   change tracker shifts or leaves a suggestion on an edge insert, merging only a tracked
 *   insert of the same user), and with a tracked deletion if it lands on the deletion's anchor
 *   point (it would put new text where the suggestion removes text);
 * - a delete conflicts with a tracked insertion if the two spans overlap, and with a tracked
 *   deletion if the anchor lies strictly inside the deleted span.
 * Comment components change no text and never conflict.
 */
export function findConflicts(op: ot.Op, changes: ParsedChange[]): ParsedChange[] {
  // Working copy of each change's span in the evolving text: [start, end) for an insertion,
  // the point start === end for a deletion.
  const spans = changes.map((c) => ({
    change: c,
    start: c.offset,
    end: c.kind === "insert" ? c.offset + c.text.length : c.offset,
  }));
  const hit = new Set<string>();

  for (const comp of op) {
    if ("c" in comp) continue; // comment marker: no text change
    if ("i" in comp) {
      const q = comp.p;
      const n = comp.i.length;
      for (const s of spans) {
        const isInsert = s.change.kind === "insert";
        if (isInsert ? s.start < q && q < s.end : q === s.start) hit.add(s.change.id);
        // Shift what lies at or after the insert point. (A span the insert lands strictly
        // inside has already conflicted; growing it keeps later checks conservative.)
        if (q <= s.start) {
          s.start += n;
          s.end += n;
        } else if (q < s.end) {
          s.end += n;
        }
      }
    } else {
      const a = comp.p;
      const n = comp.d.length;
      const b = a + n;
      for (const s of spans) {
        const isInsert = s.change.kind === "insert";
        if (isInsert ? a < s.end && s.start < b : a < s.start && s.start < b) hit.add(s.change.id);
        s.start = shiftForDelete(s.start, a, b);
        s.end = shiftForDelete(s.end, a, b);
      }
    }
  }
  return changes.filter((c) => hit.has(c.id));
}

function shiftForDelete(pos: number, a: number, b: number): number {
  if (pos <= a) return pos;
  if (pos >= b) return pos - (b - a);
  return a; // inside the deleted span: collapse onto its start
}
