// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { api } from '../api.js';
import { useSlackEmojiStore } from './slackEmoji.js';

vi.mock('../api.js', () => ({ api: vi.fn<() => Promise<unknown>>() }));
const mockApi = vi.mocked(api);

beforeEach(() => {
  setActivePinia(createPinia());
  mockApi.mockReset();
});

describe('useSlackEmojiStore', () => {
  it('fetches a network map once and resolves url()', async () => {
    mockApi.mockResolvedValue({ emoji: { parrot: 'https://e/p.gif', lurker: 'https://e/l.png' } });
    const store = useSlackEmojiStore();

    await store.ensure(7);
    await store.ensure(7); // second call must not re-fetch

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith('/api/networks/7/slack-emoji');
    expect(store.url(7, 'parrot')).toBe('https://e/p.gif');
    expect(store.url(7, 'nope')).toBeNull();
    expect(store.url(null, 'parrot')).toBeNull();
  });

  it('ranks custom-emoji matches for the autocomplete', async () => {
    mockApi.mockResolvedValue({
      emoji: {
        party_parrot: 'https://e/pp.gif',
        partyhat: 'https://e/ph.gif',
        sadcat: 'https://e/s.gif',
      },
    });
    const store = useSlackEmojiStore();
    await store.ensure(1);

    const names = store.search(1, 'party').map((m) => m.name);
    expect(names).toContain('party_parrot');
    expect(names).toContain('partyhat');
    expect(names).not.toContain('sadcat');
    expect(store.search(1, 'party')[0]).toHaveProperty('url');
  });

  it('returns empty + null for an un-fetched network', () => {
    const store = useSlackEmojiStore();
    expect(store.search(99, 'x')).toEqual([]);
    expect(store.url(99, 'x')).toBeNull();
  });
});
