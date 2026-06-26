/**
 * Account-level configuration. Everything has a sensible default, so no configuration is
 * required out of the box. Optional environment variables override defaults (mainly for
 * self-hosted Overleaf / tuning); there are no project, email, or password settings.
 */

import os from "node:os";
import path from "node:path";

import { ConfigError } from "./errors.js";

const DEFAULT_BASE_URL = "https://www.overleaf.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PROJECT_ID_RE = /\/project\/([0-9a-fA-F]{24})/;
const BARE_ID_RE = /^[0-9a-fA-F]{24}$/;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeBaseUrl(url: string): string {
  let u = (url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!u.includes("://")) u = "https://" + u;
  return u;
}

/** Extract a 24-char hex project id from a URL or bare id, or null if not present. */
export function parseProjectId(value: string): string | null {
  const v = value.trim();
  if (BARE_ID_RE.test(v)) return v.toLowerCase();
  const m = PROJECT_ID_RE.exec(v);
  return m ? m[1].toLowerCase() : null;
}

export interface ConfigOptions {
  baseUrl?: string;
  userAgent?: string;
  home?: string;
  /** seconds */
  loginTimeout?: number;
  connectTimeout?: number;
  requestTimeout?: number;
  compileTimeout?: number;
  heartbeatInterval?: number;
  reconnectMaxAttempts?: number;
  reconnectBaseDelay?: number;
}

export class Config {
  baseUrl: string;
  userAgent: string;
  home: string;
  loginTimeout: number;
  connectTimeout: number;
  requestTimeout: number;
  compileTimeout: number;
  heartbeatInterval: number;
  reconnectMaxAttempts: number;
  reconnectBaseDelay: number;

  constructor(opts: ConfigOptions = {}) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.userAgent = opts.userAgent || DEFAULT_USER_AGENT;
    this.home = expandHome(opts.home ?? defaultHome());
    this.loginTimeout = opts.loginTimeout ?? 300;
    this.connectTimeout = opts.connectTimeout ?? 20;
    this.requestTimeout = opts.requestTimeout ?? 15;
    this.compileTimeout = opts.compileTimeout ?? 180; // compiling can take a while
    this.heartbeatInterval = opts.heartbeatInterval ?? 20;
    this.reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 10;
    this.reconnectBaseDelay = opts.reconnectBaseDelay ?? 1;
  }

  get sessionPath(): string {
    const override = process.env.CLAUDELEAF_SESSION_PATH;
    if (override) return expandHome(override);
    return path.join(this.home, "session.json");
  }

  get browserProfile(): string {
    const override = process.env.CLAUDELEAF_BROWSER_PROFILE;
    if (override) return expandHome(override);
    return path.join(this.home, "browser-profile");
  }

  /** Host[:port] - used for the WebSocket URL (the port matters there). */
  get host(): string {
    return this.baseUrl.split("://", 2)[1].split("/", 1)[0];
  }

  /** Hostname without port - cookie domains must not include a port. */
  get cookieDomain(): string {
    return new URL(this.baseUrl).hostname;
  }

  get wsScheme(): string {
    return this.baseUrl.startsWith("https") ? "wss" : "ws";
  }

  projectUrl(projectId: string): string {
    return `${this.baseUrl}/project/${projectId}`;
  }

  static fromEnv(): Config {
    const num = (name: string, current: number): number => {
      const raw = process.env[name];
      if (!raw) return current;
      const n = Number(raw);
      if (Number.isNaN(n)) throw new ConfigError(`${name} must be a number, got ${raw}`);
      return n;
    };
    const cfg = new Config({
      baseUrl: process.env.OVERLEAF_BASE_URL || DEFAULT_BASE_URL,
      userAgent: process.env.OVERLEAF_USER_AGENT || DEFAULT_USER_AGENT,
    });
    cfg.loginTimeout = num("CLAUDELEAF_LOGIN_TIMEOUT", cfg.loginTimeout);
    cfg.connectTimeout = num("CLAUDELEAF_CONNECT_TIMEOUT", cfg.connectTimeout);
    cfg.requestTimeout = num("CLAUDELEAF_REQUEST_TIMEOUT", cfg.requestTimeout);
    cfg.compileTimeout = num("CLAUDELEAF_COMPILE_TIMEOUT", cfg.compileTimeout);
    cfg.heartbeatInterval = num("CLAUDELEAF_HEARTBEAT_INTERVAL", cfg.heartbeatInterval);
    return cfg;
  }
}

function defaultHome(): string {
  const override = process.env.CLAUDELEAF_HOME;
  if (override) return expandHome(override);
  return path.join(os.homedir(), ".claudeleaf");
}
