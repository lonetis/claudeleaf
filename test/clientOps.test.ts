import { describe, it, expect } from "vitest";

import { SessionManager } from "../src/auth.js";
import { OverleafClient } from "../src/client.js";
import { Config } from "../src/config.js";
import { EditConflictError, EditError, NotTransmittedError, ProjectNotFoundError } from "../src/errors.js";
import * as ot from "../src/ot.js";
import { ProjectSession } from "../src/session.js";

const DOC_ID = "doc1";

/** A minimal stand-in for RealtimeConnection backed by an in-memory document. */
class FakeRealtime {
  text: string;
  version: number;
  generation = 1;
  isConnected = true;
  isFatal = false;
  failNext = 0; // throw NotTransmittedError on the next N applyOtUpdate sends
  confirm = true; // whether to deliver the op-less confirmation
  applies = 0;
  ranges: unknown = undefined; // ranges object returned alongside a joinDoc ack
  joinError: unknown = null; // non-null puts an error in the ack's error slot
  private handlers: ((name: string, args: unknown[]) => void)[] = [];

  constructor(text: string, version = 0) {
    this.text = text;
    this.version = version;
  }

  addHandler(handler: (name: string, args: unknown[]) => void): void {
    this.handlers.push(handler);
  }

  async waitUntilConnected(): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async emit(name: string, args?: any[]): Promise<unknown[]> {
    if (name === "joinDoc") {
      if (this.joinError !== null) return [this.joinError];
      // The server returns lines as a byte-view (UTF-8 bytes as Latin-1 units).
      const byteView = Buffer.from(this.text, "utf8").toString("latin1");
      // Ranges ride along after the version, in a slot that has moved between server versions.
      return this.ranges === undefined
        ? [null, byteView.split("\n"), this.version]
        : [null, byteView.split("\n"), this.version, [], this.ranges, "sharejs-text-ot"];
    }
    if (name === "applyOtUpdate") {
      const [docId, update] = args as [string, { op: ot.Op; v: number }];
      if (this.failNext > 0) {
        this.failNext--;
        throw new NotTransmittedError("simulated drop before send");
      }
      this.text = ot.applyOp(this.text, update.op); // codepoint offsets + real text
      this.applies++;
      const appliedV = update.v;
      this.version = appliedV + 1;
      if (this.confirm) for (const h of this.handlers) h("otUpdateApplied", [{ doc: docId, v: appliedV }]);
      return [];
    }
    return [];
  }
}

function makeSession(text: string, version = 0, requestTimeout = 1): { session: ProjectSession; fake: FakeRealtime } {
  const cfg = new Config();
  cfg.requestTimeout = requestTimeout;
  cfg.connectTimeout = 1;
  const session = new ProjectSession(cfg, new SessionManager(cfg), "p".repeat(24), "Test Project");
  const fake = new FakeRealtime(text, version);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).rt = fake;
  fake.addHandler((name, args) => (session as unknown as { onEvent(n: string, a: unknown[]): void }).onEvent(name, args));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).entities = [{ id: DOC_ID, name: "main.tex", path: "main.tex", type: "doc", folderId: "root" }];
  return { session, fake };
}

describe("op-builders", () => {
  it("append", async () => {
    const { session, fake } = makeSession("hello");
    await session.append("main.tex", "world");
    expect(fake.text).toBe("hello\nworld");
  });
  it("insertAt", async () => {
    const { session, fake } = makeSession("hello world");
    await session.insertAt("main.tex", 5, " big");
    expect(fake.text).toBe("hello big world");
  });
  it("insert at line/column", async () => {
    const { session, fake } = makeSession("a\nb\nc");
    await session.insert("main.tex", 1, 0, "X");
    expect(fake.text).toBe("a\nXb\nc");
  });
  it("deleteRange", async () => {
    const { session, fake } = makeSession("hello world");
    await session.deleteRange("main.tex", 0, 6);
    expect(fake.text).toBe("world");
  });
  it("replaceRange", async () => {
    const { session, fake } = makeSession("hello world");
    await session.replaceRange("main.tex", 0, 5, "HELLO");
    expect(fake.text).toBe("HELLO world");
  });
  it("replaceText all and count", async () => {
    let m = makeSession("a a a");
    expect(await m.session.replaceText("main.tex", "a", "b")).toBe(3);
    expect(m.fake.text).toBe("b b b");
    m = makeSession("a a a");
    expect(await m.session.replaceText("main.tex", "a", "b", 2)).toBe(2);
    expect(m.fake.text).toBe("b b a");
  });
  it("setText", async () => {
    const { session, fake } = makeSession("old content here");
    await session.setText("main.tex", "completely new");
    expect(fake.text).toBe("completely new");
  });
  it("deleteLines", async () => {
    const { session, fake } = makeSession("one\ntwo\nthree");
    await session.deleteLines("main.tex", 1, 1);
    expect(fake.text).toBe("one\nthree");
  });
  it("version increments", async () => {
    const { session, fake } = makeSession("x", 5);
    const doc = await session.append("main.tex", "y");
    expect(doc.version).toBe(6);
    expect(fake.version).toBe(6);
  });
});

describe("encoding / positions", () => {
  it("uses codepoint offsets (insert after é is p=1)", async () => {
    const { session, fake } = makeSession("é");
    let capturedOp: ot.Op | undefined;
    const orig = fake.emit.bind(fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit = async (name: string, args?: any[]) => {
      if (name === "applyOtUpdate") capturedOp = (args as [string, { op: ot.Op }])[1].op;
      return orig(name, args);
    };
    await session.insertAt("main.tex", 1, "X");
    expect(capturedOp).toEqual([{ p: 1, i: "X" }]);
    expect(fake.text).toBe("éX");
  });
  it("edits around accented text", async () => {
    const { session, fake } = makeSession("café résumé");
    await session.insertAt("main.tex", 4, "!");
    expect(fake.text).toBe("café! résumé");
    await session.replaceText("main.tex", "café", "tea");
    expect(fake.text).toBe("tea! résumé");
  });
  it("joinDoc decodes the byte-view", async () => {
    const { session } = makeSession("naïve café");
    expect(await session.readDocument("main.tex")).toBe("naïve café");
  });
});

describe("track changes (review mode)", () => {
  /** Capture the update object sent on the next applyOtUpdate. */
  function captureUpdate(fake: FakeRealtime): () => Record<string, unknown> | undefined {
    let captured: Record<string, unknown> | undefined;
    const orig = fake.emit.bind(fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit = async (name: string, args?: any[]) => {
      if (name === "applyOtUpdate") captured = (args as [string, Record<string, unknown>])[1];
      return orig(name, args);
    };
    return () => captured;
  }

  it("attaches meta.tc with an 18-hex seed when trackChanges is set", async () => {
    const { session, fake } = makeSession("hello world");
    const get = captureUpdate(fake);
    await session.insertAt("main.tex", 5, " big", { trackChanges: true });
    const meta = get()?.meta as { tc?: string } | undefined;
    expect(meta?.tc).toMatch(/^[0-9a-f]{18}$/);
    expect(fake.text).toBe("hello big world"); // snapshot still applies as normal
  });

  it("omits meta by default (direct edit)", async () => {
    const { session, fake } = makeSession("hello world");
    const get = captureUpdate(fake);
    await session.insertAt("main.tex", 5, " big");
    expect(get()?.meta).toBeUndefined();
  });

  it("uses a fresh seed per submitted edit", async () => {
    const { session, fake } = makeSession("a a a");
    const seeds = new Set<string>();
    const orig = fake.emit.bind(fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit = async (name: string, args?: any[]) => {
      if (name === "applyOtUpdate") {
        const m = (args as [string, { meta?: { tc?: string } }])[1].meta;
        if (m?.tc) seeds.add(m.tc);
      }
      return orig(name, args);
    };
    await session.append("main.tex", "x", { trackChanges: true });
    await session.append("main.tex", "y", { trackChanges: true });
    expect(seeds.size).toBe(2);
  });
});

describe("comments", () => {
  it("addComment sends a text-neutral comment op and posts the thread message", async () => {
    const { session, fake } = makeSession("The quick brown fox");
    const posted: { threadId: string; content: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rest = { postThreadMessage: async (threadId: string, content: string) => void posted.push({ threadId, content }) };

    let capturedOp: ot.Op | undefined;
    const orig = fake.emit.bind(fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit = async (name: string, args?: any[]) => {
      if (name === "applyOtUpdate") capturedOp = (args as [string, { op: ot.Op }])[1].op;
      return orig(name, args);
    };

    const c = await session.addComment("main.tex", 10, 19, "which fox?");
    expect(capturedOp).toEqual([{ p: 10, c: "brown fox", t: c.threadId }]);
    expect(fake.text).toBe("The quick brown fox"); // text unchanged by the comment
    expect(c.threadId).toMatch(/^[0-9a-f]{24}$/);
    expect(posted).toEqual([{ threadId: c.threadId, content: "which fox?" }]);
    expect(c.text).toBe("brown fox");
    expect(c).toMatchObject({ offset: 10, line: 0, column: 10, resolved: false });
  });

  it("addComment rejects an empty range", async () => {
    const { session } = makeSession("abc");
    await expect(session.addComment("main.tex", 1, 1, "hi")).rejects.toBeInstanceOf(EditError);
  });

  it("addComment rejects an empty message", async () => {
    const { session } = makeSession("abc");
    await expect(session.addComment("main.tex", 0, 3, "")).rejects.toBeInstanceOf(EditError);
  });

  it("addComment posts the message before anchoring, so a failed post leaves no anchor", async () => {
    const { session, fake } = makeSession("The quick brown fox");
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rest = {
      postThreadMessage: async () => {
        order.push("post");
        throw new Error("session expired");
      },
    };
    const orig = fake.emit.bind(fake);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.emit = async (name: string, args?: any[]) => {
      if (name === "applyOtUpdate") order.push("anchor");
      return orig(name, args);
    };
    await expect(session.addComment("main.tex", 10, 19, "which fox?")).rejects.toThrow("session expired");
    // An orphan anchor would be permanent (no delete-thread route); an orphan thread is invisible.
    expect(order).toEqual(["post"]);
  });

  it("addComment reports the offset it actually anchored at", async () => {
    const { session } = makeSession("The quick brown fox");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rest = { postThreadMessage: async () => {} };
    const c = await session.addComment("main.tex", 4, 9, "x");
    expect(c).toMatchObject({ offset: 4, line: 0, column: 4, text: "quick" });
  });

  it("listComments raises when the join fails instead of reporting no comments", async () => {
    const { session, fake } = makeSession("hello");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rest = { getThreads: async () => ({}) };
    await session.readDocument("main.tex"); // join once while healthy
    fake.joinError = { message: "joinLeaveEpoch mismatch" };
    await expect(session.listComments("main.tex")).rejects.toThrow(/joinDoc failed/);
  });

  it("listComments surfaces a threads failure rather than reporting empty threads", async () => {
    const { session, fake } = makeSession("hello world");
    fake.ranges = { comments: [{ id: "t1", op: { p: 0, c: "hello", t: "t1" } }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rest = { getThreads: async () => { throw new Error("401"); } };
    await expect(session.listComments("main.tex")).rejects.toThrow("401");
  });

  it("listComments merges anchors with threads and skips uninterpretable ranges", async () => {
    const { session, fake } = makeSession("hello world");
    fake.ranges = {
      comments: [
        { id: "t1", op: { p: 6, c: "world", t: "t1" } },
        { id: "broken" }, // no op -> cannot be placed, must not surface as offset 0
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).rest = {
      getThreads: async () => ({
        t1: { messages: [{ content: "why?", user: { first_name: "ada", email: "a@b.c" } }], resolved: true },
      }),
    };
    const list = await session.listComments("main.tex");
    expect(list).toEqual([
      {
        threadId: "t1",
        text: "world",
        offset: 6,
        line: 0,
        column: 6,
        resolved: true,
        messages: [{ content: "why?", author: "ada", email: "a@b.c", timestamp: undefined }],
      },
    ]);
  });
});

describe("reliability paths", () => {
  it("not-transmitted retries then succeeds once", async () => {
    const { session, fake } = makeSession("base");
    fake.failNext = 1;
    await session.append("main.tex", "X");
    expect(fake.text).toBe("base\nX");
    expect(fake.applies).toBe(1); // applied exactly once
  });
  it("unconfirmed edit raises conflict and does not duplicate", async () => {
    const { session, fake } = makeSession("base", 0, 0.4);
    fake.confirm = false;
    await expect(session.append("main.tex", "X")).rejects.toBeInstanceOf(EditConflictError);
    expect(fake.applies).toBe(1); // applied at most once; client did NOT retry
  });
});

describe("input validation", () => {
  it("insert with negative line/col throws EditError", async () => {
    const { session } = makeSession("abc");
    await expect(session.insert("main.tex", -1, 0, "x")).rejects.toBeInstanceOf(EditError);
  });
  it("search with empty query throws", async () => {
    const { session } = makeSession("abc");
    await expect(session.search("main.tex", "")).rejects.toBeInstanceOf(EditError);
  });
  it("editing a binary file throws", async () => {
    const { session } = makeSession("abc");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).entities.push({ id: "f1", name: "img.png", path: "img.png", type: "file", folderId: "root" });
    await expect(session.append("img.png", "x")).rejects.toBeInstanceOf(EditError);
  });
});

describe("account project resolution", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolve = (c: OverleafClient, p: string) => (c as any).resolveProject(p) as Promise<[string, string | undefined]>;

  // Seed the project list AND stub listProjects so resolution never hits the network.
  function clientWith(list: { id: string; name: string }[]): OverleafClient {
    const client = new OverleafClient(new Config());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).projectList = list;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).listProjects = async () => (client as any).projectList;
    return client;
  }

  it("by id", async () => {
    const id = "a".repeat(24);
    expect(await resolve(new OverleafClient(new Config()), id)).toEqual([id, undefined]);
  });
  it("by name (case-insensitive)", async () => {
    const client = clientWith([
      { id: "a".repeat(24), name: "My Paper" },
      { id: "b".repeat(24), name: "Other" },
    ]);
    expect(await resolve(client, "My Paper")).toEqual(["a".repeat(24), "My Paper"]);
    expect(await resolve(client, "other")).toEqual(["b".repeat(24), "Other"]);
  });
  it("unknown throws", async () => {
    const client = clientWith([{ id: "a".repeat(24), name: "My Paper" }]);
    await expect(resolve(client, "Nope")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
  it("ambiguous throws", async () => {
    const client = clientWith([
      { id: "a".repeat(24), name: "Dup" },
      { id: "b".repeat(24), name: "Dup" },
    ]);
    await expect(resolve(client, "Dup")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
