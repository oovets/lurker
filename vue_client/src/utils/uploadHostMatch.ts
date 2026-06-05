// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'] as const;

export function isImageUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const path = parsed.pathname.toLowerCase();
  return IMAGE_EXTS.some((ext) => path.endsWith(ext) || path.includes(`${ext}/`));
}
