import type { Page } from "playwright";

// CAPTCHA 解決プロバイダ。CAPSOLVER_API_KEY があれば CapSolver を優先 (v3/Turnstile の
// スコアが高く成功率が良い)、無ければ TWOCAPTCHA_API_KEY で 2captcha を使う。
// どちらの API も createTask/getTaskResult が clientKey + task 形式でほぼ共通。
type CaptchaType = "recaptcha-v2" | "recaptcha-v3" | "turnstile";

type Provider = {
  name: string;
  baseUrl: string;
  clientKey: string;
  // CAPTCHA 種別ごとに createTask 用の task オブジェクトを組み立てる (型名がベンダ差異)。
  // proxy 指定時は ProxyLess ではなく住宅プロキシ経由で解き、v3 スコアを底上げする。
  task: (websiteURL: string, info: CaptchaInfo, proxy?: string | null) => Record<string, unknown>;
};

// 住宅プロキシ (CapSolver の proxy フィールド用) を env から組み立てる。
// PROXY_SERVER="http://host:port" + PROXY_USERNAME/PROXY_PASSWORD → "scheme://user:pass@host:port"。
export function capsolverProxyFromEnv(): string | null {
  const server = process.env["PROXY_SERVER"];
  if (!server) return null;
  const user = process.env["PROXY_USERNAME"] ?? "";
  const pass = process.env["PROXY_PASSWORD"] ?? "";
  try {
    const u = new URL(server);
    const scheme = (u.protocol || "http:").replace(":", "");
    const hostport = u.host; // host:port
    if (!hostport) return null;
    return user && pass
      ? `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${hostport}`
      : `${scheme}://${hostport}`;
  } catch {
    return null;
  }
}

function selectProvider(): Provider | null {
  const capsolver = process.env["CAPSOLVER_API_KEY"];
  const twocaptcha = process.env["TWOCAPTCHA_API_KEY"];
  if (capsolver) {
    return {
      name: "capsolver",
      baseUrl: "https://api.capsolver.com",
      clientKey: capsolver,
      task: (websiteURL, info, proxy) => {
        // proxy 指定時は住宅プロキシ経由 (非ProxyLess) で解き、v3 スコアを底上げする。
        const px = proxy ? { proxy } : {};
        const pl = proxy ? "" : "ProxyLess";
        if (info.type === "recaptcha-v2")
          return {
            type: info.isEnterprise ? `ReCaptchaV2EnterpriseTask${pl}` : `ReCaptchaV2Task${pl}`,
            websiteURL,
            websiteKey: info.siteKey,
            ...px,
          };
        if (info.type === "recaptcha-v3")
          return {
            type: info.isEnterprise ? `ReCaptchaV3EnterpriseTask${pl}` : `ReCaptchaV3Task${pl}`,
            websiteURL,
            websiteKey: info.siteKey,
            pageAction: info.pageAction ?? "submit",
            ...px,
          };
        return {
          type: proxy ? "AntiTurnstileTask" : "AntiTurnstileTaskProxyLess",
          websiteURL,
          websiteKey: info.siteKey,
          ...px,
        };
      },
    };
  }
  if (twocaptcha) {
    return {
      name: "2captcha",
      baseUrl: "https://api.2captcha.com",
      clientKey: twocaptcha,
      task: (websiteURL, info) => {
        if (info.type === "recaptcha-v2")
          return {
            type: info.isEnterprise
              ? "RecaptchaV2EnterpriseTaskProxyless"
              : "RecaptchaV2TaskProxyless",
            websiteURL,
            websiteKey: info.siteKey,
          };
        if (info.type === "recaptcha-v3")
          return {
            type: "RecaptchaV3TaskProxyless",
            websiteURL,
            websiteKey: info.siteKey,
            pageAction: info.pageAction ?? "submit",
            minScore: 0.7,
            isEnterprise: info.isEnterprise ?? false,
          };
        return { type: "TurnstileTaskProxyless", websiteURL, websiteKey: info.siteKey };
      },
    };
  }
  return null;
}

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
  // 2captcha は数値、CapSolver は文字列(UUID)を返す
  taskId?: string | number;
};

type TaskResultResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: "processing" | "ready" | "failed";
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
};

async function createTask(
  provider: Provider,
  task: Record<string, unknown>,
): Promise<string | number> {
  const res = await fetch(`${provider.baseUrl}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: provider.clientKey, task }),
  });
  const data = (await res.json()) as CreateTaskResponse;
  if (data.errorId !== 0 || data.taskId == null) {
    throw new Error(
      `${provider.name} createTask failed: ${data.errorCode ?? ""} ${data.errorDescription ?? ""}`.trim(),
    );
  }
  return data.taskId;
}

const CAPTCHA_POLL_TIMEOUT_MS = 120_000; // 2 minutes max

async function pollTaskResult(provider: Provider, taskId: string | number): Promise<string> {
  const deadline = Date.now() + CAPTCHA_POLL_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    if (Date.now() >= deadline) {
      throw new Error(
        `${provider.name} polling timed out after ${CAPTCHA_POLL_TIMEOUT_MS / 1000}s (taskId=${taskId})`,
      );
    }
    const res = await fetch(`${provider.baseUrl}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: provider.clientKey, taskId }),
    });
    const data = (await res.json()) as TaskResultResponse;
    // errorId だけでなく status="failed" でも即失敗にする (CapSolver はこちらで返すことがある)。
    if (data.errorId !== 0 || data.status === "failed") {
      throw new Error(
        `${provider.name} getTaskResult failed: ${data.errorCode ?? ""} ${data.errorDescription ?? ""}`.trim(),
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
        // Contact Form 7 は action "contactform" を使う。検証時のアクション不一致を避ける。
        const isCf7 =
          !!document.querySelector("input[name='_wpcf7_recaptcha_response']") ||
          typeof (window as unknown as { wpcf7_recaptcha?: unknown }).wpcf7_recaptcha !==
            "undefined";
        return {
          type: "recaptcha-v3",
          siteKey: decodeURIComponent(srcMatch[1]),
          pageAction: isCf7 ? "contactform" : "submit",
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

    // 4. レンダリング済み reCAPTCHA の anchor/bframe iframe から sitekey (k=) を抽出。
    //    「protected by reCAPTCHA」バッジだけ出る invisible 型や、GTM/タグ経由で
    //    動的注入され script src の render= では拾えないケースを救う (ユーザ要件)。
    for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))) {
      const m = iframe.src.match(
        /recaptcha\/(?:enterprise|api2)\/(?:anchor|bframe)[^"']*[?&]k=([^&"']+)/,
      );
      if (m?.[1]) {
        const siteKey = decodeURIComponent(m[1]);
        const isEnterprise = iframe.src.includes("/enterprise/");
        // 可視チェックボックス (data-size!=invisible の g-recaptcha) があれば v2、
        // バッジのみ / invisible 指定なら v3 相当として扱う。
        const visibleCheckbox = document.querySelector<HTMLElement>(
          '.g-recaptcha:not([data-size="invisible"])',
        );
        const badge = document.querySelector(".grecaptcha-badge");
        const invisible = document.querySelector('.g-recaptcha[data-size="invisible"]');
        if (visibleCheckbox && !invisible) {
          return { type: "recaptcha-v2", siteKey, isEnterprise };
        }
        if (badge || invisible) {
          return { type: "recaptcha-v3", siteKey, pageAction: "submit", isEnterprise };
        }
        // 判別不能でもキーは取れている — v2 として解く (token を textarea へ注入)
        return { type: "recaptcha-v2", siteKey, isEnterprise };
      }
    }

    return null;
  });
}

async function solve(
  websiteURL: string,
  info: CaptchaInfo,
  proxy?: string | null,
): Promise<string> {
  const provider = selectProvider();
  if (!provider) throw new Error("no captcha provider configured");
  // proxy は capsolver のみ対応 (2captcha は別フィールド体系のため未対応 → ProxyLess)。
  const px = provider.name === "capsolver" ? proxy : null;
  const taskId = await createTask(provider, provider.task(websiteURL, info, px));
  return await pollTaskResult(provider, taskId);
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
      // 通常版・Enterprise 版どちらの execute/ready も差し替える。サイトが送信時に
      // execute() を呼び直しても必ず我々のトークンが返るようにする。
      for (const g of [win.grecaptcha, win.grecaptcha?.enterprise]) {
        if (!g) continue;
        g.execute = () => Promise.resolve(t);
        if (typeof g.ready === "function") {
          // Already ready — call immediately; some sites invoke execute inside ready()
          g.ready = (cb: () => void) => cb();
        }
      }
      // トークンを格納し得る hidden フィールドを総当たりで設定する。
      //  - g-recaptcha-response: 標準
      //  - _wpcf7_recaptcha_response: Contact Form 7 (日本で最多) の v3 連携フィールド
      //  - name に recaptcha/token/captcha を含む hidden 欄も保険で設定
      // 注: page.evaluate 内では名前付き内部関数を使わない (esbuild keepNames の __name で
      //     ブラウザ側 ReferenceError になるため)。for-of でインライン処理する。
      const fields = document.querySelectorAll(
        "input[name='g-recaptcha-response'], textarea[name='g-recaptcha-response'], " +
          "input[name='_wpcf7_recaptcha_response'], " +
          "input[name*='recaptcha' i][type='hidden'], input[name*='captcha' i][type='hidden']",
      );
      for (const el of Array.from(fields)) {
        const f = el as HTMLInputElement | HTMLTextAreaElement;
        f.value = t;
        f.dispatchEvent(new Event("input", { bubbles: true }));
        f.dispatchEvent(new Event("change", { bubbles: true }));
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
 * Detects any captcha on the page and starts solving it in the background.
 * Returns a handle to await later (via injectCaptchaToken), or null if:
 *   - no captcha provider key (CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY) is set
 *   - no captcha is detected on the page
 */
export async function startCaptchaSolve(
  page: Page,
  opts?: { useResidentialProxy?: boolean },
): Promise<CaptchaSolveHandle | null> {
  const provider = selectProvider();
  if (!provider) return null;

  const info = await detectCaptcha(page);
  if (!info) return null;

  const proxy = opts?.useResidentialProxy ? capsolverProxyFromEnv() : null;
  console.info(
    `[captcha-solver] detected ${info.type}${info.isEnterprise ? " (enterprise)" : ""} on ${page.url()} — solving via ${provider.name}${proxy ? " (residential proxy)" : ""}`,
  );

  const websiteURL = page.url();
  const tokenPromise = solve(websiteURL, info, proxy).catch((err: unknown) => {
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
