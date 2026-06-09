import type { Page } from "playwright";

const API_KEY = process.env["TWOCAPTCHA_API_KEY"];
const BASE_URL = "https://api.2captcha.com";

type CaptchaType = "recaptcha-v2" | "recaptcha-v3" | "turnstile";

export type CaptchaInfo = {
  type: CaptchaType;
  siteKey: string;
  pageAction?: string;
  // reCAPTCHA Enterprise (v2/v3) は 2captcha 側で専用タスクが必要なため区別する
  isEnterprise?: boolean;
};

type CreateTaskResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
};

type TaskResultResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: "processing" | "ready";
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
};

async function createTask(task: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${BASE_URL}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: API_KEY, task }),
  });
  const data = (await res.json()) as CreateTaskResponse;
  if (data.errorId !== 0 || !data.taskId) {
    throw new Error(
      `2captcha createTask failed: ${data.errorCode ?? ""} ${data.errorDescription ?? ""}`.trim(),
    );
  }
  return data.taskId;
}

const CAPTCHA_POLL_TIMEOUT_MS = 120_000; // 2 minutes max

async function pollTaskResult(taskId: number): Promise<string> {
  const deadline = Date.now() + CAPTCHA_POLL_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    if (Date.now() >= deadline) {
      throw new Error(`2captcha polling timed out after ${CAPTCHA_POLL_TIMEOUT_MS / 1000}s (taskId=${taskId})`);
    }
    const res = await fetch(`${BASE_URL}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: API_KEY, taskId }),
    });
    const data = (await res.json()) as TaskResultResponse;
    if (data.errorId !== 0) {
      throw new Error(
        `2captcha getTaskResult failed: ${data.errorCode ?? ""} ${data.errorDescription ?? ""}`.trim(),
      );
    }
    if (data.status === "ready") {
      return data.solution?.gRecaptchaResponse ?? data.solution?.token ?? "";
    }
  }
}

// Detect which captcha (if any) is present on the current page.
// Checks Turnstile → reCAPTCHA v2 → reCAPTCHA v3 in priority order.
export async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  return await page.evaluate((): {
    type: "recaptcha-v2" | "recaptcha-v3" | "turnstile";
    siteKey: string;
    pageAction?: string;
    isEnterprise?: boolean;
  } | null => {
    // 1. Cloudflare Turnstile: div.cf-turnstile or data-widget-type=challenge
    const turnstileEl = document.querySelector<HTMLElement>(
      ".cf-turnstile[data-sitekey], [data-widget-type='challenge'][data-sitekey]",
    );
    if (turnstileEl) {
      const siteKey = turnstileEl.getAttribute("data-sitekey");
      if (siteKey) return { type: "turnstile", siteKey };
    }
    // Turnstile via iframe src
    for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))) {
      if (iframe.src.includes("challenges.cloudflare.com/turnstile")) {
        const parent = iframe.closest<HTMLElement>("[data-sitekey]");
        const siteKey = parent?.getAttribute("data-sitekey");
        if (siteKey) return { type: "turnstile", siteKey };
      }
    }

    // 2. reCAPTCHA v2: div.g-recaptcha with data-sitekey
    const v2El = document.querySelector<HTMLElement>(".g-recaptcha[data-sitekey]");
    if (v2El) {
      const siteKey = v2El.getAttribute("data-sitekey");
      if (siteKey) return { type: "recaptcha-v2", siteKey };
    }
    // v2 via iframe src (api2 / enterprise)
    for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))) {
      const isEnterprise = iframe.src.includes("/recaptcha/enterprise");
      if (
        iframe.src.includes("google.com/recaptcha/api2") ||
        iframe.src.includes("recaptcha.net/recaptcha/api2") ||
        isEnterprise
      ) {
        const parent = iframe.closest<HTMLElement>("[data-sitekey]");
        const siteKey = parent?.getAttribute("data-sitekey");
        if (siteKey) return { type: "recaptcha-v2", siteKey, isEnterprise };
      }
    }

    // 3. reCAPTCHA v3: script src with ?render=SITEKEY or inline grecaptcha.execute call
    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>("script"))) {
      const src = script.src ?? "";
      // Enterprise は enterprise.js を読み込む (api.js は通常版)
      const isEnterprise = src.includes("/recaptcha/enterprise.js") || src.includes("/enterprise.js");
      const srcMatch = src.match(/[?&]render=([^&]+)/);
      if (srcMatch?.[1] && srcMatch[1] !== "explicit") {
        return {
          type: "recaptcha-v3",
          siteKey: decodeURIComponent(srcMatch[1]),
          pageAction: "submit",
          isEnterprise,
        };
      }
      const content = script.textContent ?? "";
      // grecaptcha.execute(...) / grecaptcha.enterprise.execute(...)
      const inlineMatch = content.match(/grecaptcha(?:\.enterprise)?\.execute\(\s*['"]([^'"]+)['"]/);
      if (inlineMatch?.[1]) {
        const actionMatch = content.match(/[{,]\s*action\s*:\s*['"]([^'"]+)['"]/);
        return {
          type: "recaptcha-v3",
          siteKey: inlineMatch[1],
          pageAction: actionMatch?.[1] ?? "submit",
          isEnterprise: content.includes("grecaptcha.enterprise"),
        };
      }
    }

    return null;
  });
}

async function solve(websiteURL: string, info: CaptchaInfo): Promise<string> {
  let taskId: number;

  if (info.type === "recaptcha-v2") {
    // Enterprise 版は専用タスク (RecaptchaV2EnterpriseTaskProxyless) が必要
    taskId = await createTask({
      type: info.isEnterprise
        ? "RecaptchaV2EnterpriseTaskProxyless"
        : "RecaptchaV2TaskProxyless",
      websiteURL,
      websiteKey: info.siteKey,
    });
  } else if (info.type === "recaptcha-v3") {
    // Enterprise v3 は同じタスク型で isEnterprise: true を指定する
    taskId = await createTask({
      type: "RecaptchaV3TaskProxyless",
      websiteURL,
      websiteKey: info.siteKey,
      pageAction: info.pageAction ?? "submit",
      minScore: 0.7,
      isEnterprise: info.isEnterprise ?? false,
    });
  } else {
    // turnstile
    taskId = await createTask({
      type: "TurnstileTaskProxyless",
      websiteURL,
      websiteKey: info.siteKey,
    });
  }

  return await pollTaskResult(taskId);
}

async function injectToken(page: Page, info: CaptchaInfo, token: string): Promise<void> {
  if (info.type === "recaptcha-v2") {
    await page.evaluate((t) => {
      // Make the hidden textarea visible and set the token
      const textarea = document.querySelector<HTMLTextAreaElement>(
        "#g-recaptcha-response, textarea[name='g-recaptcha-response']",
      );
      if (textarea) {
        textarea.style.display = "block";
        textarea.value = t;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Fire the data-callback if defined on the widget div
      const container = document.querySelector<HTMLElement>(".g-recaptcha");
      const callbackName = container?.getAttribute("data-callback");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      if (callbackName && typeof win[callbackName] === "function") {
        win[callbackName](t);
      }
    }, token);
    return;
  }

  if (info.type === "recaptcha-v3") {
    await page.evaluate((t) => {
      // Override grecaptcha.execute so the site receives our pre-solved token
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      // 通常版・Enterprise 版どちらの execute/ready も差し替える
      for (const g of [win.grecaptcha, win.grecaptcha?.enterprise]) {
        if (!g) continue;
        g.execute = () => Promise.resolve(t);
        if (typeof g.ready === "function") {
          // Already ready — call immediately; some sites invoke execute inside ready()
          g.ready = (cb: () => void) => cb();
        }
      }
      // Fallback: set any hidden g-recaptcha-response field
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input[name='g-recaptcha-response'], textarea[name='g-recaptcha-response']",
      );
      if (el) {
        el.value = t;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, token);
    return;
  }

  // turnstile
  await page.evaluate((t) => {
    const input = document.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']");
    if (input) {
      input.value = t;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Fire data-callback if defined on the widget container
    const container = document.querySelector<HTMLElement>(".cf-turnstile");
    const callbackName = container?.getAttribute("data-callback");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    if (callbackName && typeof win[callbackName] === "function") {
      win[callbackName](t);
    }
    // Also try window.turnstile callback pattern
    if (win.turnstile?.execute) {
      try { win.turnstile.execute(); } catch { /* ignore */ }
    }
  }, token);
}

export type CaptchaSolveHandle = {
  info: CaptchaInfo;
  tokenPromise: Promise<string>;
};

/**
 * Detects any captcha on the page and starts solving it via 2captcha in the background.
 * Returns a handle to await later (via injectCaptchaToken), or null if:
 *   - TWOCAPTCHA_API_KEY is not set
 *   - no captcha is detected on the page
 */
export async function startCaptchaSolve(page: Page): Promise<CaptchaSolveHandle | null> {
  if (!API_KEY) return null;

  const info = await detectCaptcha(page);
  if (!info) return null;

  console.info(
    `[captcha-solver] detected ${info.type}${info.isEnterprise ? " (enterprise)" : ""} on ${page.url()} — solving via 2captcha`,
  );

  const websiteURL = page.url();
  const tokenPromise = solve(websiteURL, info).catch((err: unknown) => {
    console.warn("[captcha-solver] solve failed:", (err as Error).message ?? err);
    return "";
  });

  return { info, tokenPromise };
}

/**
 * Awaits the token from startCaptchaSolve and injects it into the page.
 * Call this just before clicking the submit button.
 * Returns true if a token was obtained and injected, false if solving
 * timed out / failed (caller can use this to classify the outcome).
 */
export async function injectCaptchaToken(
  page: Page,
  handle: CaptchaSolveHandle,
  maxWaitMs = 45_000,
): Promise<boolean> {
  // 解決完了を待つが、1社あたりの処理時間 (3分) を食い潰さないよう上限を設ける。
  // 上限超過時はトークン無しで送信を試みる (CAPTCHA 必須サイトはどのみち失敗するが、
  // CAPTCHA 検出が誤判定だったページを無駄に何十秒もブロックしないため)。
  const token = await Promise.race([
    handle.tokenPromise,
    new Promise<string>((resolve) => setTimeout(() => resolve(""), maxWaitMs)),
  ]);
  if (!token) {
    console.warn(`[captcha-solver] no token for ${handle.info.type} (solve failed or timed out)`);
    return false;
  }
  await injectToken(page, handle.info, token);
  console.info(`[captcha-solver] token injected for ${handle.info.type}`);
  return true;
}
