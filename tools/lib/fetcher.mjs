// Polite, retrying HTML fetcher. One dealership website, a handful of pages a
// day - so we go slow, identify ourselves, and never hammer on failure.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36 CrosbyLabelStudio/1.0';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchHtml(url, { timeoutMs = 25000, retries = 2, retryDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-CA,en;q=0.9'
        }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
        error.status = response.status;
        // 4xx other than 429 will not fix itself on retry.
        if (response.status !== 429 && response.status < 500) throw Object.assign(error, { fatal: true });
        throw error;
      }
      return { html: await response.text(), finalUrl: response.url || url };
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}
