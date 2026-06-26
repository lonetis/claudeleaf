/**
 * Authentication: obtain and cache an Overleaf session by manual browser login.
 *
 * Overleaf's login is protected by reCAPTCHA (and may use SSO/2FA), so Claudeleaf does not
 * automate credentials. `login` opens a real browser and waits for the user to sign in by
 * hand; once in, it extracts and caches the `overleaf_session2` cookie. The lightweight
 * fetch/WebSocket layers then reuse it.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core"; // type-only: erased, so the module isn't loaded

import type { Config } from "./config.js";
import { AuthError } from "./errors.js";
import type { Cookies } from "./types.js";

const RELEVANT_COOKIES = ["overleaf_session2", "deviceHistory"];
const USER_ID_RE = /name="ol-user_id"\s+content="([^"]+)"/;

export function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function loadCachedCookies(config: Config): Cookies | null {
  try {
    const data = JSON.parse(fs.readFileSync(config.sessionPath, "utf8")) as {
      cookies?: Cookies;
    };
    if (data.cookies && data.cookies["overleaf_session2"]) return data.cookies;
  } catch {
    /* missing or unreadable */
  }
  return null;
}

export function saveCookies(config: Config, cookies: Cookies): void {
  const file = config.sessionPath;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const payload = JSON.stringify({ baseUrl: config.baseUrl, cookies }, null, 2);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** True if the cookies grant authenticated access to the account dashboard. */
export async function validateCookies(config: Config, cookies: Cookies): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/project`, {
      headers: { Cookie: cookieHeader(cookies), "User-Agent": config.userAgent },
      redirect: "manual",
    });
  } catch {
    return false;
  }
  if (res.status !== 200) return false;
  const m = USER_ID_RE.exec(await res.text());
  return Boolean(m && m[1]);
}

function extractCookies(
  raw: { name: string; value: string; domain: string }[],
  config: Config,
): Cookies {
  const host = config.cookieDomain;
  const all: Cookies = {};
  for (const c of raw) {
    const domain = c.domain.replace(/^\./, "");
    if (host === domain || host.endsWith(domain) || domain.endsWith(host)) {
      all[c.name] = c.value;
    }
  }
  const filtered: Cookies = {};
  for (const k of RELEVANT_COOKIES) if (all[k] !== undefined) filtered[k] = all[k];
  return Object.keys(filtered).length ? filtered : all;
}

async function loggedIn(page: Page): Promise<boolean> {
  try {
    // String expression so this file needs no DOM lib types (it runs in the browser).
    const uid = (await page.evaluate(
      `(document.querySelector('meta[name="ol-user_id"]') || {}).content || ''`,
    )) as string;
    return Boolean(uid) && !page.url().includes("/login");
  } catch {
    return false;
  }
}

/** Open a browser, wait for the user to sign in by hand, return session cookies. */
export async function browserLogin(config: Config): Promise<Cookies> {
  const profile = config.browserProfile;
  fs.mkdirSync(profile, { recursive: true });

  // Loaded only here (lazily), so the SDK/CLI/MCP stay lightweight when not logging in.
  const { chromium } = await import("playwright-core");
  const launchOpts = {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 860 },
  };
  // Drive the user's real, installed browser — the reliable way past Overleaf's reCAPTCHA
  // (and it needs no Playwright browser download). Try Chrome, then Edge, then any
  // Playwright-managed Chromium the user may have installed.
  let ctx;
  let lastErr: unknown;
  for (const channel of ["chrome", "msedge"]) {
    try {
      ctx = await chromium.launchPersistentContext(profile, { channel, ...launchOpts });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!ctx) {
    try {
      ctx = await chromium.launchPersistentContext(profile, launchOpts);
    } catch {
      throw new AuthError(
        "could not launch a browser for login. Install Google Chrome or Microsoft Edge " +
          "(or run `npx playwright install chromium`). " +
          `Last error: ${String(lastErr)}`,
      );
    }
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${config.baseUrl}/project`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    if (!(await loggedIn(page))) {
      await page.goto(`${config.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    }

    const deadline = Date.now() + config.loginTimeout * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      if (await loggedIn(page)) break;
    }
    if (!(await loggedIn(page))) {
      try {
        await page.goto(`${config.baseUrl}/project`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
      } catch {
        /* ignore */
      }
    }
    if (!(await loggedIn(page))) {
      throw new AuthError("sign-in was not completed within the time limit");
    }

    const cookies = extractCookies(await ctx.cookies(), config);
    if (!cookies["overleaf_session2"]) {
      throw new AuthError("signed in but no session cookie was found");
    }
    return cookies;
  } finally {
    await ctx.close();
  }
}

export type CookieProvider = (forceRefresh: boolean) => Cookies;

/** Provides the cached auth cookies, or directs the user to `login` when missing. */
export class SessionManager {
  private cached: Cookies | null = null;

  constructor(private readonly config: Config) {}

  /**
   * Synchronous: returns the cached cookies, or throws if there is no session. With
   * `forceRefresh` it drops the in-memory cache and re-reads from disk (picking up a
   * session a concurrent `login` just wrote) - it does NOT throw when a session exists.
   */
  cookies(forceRefresh = false): Cookies {
    if (forceRefresh) this.cached = null;
    if (this.cached) return this.cached;
    const cached = loadCachedCookies(this.config);
    if (cached) {
      this.cached = cached;
      return cached;
    }
    throw new AuthError(
      "No Overleaf session found. Run `claudeleaf login` to sign in (a browser opens).",
    );
  }

  /** Interactively sign in via the browser and cache the session. */
  async login(): Promise<Cookies> {
    const cookies = await browserLogin(this.config);
    saveCookies(this.config, cookies);
    this.cached = cookies;
    return cookies;
  }

  /** Return valid cookies, raising a clear error if a (re)login is needed. */
  async ensureValid(): Promise<Cookies> {
    const cookies = this.cookies();
    if (await validateCookies(this.config, cookies)) return cookies;
    throw new AuthError(
      "The cached Overleaf session is invalid or expired. Run `claudeleaf login` again.",
    );
  }
}
