// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { isImageUrl } from './uploadHostMatch.js';

describe('isImageUrl', () => {
  it('matches image URLs on any host', () => {
    expect(isImageUrl('https://example.com/abc.png')).toBe(true);
  });

  it('matches image extensions case-insensitively', () => {
    expect(isImageUrl('https://files.catbox.moe/abc.JPG')).toBe(true);
  });

  it('matches image paths with query strings', () => {
    expect(isImageUrl('https://files.catbox.moe/abc.png?v=2')).toBe(true);
  });

  it('matches image extensions in the middle of the path', () => {
    expect(
      isImageUrl(
        'https://static.wikia.nocookie.net/onepiece/images/6/6d/Luffy.png/revision/latest?cb=20240306200817',
      ),
    ).toBe(true);
  });

  it('matches mid-path extensions case-insensitively', () => {
    expect(isImageUrl('https://example.com/path/foo.JPG/transform/x')).toBe(true);
  });

  it('rejects URLs without image extensions', () => {
    expect(isImageUrl('https://files.catbox.moe/abc.txt')).toBe(false);
  });

  it('does not match extension-like substrings without dot and segment boundaries', () => {
    expect(isImageUrl('https://example.com/png-guide')).toBe(false);
    expect(isImageUrl('https://example.com/image-png/foo')).toBe(false);
    expect(isImageUrl('https://example.com/foo.png-extra/bar')).toBe(false);
  });

  it('matches image URLs on previously unsupported hosts', () => {
    expect(isImageUrl('https://imgur.com/abc.png')).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isImageUrl('not a url')).toBe(false);
  });
});
