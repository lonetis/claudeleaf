import { describe, it, expect } from "vitest";

import { parseLatexLog, splitByLevel } from "../src/logParser.js";

// A realistic pdfTeX log fragment (modelled on real Overleaf output) with three errors,
// two warnings, and one bad box. Built line-by-line to keep LaTeX backslashes literal.
const LOG = [
  "This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025)",
  "**main.tex",
  "(./main.tex",
  "LaTeX2e <2025-06-01> patch level 1",
  "(/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls",
  "Document Class: article 2025/01/22 v1.4n Standard LaTeX document class",
  ")",
  "! Undefined control sequence.",
  "l.5 \\undefinedcommandhere",
  "",
  "The control sequence at the end of the top line",
  "of your error message was never \\def'ed.",
  "",
  "! LaTeX Error: Can be used only in preamble.",
  "",
  "See the LaTeX manual or LaTeX Companion for explanation.",
  "Type  H <return>  for immediate help.",
  " ...",
  "",
  "l.7 \\usepackage",
  "               {nope}",
  "Your command was ignored.",
  "",
  "LaTeX Warning: `h' float specifier changed to `ht'.",
  "",
  "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
  "(hyperref)                removing `\\new' on input line 42.",
  "",
  "Overfull \\hbox (15.0pt too wide) in paragraph at lines 10--12",
  "[]\\OT1/cmr/m/n/10 Some text here",
  "",
  "! Missing $ inserted.",
  "<inserted text>",
  "                $",
  "l.8 \\end{document}",
  "",
  ")",
  "Output written on output.pdf (1 page).",
].join("\n");

describe("parseLatexLog", () => {
  const entries = parseLatexLog(LOG);
  const { error, warning, typesetting } = splitByLevel(entries);

  it("empty log yields nothing", () => {
    expect(parseLatexLog("")).toEqual([]);
  });

  it("extracts every error with its source line", () => {
    expect(error).toHaveLength(3);
    expect(error.map((e) => e.line)).toEqual([5, 7, 8]);
    expect(error[0].message).toContain("Undefined control sequence");
    expect(error[1].message).toContain("Can be used only in preamble");
    expect(error[2].message).toContain("Missing $ inserted");
  });

  it("attributes errors to the open source file", () => {
    expect(error.every((e) => e.file === "main.tex")).toBe(true);
  });

  it("captures the offending source context", () => {
    expect(error[0].message).toContain("undefinedcommandhere");
  });

  it("parses warnings, including multi-line with an input line", () => {
    expect(warning.length).toBe(2);
    const hyperref = warning.find((w) => w.message.includes("Token not allowed"));
    expect(hyperref).toBeDefined();
    expect(hyperref!.line).toBe(42);
  });

  it("parses bad boxes as typesetting entries", () => {
    expect(typesetting).toHaveLength(1);
    expect(typesetting[0].message).toContain("Overfull");
    expect(typesetting[0].line).toBe(10);
  });

  it("does not absorb the next error into the previous one's context", () => {
    expect(error[1].raw).not.toContain("Missing $ inserted");
  });

  it("dedupes identical entries", () => {
    const dupLog = "! Undefined control sequence.\nl.5 \\foo\n\n! Undefined control sequence.\nl.5 \\foo\n";
    expect(parseLatexLog(dupLog)).toHaveLength(1);
  });

  it("handles a log with no errors", () => {
    const clean = "(./main.tex\nLaTeX2e <2025-06-01>\n)\nOutput written on output.pdf (1 page).\n";
    expect(splitByLevel(parseLatexLog(clean)).error).toHaveLength(0);
  });
});

describe("parseLatexLog robustness", () => {
  it("a stray ) in echoed box content does not desync file attribution", () => {
    const log = [
      "(./main.tex",
      "Overfull \\hbox (12.0pt too wide) in paragraph at lines 20--21",
      "[]\\OT1/cmr/m/n/10.95 et al.) demonstrated the result",
      "! Undefined control sequence.",
      "l.25 \\foo",
      ")",
    ].join("\n");
    const err = splitByLevel(parseLatexLog(log)).error;
    expect(err).toHaveLength(1);
    expect(err[0].file).toBe("main.tex"); // not desynced to undefined by `et al.)`
    expect(err[0].line).toBe(25);
  });

  it("parses lowercase engine warnings (pdfTeX warning)", () => {
    const log = [
      "(./main.tex",
      "pdfTeX warning: pdflatex (file ./img.pdf): PDF inclusion: found PDF version <1.7>, but at most version <1.5> allowed",
      "",
      ")",
    ].join("\n");
    const warn = splitByLevel(parseLatexLog(log)).warning;
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("PDF inclusion");
    expect(warn[0].file).toBe("main.tex");
  });

  it("parses an engine warning with a (category) parenthetical", () => {
    const log = [
      "(./main.tex",
      "pdfTeX warning (dest): name{foo.1} has been referenced but does not exist, replaced by a fixed one",
      "",
      ")",
    ].join("\n");
    const warn = splitByLevel(parseLatexLog(log)).warning;
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("has been referenced");
  });
});
