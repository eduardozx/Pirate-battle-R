import type { MatchResult } from '../components/screens/MatchScreen';

/**
 * ============================================================================
 *  LAST RESULT — the outcome of the most recent completed match
 * ============================================================================
 *
 * WHY IT IS PERSISTED. The result screen is the only place the final score, the
 * duration and the end reason are ever shown, and it exists for a few seconds
 * before the player navigates away. A refresh — accidental or deliberate — must
 * not erase that, which is what "persist the result of the last completed match
 * locally" means in practice: the player closes the tab and the outcome is still
 * there when they come back.
 *
 * THE RESULT IS FORGETTABLE ON PURPOSE. Leaving the screen (Main Menu or Play
 * Again) clears it, so the next launch starts at the menu. It is a resume point,
 * not a trophy shelf: keeping it forever would mean every visit starts on a
 * result screen the player has already read.
 *
 * STORAGE IS TREATED AS UNTRUSTED. Every field is validated on read; anything
 * malformed degrades to "no stored result" rather than crashing the shell.
 */

const STORAGE_KEY = 'pb.result.v1';

const END_REASONS = new Set<MatchResult['endReason']>(['time_expired', 'player_destroyed']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isResult = (value: unknown): value is MatchResult => {
  if (!isRecord(value)) return false;
  return (
    typeof value['matchId'] === 'string' &&
    typeof value['score'] === 'number' &&
    Number.isFinite(value['score']) &&
    typeof value['durationMs'] === 'number' &&
    Number.isFinite(value['durationMs']) &&
    typeof value['endReason'] === 'string' &&
    END_REASONS.has(value['endReason'] as MatchResult['endReason']) &&
    typeof value['finishedAtIso'] === 'string' &&
    typeof value['seed'] === 'number'
  );
};

export function loadLastResult(): MatchResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isResult(parsed) ? parsed : null;
  } catch {
    // Private browsing, quota or corrupt JSON: behave as if nothing was stored.
    return null;
  }
}

export function saveLastResult(result: MatchResult): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    // A result that cannot be written simply does not survive a refresh.
  }
}

export function clearLastResult(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to recover from: the worst case is a stale result on next launch.
  }
}
