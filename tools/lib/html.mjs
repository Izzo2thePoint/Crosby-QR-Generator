// Minimal HTML helpers. Deliberately dependency-free so the tool runs on a
// stock Node install with nothing to `npm install` at the dealership.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-',
  mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...',
  eacute: 'e', egrave: 'e', agrave: 'a', ccedil: 'c', trade: '', reg: '', copy: ''
};

export function decodeEntities(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** Returns the inner text of every <script> whose type attribute matches. */
export function scriptBlocks(html, typeMatcher) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const typeMatch = /type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';
    if (!typeMatcher || typeMatcher(type, attrs)) out.push(m[2]);
  }
  return out;
}

/** Every href on the page, resolved against baseUrl, with its anchor text. */
export function anchors(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = absoluteUrl(decodeEntities(m[2]), baseUrl);
    if (!href) continue;
    out.push({ href, text: stripTags(m[4]), raw: m[0] });
  }
  return out;
}

export function absoluteUrl(href, baseUrl) {
  if (!href) return '';
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel):/i.test(trimmed)) return '';
  try { return new URL(trimmed, baseUrl).toString(); } catch { return ''; }
}

/** Pulls `content` out of the first matching <meta> tag. */
export function metaContent(html, nameOrProperty) {
  const re = new RegExp(
    `<meta\\b[^>]*(?:name|property|itemprop)\\s*=\\s*["']${escapeRe(nameOrProperty)}["'][^>]*>`,
    'i'
  );
  const tag = re.exec(html);
  if (!tag) return '';
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag[0]);
  return content ? decodeEntities(content[1]) : '';
}

export function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
