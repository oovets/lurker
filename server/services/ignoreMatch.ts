// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Implementation moved to shared/ so the insert-time stamp/push gate and the
// client render filter run the exact same code (no hand-mirrored drift). This
// re-export keeps the local import path (./ignoreMatch.js) stable.
export * from '../../shared/ignoreMatch.js';
