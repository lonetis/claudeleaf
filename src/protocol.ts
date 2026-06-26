/**
 * Socket.IO 0.9 framing used by Overleaf's realtime service.
 *
 * Frames have the shape `<type>:<id>:<endpoint>:<data>`. Pure / side-effect free.
 */

export enum PacketType {
  DISCONNECT = 0,
  CONNECT = 1,
  HEARTBEAT = 2,
  MESSAGE = 3,
  JSON = 4,
  EVENT = 5,
  ACK = 6,
  ERROR = 7,
  NOOP = 8,
}

export interface Packet {
  type: PacketType;
  id: string;
  wantsAck: boolean;
  endpoint: string;
  data: string;
}

/** Split a frame on its first three colons, keeping everything after as `data`. */
function splitFrame(frame: string): [string, string, string, string] {
  const out: string[] = [];
  let s = frame;
  for (let i = 0; i < 3; i++) {
    const idx = s.indexOf(":");
    if (idx === -1) {
      out.push(s);
      s = "";
    } else {
      out.push(s.slice(0, idx));
      s = s.slice(idx + 1);
    }
  }
  out.push(s);
  while (out.length < 4) out.push("");
  return [out[0], out[1], out[2], out[3]];
}

export function decode(frame: string): Packet {
  const [typeStr, idField, endpoint, data] = splitFrame(frame);
  const type = Number(typeStr) as PacketType;
  if (Number.isNaN(type) || !(type in PacketType)) {
    throw new Error(`unknown packet type in frame ${JSON.stringify(frame)}`);
  }
  const wantsAck = idField.endsWith("+");
  const id = wantsAck ? idField.slice(0, -1) : idField;
  return { type, id, wantsAck, endpoint, data };
}

/** Return `[name, args]` for an EVENT packet. */
export function decodeEvent(pkt: Packet): [string, unknown[]] {
  if (pkt.type !== PacketType.EVENT) throw new Error("not an event packet");
  const payload = JSON.parse(pkt.data) as { name?: string; args?: unknown[] };
  return [payload.name ?? "", payload.args ?? []];
}

/**
 * Return `[ackId, data]` for an ACK packet. ACK data is `<id>+<json>`, or just `<id>`
 * when there is no payload.
 */
export function decodeAck(pkt: Packet): [number, unknown[]] {
  if (pkt.type !== PacketType.ACK) throw new Error("not an ack packet");
  const raw = pkt.data;
  const plus = raw.indexOf("+");
  if (plus !== -1) {
    return [Number(raw.slice(0, plus)), JSON.parse(raw.slice(plus + 1)) as unknown[]];
  }
  return [Number(raw), []];
}

/**
 * Encode an EVENT frame. With `msgId` it requests an ack (`5:<id>+::<json>`).
 * `JSON.stringify` keeps non-ASCII text literal (raw UTF-8 on the wire, like the browser).
 */
export function encodeEvent(name: string, args?: unknown[], msgId?: number): string {
  const body = JSON.stringify(args !== undefined ? { name, args } : { name });
  return msgId !== undefined
    ? `${PacketType.EVENT}:${msgId}+::${body}`
    : `${PacketType.EVENT}:::${body}`;
}

export function encodeHeartbeat(): string {
  return `${PacketType.HEARTBEAT}::`;
}

export function encodeDisconnect(): string {
  return `${PacketType.DISCONNECT}::`;
}
