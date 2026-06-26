/**
 * Low-level Socket.IO 0.9 client for Overleaf's realtime service.
 *
 * Performs the HTTP handshake (capturing the `GCLB` load-balancer affinity cookie), owns
 * the WebSocket, matches request/ack pairs so {@link emit} is awaitable, keeps the
 * connection alive (heartbeats + serverPing/clientPong), and transparently reconnects
 * (refreshing auth) when the socket drops, invoking `onReconnect` so the higher layer can
 * re-join its documents.
 *
 * Single-threaded and event-driven (no locks): the message handler resolves acks and
 * dispatches events between awaits.
 */

import WebSocket, { type RawData } from "ws";

import { cookieHeader, type CookieProvider } from "./auth.js";
import type { Config } from "./config.js";
import { AuthError, ConnectionError, NotTransmittedError, TimeoutError } from "./errors.js";
import * as protocol from "./protocol.js";
import { Deferred, sleep, withTimeout } from "./util.js";

export type EventHandler = (name: string, args: unknown[]) => void;

export class RealtimeConnection {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private acks = new Map<number, Deferred<unknown[]>>();
  private handlers: EventHandler[] = [];

  private connectedFlag = false;
  private connectedDeferred = new Deferred<void>();
  private fatal: Error | null = null;
  private closing = false;
  private reconnecting = false;
  private redropPending = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private gen = 0;

  private joinProject: Record<string, unknown> | null = null;
  onReconnect: (() => Promise<void> | void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly cookieProvider: CookieProvider,
    private readonly projectId: string,
  ) {}

  get generation(): number {
    return this.gen;
  }

  get isFatal(): boolean {
    return this.fatal !== null;
  }

  get isConnected(): boolean {
    return this.connectedFlag && !this.closing;
  }

  get socket(): WebSocket | null {
    return this.ws;
  }

  addHandler(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Connect and resolve with the joinProjectResponse payload. */
  async connect(): Promise<Record<string, unknown>> {
    this.closing = false;
    this.fatal = null;
    try {
      await this.doConnect(false);
      await this.awaitReady(this.config.connectTimeout);
      if (!this.joinProject) throw new ConnectionError("connected but no joinProjectResponse");
      return this.joinProject;
    } catch (e) {
      this.close(); // don't leak the socket / heartbeat on a failed connect
      throw e;
    }
  }

  async waitUntilConnected(timeoutSec?: number): Promise<void> {
    await this.awaitReady(timeoutSec ?? this.config.connectTimeout);
  }

  close(): void {
    this.closing = true;
    this.connectedFlag = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.ws?.send(protocol.encodeDisconnect());
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.failPending(new ConnectionError("connection closed"));
  }

  /**
   * Send an event, resolving with the server ack when `wantAck`. `retryOnDrop` (default
   * true) transparently waits for reconnect and retries when the socket is down at *send*
   * time (the frame never left). For non-idempotent edits set it false: a
   * NotTransmittedError is thrown so the caller can re-join and rebuild before resending,
   * keeping edits at-most-once. A frame that *was* sent but whose ack is lost always
   * throws (ambiguous), never auto-retries.
   */
  async emit(
    name: string,
    args?: unknown[],
    opts: { wantAck?: boolean; timeout?: number; retryOnDrop?: boolean } = {},
  ): Promise<unknown[]> {
    const wantAck = opts.wantAck ?? true;
    const retryOnDrop = opts.retryOnDrop ?? true;
    const total = opts.timeout ?? this.config.requestTimeout;
    const deadline = Date.now() + total * 1000;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TimeoutError(`timed out sending ${name} after ${total}s`);
      await this.awaitReady(remaining / 1000);

      if (!wantAck) {
        try {
          this.send(protocol.encodeEvent(name, args));
          return [];
        } catch (e) {
          if (this.fatal || this.closing || !retryOnDrop) throw e;
          await sleep(200);
          continue;
        }
      }

      const id = ++this.nextId;
      const ack = new Deferred<unknown[]>();
      this.acks.set(id, ack);
      try {
        this.send(protocol.encodeEvent(name, args, id));
      } catch (e) {
        this.acks.delete(id);
        if (this.fatal || this.closing) throw e;
        if (!retryOnDrop) throw new NotTransmittedError(String(e));
        await sleep(200);
        continue; // frame was not transmitted -> safe to retry after reconnect
      }

      const rem = deadline - Date.now();
      try {
        return await withTimeout(
          ack.promise,
          Math.max(0, rem),
          () => new TimeoutError(`no ack for ${name} within ${total}s`),
        );
      } finally {
        this.acks.delete(id);
      }
    }
  }

  // -- connection lifecycle --------------------------------------------
  private async handshake(forceRefresh: boolean): Promise<{ sid: string; cookies: string }> {
    const jar: Record<string, string> = { ...this.cookieProvider(forceRefresh) };
    const ts = Date.now();
    const url =
      `${this.config.baseUrl}/socket.io/1/` +
      `?projectId=${this.projectId}&esh=1&ssp=1&t=${ts}`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookieHeader(jar),
        "User-Agent": this.config.userAgent,
        Referer: this.config.projectUrl(this.projectId),
      },
      redirect: "manual",
    });
    const body = (await res.text()).trim();
    // Capture the GCLB affinity cookie (must be forwarded on the WebSocket).
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const colons = (body.match(/:/g) ?? []).length;
    if (res.status !== 200 || colons < 3) {
      if (!forceRefresh) return this.handshake(true);
      throw new AuthError(
        `Overleaf rejected the realtime handshake (status ${res.status}); session invalid.`,
      );
    }
    return { sid: body.split(":", 1)[0], cookies: cookieHeader(jar) };
  }

  private async doConnect(forceRefresh: boolean): Promise<void> {
    const { sid, cookies } = await this.handshake(forceRefresh);
    const wsUrl =
      `${this.config.wsScheme}://${this.config.host}/socket.io/1/websocket/` +
      `${sid}?projectId=${this.projectId}&esh=1&ssp=1`;
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: cookies, "User-Agent": this.config.userAgent },
      origin: this.config.baseUrl,
      handshakeTimeout: this.config.connectTimeout * 1000,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const oldWs = this.ws;
    this.ws = ws;
    this.gen += 1;
    const generation = this.gen;
    if (oldWs) {
      oldWs.removeAllListeners();
      try {
        oldWs.close();
      } catch {
        /* ignore */
      }
    }
    this.connectedFlag = false;
    this.connectedDeferred = new Deferred();
    this.joinProject = null;

    ws.on("message", (data: RawData) => this.onMessage(String(data), generation));
    ws.on("close", () => this.onClose(generation));
    ws.on("error", () => {
      /* close follows */
    });
    this.startHeartbeat(generation);
  }

  private startHeartbeat(generation: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const timer = setInterval(() => {
      if (this.closing || generation !== this.gen) {
        clearInterval(timer);
        return;
      }
      try {
        this.send(protocol.encodeHeartbeat());
      } catch {
        clearInterval(timer);
      }
    }, this.config.heartbeatInterval * 1000);
    timer.unref?.(); // never keep the event loop alive on its own
    this.heartbeatTimer = timer;
  }

  private onMessage(frame: string, generation: number): void {
    if (this.closing || generation !== this.gen || frame === "") return;
    try {
      const pkt = protocol.decode(frame);
      switch (pkt.type) {
        case protocol.PacketType.HEARTBEAT:
          this.send(protocol.encodeHeartbeat());
          break;
        case protocol.PacketType.DISCONNECT:
          this.ws?.close();
          break;
        case protocol.PacketType.ACK:
          this.resolveAck(pkt); // decodeAck JSON.parse can throw on a malformed frame
          break;
        case protocol.PacketType.EVENT:
          this.handleEvent(pkt);
          break;
        default:
          break; // CONNECT / NOOP / ERROR
      }
    } catch {
      /* a malformed frame must never crash the connection */
    }
  }

  private resolveAck(pkt: protocol.Packet): void {
    const [id, data] = protocol.decodeAck(pkt);
    const ack = this.acks.get(id);
    if (ack) {
      this.acks.delete(id);
      ack.resolve(data);
    }
  }

  private handleEvent(pkt: protocol.Packet): void {
    let name: string;
    let args: unknown[];
    try {
      [name, args] = protocol.decodeEvent(pkt);
    } catch {
      return;
    }
    if (name === "joinProjectResponse") {
      this.joinProject = (args[0] as Record<string, unknown>) ?? {};
      this.connectedFlag = true;
      this.connectedDeferred.resolve();
      return;
    }
    if (name === "serverPing") {
      try {
        this.send(protocol.encodeEvent("clientPong", args));
      } catch {
        /* ignore */
      }
      return;
    }
    for (const handler of [...this.handlers]) {
      try {
        handler(name, args);
      } catch {
        /* never let a bad handler crash the loop */
      }
    }
  }

  private onClose(generation: number): void {
    if (this.closing || generation !== this.gen) return;
    this.handleDrop();
  }

  private handleDrop(): void {
    if (this.closing) return;
    if (this.reconnecting) {
      // A drop during an in-progress reconnect (e.g. the settle / onReconnect window):
      // record it so the reconnect loop re-runs rather than leaving a dead connection.
      this.redropPending = true;
      this.connectedFlag = false;
      this.failPending(new ConnectionError("connection dropped during reconnect"));
      return;
    }
    this.reconnecting = true;
    this.connectedFlag = false;
    this.failPending(new ConnectionError("connection dropped; reconnecting"));
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    try {
      for (;;) {
        this.redropPending = false;
        let delay = this.config.reconnectBaseDelay;
        let connected = false;
        for (let attempt = 1; attempt <= this.config.reconnectMaxAttempts; attempt++) {
          if (this.closing) return;
          await sleep(delay * 1000);
          try {
            await this.doConnect(attempt > 2);
            await this.awaitReady(this.config.connectTimeout);
            connected = true;
            break;
          } catch {
            delay = Math.min(delay * 2, 30);
          }
        }
        if (!connected) {
          this.fatal = new ConnectionError("exhausted reconnect attempts");
          this.failPending(this.fatal);
          return;
        }
        // Settle before re-joining docs (Overleaf's joinLeaveEpoch protection rejects a
        // too-eager re-join), then re-join the open documents.
        await sleep(500);
        if (this.onReconnect) {
          try {
            await this.onReconnect();
          } catch {
            /* docs are re-joined lazily on next access */
          }
        }
        // If a drop landed during the settle/onReconnect window, reconnect again.
        if (!this.redropPending && this.connectedFlag) return;
      }
    } finally {
      this.reconnecting = false;
    }
  }

  // -- helpers ----------------------------------------------------------
  private async awaitReady(timeoutSec: number): Promise<void> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      if (this.fatal) throw this.fatal;
      if (this.closing) throw new ConnectionError("connection is closed");
      if (this.isConnected) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw (
          this.fatal ??
          new ConnectionError("not connected (still establishing or reconnecting)")
        );
      }
      await Promise.race([
        this.connectedDeferred.promise.catch(() => undefined),
        sleep(Math.min(remaining, 250)),
      ]);
    }
  }

  private send(frame: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionError("websocket is not open");
    }
    ws.send(frame);
  }

  private failPending(error: Error): void {
    const pending = [...this.acks.values()];
    this.acks.clear();
    for (const ack of pending) ack.reject(error);
  }
}
