import { describe, it, expect } from "vitest";

import * as protocol from "../src/protocol.js";
import { PacketType } from "../src/protocol.js";

describe("decode", () => {
  it("connect", () => {
    const p = protocol.decode("1::");
    expect(p.type).toBe(PacketType.CONNECT);
    expect(p.id).toBe("");
    expect(p.endpoint).toBe("");
  });
  it("heartbeat / disconnect", () => {
    expect(protocol.decode("2::").type).toBe(PacketType.HEARTBEAT);
    expect(protocol.decode("0::").type).toBe(PacketType.DISCONNECT);
  });
  it("event without id keeps full JSON", () => {
    const p = protocol.decode('5:::{"name":"otUpdateApplied","args":[{"v":3,"doc":"abc"}]}');
    expect(p.type).toBe(PacketType.EVENT);
    expect(p.wantsAck).toBe(false);
    const [name, args] = protocol.decodeEvent(p);
    expect(name).toBe("otUpdateApplied");
    expect(args).toEqual([{ v: 3, doc: "abc" }]);
  });
  it("event wanting ack", () => {
    const p = protocol.decode('5:2+::{"name":"joinDoc","args":["doc1"]}');
    expect(p.id).toBe("2");
    expect(p.wantsAck).toBe(true);
    expect(protocol.decodeEvent(p)).toEqual(["joinDoc", ["doc1"]]);
  });
  it("ack with payload", () => {
    const p = protocol.decode('6:::2+[null,["line1","line2"],7]');
    expect(protocol.decodeAck(p)).toEqual([2, [null, ["line1", "line2"], 7]]);
  });
  it("ack without payload", () => {
    expect(protocol.decodeAck(protocol.decode("6:::3"))).toEqual([3, []]);
  });
  it("error frame", () => {
    const p = protocol.decode("7:::1+0");
    expect(p.type).toBe(PacketType.ERROR);
    expect(p.data).toBe("1+0");
  });
});

describe("encode", () => {
  it("event with ack", () => {
    const frame = protocol.encodeEvent("applyOtUpdate", ["doc1", { v: 0 }], 5);
    expect(frame.startsWith("5:5+::")).toBe(true);
    expect(JSON.parse(frame.split("::", 2)[1])).toEqual({ name: "applyOtUpdate", args: ["doc1", { v: 0 }] });
  });
  it("event without ack", () => {
    const frame = protocol.encodeEvent("clientPong", [1, 2]);
    expect(frame.startsWith("5:::")).toBe(true);
    expect(JSON.parse(frame.slice(4))).toEqual({ name: "clientPong", args: [1, 2] });
  });
  it("non-ASCII text goes out raw (not escaped)", () => {
    const frame = protocol.encodeEvent("x", [{ i: "café" }]);
    expect(frame).toContain("café"); // JSON.stringify keeps it literal
  });
  it("heartbeat / disconnect", () => {
    expect(protocol.encodeHeartbeat()).toBe("2::");
    expect(protocol.encodeDisconnect()).toBe("0::");
  });
  it("round-trips", () => {
    const frame = protocol.encodeEvent("ping", [{ a: 1 }], 9);
    const p = protocol.decode(frame);
    expect(p.id).toBe("9");
    expect(p.wantsAck).toBe(true);
    expect(protocol.decodeEvent(p)).toEqual(["ping", [{ a: 1 }]]);
  });
});
