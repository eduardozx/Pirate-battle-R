import { useSyncExternalStore } from 'react';

import type { PlayerProfile } from '../services/api/contracts';

/**
 * Local player identity.
 *
 * The game is single-player, so identity is a stable anonymous profile per
 * browser rather than an account. It is generated once and persisted, because the
 * match history query filters on `playerId`: regenerating it on every load would
 * orphan the player's own history.
 */

const STORAGE_KEY = 'pb.player.v1';

const ADJECTIVES = ['Silent', 'Iron', 'Copper', 'Salt', 'Storm', 'Black', 'Silver', 'Amber'] as const;
const NOUNS = ['Tide', 'Keel', 'Sail', 'Wake', 'Squall', 'Gull', 'Reef', 'Wind'] as const;

const generateProfile = (): PlayerProfile => {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;
  const id =
    globalThis.crypto?.randomUUID?.() ?? `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { playerId: id, playerName: `${pick(ADJECTIVES)} ${pick(NOUNS)}` };
};

const read = (): PlayerProfile => {
  if (typeof localStorage === 'undefined') return generateProfile();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const id = record['playerId'];
        const name = record['playerName'];
        if (typeof id === 'string' && id !== '' && typeof name === 'string' && name !== '') {
          return { playerId: id, playerName: name };
        }
      }
    }
  } catch {
    // Corrupt or unavailable storage falls through to a fresh profile.
  }

  const profile = generateProfile();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Private mode: the profile simply does not survive a refresh.
  }
  return profile;
};

class PlayerStore {
  private readonly profile: PlayerProfile = read();

  getSnapshot = (): PlayerProfile => this.profile;

  subscribe = (): (() => void) => () => undefined;
}

export const playerStore = new PlayerStore();

export const usePlayer = (): PlayerProfile =>
  useSyncExternalStore(playerStore.subscribe, playerStore.getSnapshot, playerStore.getSnapshot);
