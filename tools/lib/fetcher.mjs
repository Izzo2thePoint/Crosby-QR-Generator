// Polite, retrying fetcher. One dealership website, a handful of requests a
// day - so we go slow, look like an ordinary browser, and back off on refusal.
//
// The site sits behind bot protection that intermittently answers 403 to a
// perfectly ordinary request. A refusal is therefore worth retrying: the same
// URL usually answers moments later.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36';

export const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 403 included deliberately: it is how the bot protection refuses, and it clears.
const WORTH_RETRYING = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export async function fetchHtml(url, { timeoutMs = 25000, retries = 4, retryDelayMs = 2000, headers } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...BROWSER_HEADERS, ...(headers || {}) }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        error.status = response.status;
        if (!WORTH_RETRYING.has(response.status)) throw Object.assign(error, { fatal: true });
        throw error;
      }
      return { html: await response.text(), finalUrl: response.url || url };
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries) break;
      // Grows on each attempt, with jitter so repeated runs do not line up.
      const wait = retryDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 750);
      await sleep(wait);
    }
  }
  throw lastError;
}
