// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Implementation lives in shared/ so the client render filter and the server
// insert-time/push logic run one shared copy. This re-export keeps the local
// import path (../utils/ignoreMatch.js) stable.
export * from '../../../shared/ignoreMatch.js';
