/**
 * Parser for pdfTeX/LaTeX compile logs (`output.log`).
 *
 * LaTeX is lenient: it usually finishes and produces a PDF even when there are errors, so
 * the only reliable way to surface problems is to parse the log the way Overleaf's editor
 * does. This extracts errors (`! ...` blocks, with the `l.<n>` source line), warnings
 * (`LaTeX/Package ... Warning:`), and bad boxes (Overfull/Underfull), each attributed —
 * best-effort — to the file that was open per the log's parenthesis nesting.
 *
 * Pure and dependency-free so it is fully unit-testable.
 */

import type { LogEntry, LogLevel } from "./types.js";

const ERROR_RE = /^! (.+)$/;
const LINE_RE = /^l\.(\d+) (.*)$/;
const WARNING_RE = /^(?:LaTeX(?: Font)?|Package \S+|Class \S+|Module \S+) Warning: (.*)$/;
// Engine warnings are lowercase, e.g. "pdfTeX warning: ..." / "luaTeX warning (dest): ...".
const ENGINE_WARNING_RE = /^(?:pdf|lua|xe|e-|u?p)?tex warning(?: \([^)]*\))?: (.*)$/i;
const BOX_RE =
  /^(?:Overfull|Underfull|Loose|Tight) \\[hv]box \(.*?\)(?:.*?(?:at lines? (\d+)(?:--\d+)?|detected at line (\d+)))?/;
const INPUT_LINE_RE = /(?:on input line|at line) (\d+)/;

/** Parse a LaTeX log into a flat list of errors, warnings, and bad boxes. */
export function parseLatexLog(log: string): LogEntry[] {
  if (!log) return [];
  const lines = log.replace(/\r\n?/g, "\n").split("\n");
  const fileAt = computeFilePerLine(lines);
  const entries: LogEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const err = ERROR_RE.exec(line);
    if (err) {
      entries.push(buildError(lines, i, err[1], fileAt[i]));
      continue;
    }

    const warn = WARNING_RE.exec(line);
    if (warn) {
      entries.push(buildWarning(lines, i, warn[1], fileAt[i]));
      continue;
    }

    const ewarn = ENGINE_WARNING_RE.exec(line);
    if (ewarn) {
      entries.push(buildWarning(lines, i, ewarn[1], fileAt[i]));
      continue;
    }

    const box = BOX_RE.exec(line);
    if (box) {
      const ln = box[1] ?? box[2];
      entries.push({
        level: "typesetting",
        message: line.trim(),
        file: fileAt[i],
        line: ln ? Number(ln) : undefined,
        raw: line.trim(),
      });
    }
  }

  return dedupe(entries);
}

function buildError(lines: string[], i: number, message: string, file?: string): LogEntry {
  // Scan forward for the `l.<n> <source>` marker that pins the error to a source line.
  let line: number | undefined;
  let context: string | undefined;
  const raw: string[] = [lines[i]];
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
    raw.push(lines[j]);
    const m = LINE_RE.exec(lines[j]);
    if (m) {
      line = Number(m[1]);
      context = m[2];
      break;
    }
    if (ERROR_RE.test(lines[j])) {
      raw.pop(); // next error starts here; don't absorb it
      break;
    }
  }
  let msg = message.trim().replace(/\.$/, "");
  if (context && context.trim()) msg += ` (near: ${context.trim()})`;
  return { level: "error", message: msg, file, line, raw: raw.join("\n").trim() };
}

function buildWarning(lines: string[], i: number, first: string, file?: string): LogEntry {
  // Warnings can wrap onto continuation lines; gather until a blank line.
  let message = first.trim();
  const raw: string[] = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    const next = lines[j];
    if (
      next.trim() === "" ||
      ERROR_RE.test(next) ||
      WARNING_RE.test(next) ||
      ENGINE_WARNING_RE.test(next)
    ) {
      break;
    }
    raw.push(next);
    message += " " + next.trim();
  }
  const m = INPUT_LINE_RE.exec(message);
  return {
    level: "warning",
    message: message.replace(/\s+/g, " ").trim(),
    file,
    line: m ? Number(m[1]) : undefined,
    raw: raw.join("\n").trim(),
  };
}

/**
 * Lines that echo *source/box/diagnostic content* (not file open/close markers). Their
 * parentheses are prose (e.g. "et al.)", a ":(" smiley, "(Unicode):") and must not drive
 * the file stack, or one stray paren desyncs attribution for the rest of the log.
 */
function isContentLine(line: string): boolean {
  return (
    LINE_RE.test(line) || // `l.<n>` source echo
    BOX_RE.test(line) || // Overfull/Underfull box report
    line.startsWith("[") || // page/box-dump line (e.g. `[]\OT1/cmr/...`)
    line.startsWith("<") // `<inserted text>`, `<recently read>`, `<*>`
  );
}

/**
 * Best-effort: for each log line, the source file open at that point, derived from the
 * log's `(filename ... )` nesting. Non-file parens push an empty frame so the stack stays
 * balanced on a line; content/echo lines are skipped entirely; the reported file is the
 * nearest named frame. File attribution is approximate by nature - line/message are exact.
 */
function computeFilePerLine(lines: string[]): (string | undefined)[] {
  const stack: string[] = [];
  const result: (string | undefined)[] = [];
  for (const line of lines) {
    if (!isContentLine(line)) {
      let k = 0;
      while (k < line.length) {
        const c = line[k];
        if (c === "(") {
          const m = /^\(([^()\s]+\.[A-Za-z0-9]+)/.exec(line.slice(k));
          if (m) {
            stack.push(m[1].replace(/^\.\//, ""));
            k += m[0].length;
          } else {
            stack.push(""); // unnamed group — keeps a same-line `)` balanced
            k += 1;
          }
        } else if (c === ")") {
          if (stack.length) stack.pop(); // never underflow on a stray `)`
          k += 1;
        } else {
          k += 1;
        }
      }
    }
    let top: string | undefined;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s]) {
        top = stack[s];
        break;
      }
    }
    result.push(top);
  }
  return result;
}

function dedupe(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const e of entries) {
    const key = `${e.level}|${e.file ?? ""}|${e.line ?? ""}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Group a parsed log by level (convenience for summaries). */
export function splitByLevel(entries: LogEntry[]): Record<LogLevel, LogEntry[]> {
  return {
    error: entries.filter((e) => e.level === "error"),
    warning: entries.filter((e) => e.level === "warning"),
    typesetting: entries.filter((e) => e.level === "typesetting"),
  };
}
