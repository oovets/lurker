// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Implementation moved to shared/ so server + client share one copy. This
// re-export keeps the local import path (./textMatch.js) stable.
export * from '../../shared/textMatch.js';
