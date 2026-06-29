// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLinkPreview, _internal } from './linkPreview.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type FetchFn = (url: string) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    headers: new Map([['content-type', 'application/json']]),
    json: async () => body,
  } as unknown as Response;
}
function htmlResponse(html: string): Response {
  return {
    ok: true,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  } as unknown as Response;
}

describe('link preview SSRF guard', () => {
  it('blocks loopback / private / link-local hosts and non-http schemes', () => {
    const { safeUrl, isBlockedHost } = _internal;
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('10.1.2.3')).toBe(true);
    expect(isBlockedHost('192.168.0.111')).toBe(true);
    expect(isBlockedHost('172.16.5.5')).toBe(true);
    expect(isBlockedHost('169.254.1.1')).toBe(true);
    expect(isBlockedHost('example.com')).toBe(false);
    expect(safeUrl('ftp://example.com')).toBeNull();
    expect(safeUrl('http://192.168.0.111/secret')).toBeNull();
    expect(safeUrl('https://example.com/x')).not.toBeNull();
    // Alternate IP encodings that resolve to loopback / private must be blocked.
    expect(isBlockedHost('2130706433')).toBe(true); // decimal 127.0.0.1
    expect(isBlockedHost('0x7f000001')).toBe(true); // hex 127.0.0.1
    expect(isBlockedHost('0177.0.0.1')).toBe(true); // octal-ish
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true); // ipv4-mapped
    expect(isBlockedHost('169.254.169.254')).toBe(true); // cloud metadata
  });

  it('does not follow a redirect to a private IP', async () => {
    const fetchMock = vi.fn<FetchFn>(
      async () =>
        ({
          status: 302,
          headers: {
            get: (k: string) =>
              k.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null,
          },
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchLinkPreview('https://example.com/open-redirector')).toBeNull();
    // The first hop was attempted, but the private redirect target was never fetched.
    for (const call of fetchMock.mock.calls) expect(String(call[0])).not.toContain('169.254');
  });

  it('returns null without fetching for a blocked url', async () => {
    const fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchLinkPreview('http://127.0.0.1:1234/api')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('link preview providers', () => {
  it('uses YouTube oEmbed for a youtube url', async () => {
    const fetchMock = vi.fn<FetchFn>(async (url: string) => {
      expect(url).toContain('youtube.com/oembed');
      return jsonResponse({
        title: 'Rick Astley - Never Gonna Give You Up',
        thumbnail_url: 'https://img.youtube.com/x.jpg',
        provider_name: 'YouTube',
        author_name: 'Rick Astley',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = await fetchLinkPreview('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(p).toMatchObject({
      title: 'Rick Astley - Never Gonna Give You Up',
      image: 'https://img.youtube.com/x.jpg',
      siteName: 'YouTube',
      author: 'Rick Astley',
    });
  });

  it('falls back to OpenGraph HTML metadata when oEmbed yields nothing', async () => {
    const html = `<html><head>
      <meta content="Allsvenskan &#x1f9f1; &#064;handle" property="og:title">
      <meta property="og:description" content="It is &amp; remains great">
      <meta property="og:image" content="https://news.example/og.png">
      <meta property="og:site_name" content="Example News">
    </head></html>`;
    const fetchMock = vi.fn<FetchFn>(async (url: string) =>
      url.includes('noembed.com') ? jsonResponse({ error: 'no provider' }) : htmlResponse(html),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = await fetchLinkPreview('https://news.example.com/article-xyz');
    expect(p).toMatchObject({
      // Numeric HTML entities decode: &#x1f9f1; → 🧱, &#064; → @.
      title: 'Allsvenskan 🧱 @handle',
      description: 'It is & remains great',
      image: 'https://news.example/og.png',
      siteName: 'Example News',
    });
  });

  it('parses meta tags in either attribute order', () => {
    const { metaTag } = _internal;
    const a = '<meta property="og:title" content="Forward">';
    const b = '<meta content="Reversed" property="og:title">';
    expect(metaTag(a, 'property', 'og:title')).toBe('Forward');
    expect(metaTag(b, 'property', 'og:title')).toBe('Reversed');
  });
});
