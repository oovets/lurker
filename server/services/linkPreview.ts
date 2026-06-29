// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Server-side link unfurling for the chat UI: given a URL, return a small
// preview card (title, description, thumbnail, site name). Fetching happens on
// the server so the browser dodges CORS, the result is cached, and we can guard
// against SSRF. Strategy mirrors imessage-tui's link_preview.go: provider oEmbed
// (Spotify/YouTube) → a general oEmbed proxy (noembed) → OpenGraph/Twitter-card
// HTML metadata.
//
// The client fetches these lazily (only for links scrolled into view), so this
// never runs across a whole backfilled history at once.

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  author?: string;
}

const FETCH_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 512 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const CACHE_MAX = 1000;
const UA = 'Mozilla/5.0 (compatible; LurkerLinkPreview/1.0; +https://github.com/amiantos/lurker)';

// Negative results cache too (null), so a dead/unsupported link isn't refetched
// on every render.
const cache = new Map<string, { at: number; preview: LinkPreview | null }>();

// Block obvious SSRF targets: non-http(s) schemes, loopback/private/link-local
// hosts, and bare hostnames. Not a substitute for egress firewalling, but stops
// the easy "fetch my LAN" cases. Note: this endpoint is authed (the user's own
// session), so the residual risk is a user probing their own network.
function blockedV4(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true; // private / loopback / unspecified
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}
function isBlockedHost(hostname: string): boolean {
  let h = hostname.toLowerCase().trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // strip IPv6 brackets
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

  // IPv6
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    // IPv4-mapped (::ffff:127.0.0.1 or ::ffff:7f00:1) — extract + check the v4 part.
    const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (dotted) return blockedV4(Number(dotted[1]), Number(dotted[2]));
    const mapped = /::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(h);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      return blockedV4((hi >> 8) & 255, hi & 255);
    }
    return false;
  }

  // Non-dotted numeric hostnames are alternate IPv4 encodings (decimal
  // 2130706433, hex 0x7f000001) that resolve to loopback/private — block them
  // wholesale; legitimate sites use names or dotted quads.
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true;

  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    // Leading-zero octets (octal) are suspicious encodings — reject.
    if ([m[1], m[2], m[3], m[4]].some((p) => p.length > 1 && p.startsWith('0'))) return true;
    return blockedV4(Number(m[1]), Number(m[2]));
  }
  return false;
}

function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;
  return u;
}

// Fetch with redirects followed MANUALLY so the SSRF host guard is re-applied to
// every hop — otherwise a guard-passing public URL could 302 to a private IP
// (e.g. cloud metadata) and bypass safeUrl(). Bounded hop count + timeout.
async function fetchWithTimeout(url: string, accept: string): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!safeUrl(current)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': UA, accept },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      try {
        current = new URL(loc, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null;
}

// open.spotify.com / youtube have first-party oEmbed endpoints with the best
// data; everything else goes through the general noembed proxy.
function oembedEndpointsFor(u: URL): string[] {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'open.spotify.com' || host === 'spotify.com')
    return ['https://open.spotify.com/oembed'];
  if (host.endsWith('youtube.com') || host === 'youtu.be')
    return ['https://www.youtube.com/oembed'];
  return ['https://noembed.com/embed'];
}

async function fromOEmbed(endpoint: string, target: string): Promise<LinkPreview | null> {
  const res = await fetchWithTimeout(
    `${endpoint}?format=json&url=${encodeURIComponent(target)}`,
    'application/json',
  );
  if (!res || !res.ok) return null;
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data.error) return null;
  const str = (k: string): string | undefined =>
    typeof data[k] === 'string' && (data[k] as string).trim() ? (data[k] as string) : undefined;
  const preview: LinkPreview = {
    url: target,
    title: str('title'),
    description: str('description'),
    image: str('thumbnail_url'),
    siteName: str('provider_name'),
    author: str('author_name'),
  };
  return preview.title || preview.image || preview.siteName ? preview : null;
}

function metaTag(html: string, attr: 'property' | 'name', key: string): string | undefined {
  // Match <meta property="og:title" content="..."> in either attribute order.
  const re = new RegExp(
    `<meta[^>]+(?:${attr}=["']${key}["'][^>]+content=["']([^"']*)["']|content=["']([^"']*)["'][^>]+${attr}=["']${key}["'])`,
    'i',
  );
  const m = re.exec(html);
  const raw = m?.[1] ?? m?.[2];
  return raw ? decodeEntities(raw).trim() || undefined : undefined;
}

function codePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fromHtml(target: string): Promise<LinkPreview | null> {
  const res = await fetchWithTimeout(target, 'text/html');
  if (!res || !res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return null;
  // Bounded read so a huge page can't blow up memory, then narrow to <head>
  // (where all the metadata lives) to shrink the regex surface on untrusted HTML.
  const buf = await res.arrayBuffer();
  const full = Buffer.from(buf.slice(0, MAX_HTML_BYTES)).toString('utf8');
  const headEnd = full.indexOf('</head>');
  const html = headEnd >= 0 ? full.slice(0, headEnd) : full;
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const preview: LinkPreview = {
    url: target,
    title:
      metaTag(html, 'property', 'og:title') ||
      metaTag(html, 'name', 'twitter:title') ||
      (titleTag ? decodeEntities(titleTag).trim() : undefined),
    description:
      metaTag(html, 'property', 'og:description') ||
      metaTag(html, 'name', 'twitter:description') ||
      metaTag(html, 'name', 'description'),
    image: metaTag(html, 'property', 'og:image') || metaTag(html, 'name', 'twitter:image'),
    siteName: metaTag(html, 'property', 'og:site_name'),
  };
  return preview.title || preview.image ? preview : null;
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  const u = safeUrl(rawUrl);
  if (!u) return null;
  const key = u.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.preview;

  let preview: LinkPreview | null = null;
  for (const endpoint of oembedEndpointsFor(u)) {
    preview = await fromOEmbed(endpoint, key);
    if (preview) break;
  }
  if (!preview) preview = await fromHtml(key);

  // Evict oldest on overflow (Map preserves insertion order).
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), preview });
  return preview;
}

// Exposed for tests.
export const _internal = { isBlockedHost, safeUrl, metaTag, oembedEndpointsFor };
