import { useMemo } from 'react';

import type { GameConfig } from '../../game/config/gameConfig';
import type { GameOptions } from '../../store/optionsStore';
import { matchConfigSummary } from '../api/configFingerprint';
import type { SubmitMatchRequest } from '../api/contracts';
import { outbox } from './outboxStore';
import { playerStore } from '../../store/playerStore';

/**
 * Match submission.
 *
 * Builds the payload and hands it to the outbox. Nothing here awaits the network:
 * the player must be able to press "Play Again" immediately, online or not.
 *
 * `matchId` is generated at match START (not here) so it is stable across
 * refreshes — see `MatchScreen`. That stability is what makes the submission
 * idempotent.
 */

export interface BuildSubmissionArgs {
  readonly matchId: string;
  readonly score: number;
  readonly effectiveDurationMs: number;
  readonly endReason: SubmitMatchRequest['endReason'];
  readonly finishedAtIso: string;
  readonly seed: number;
  readonly config: GameConfig;
  readonly options: GameOptions;
}

export const buildMatchSubmission = ({
  matchId,
  score,
  effectiveDurationMs,
  endReason,
  finishedAtIso,
  seed,
  config,
  options,
}: BuildSubmissionArgs): SubmitMatchRequest => {
  const profile = playerStore.getSnapshot();
  const summary = matchConfigSummary(config, options.sessionSeconds, options.spawnIntervalSeconds);

  return {
    schemaVersion: 1,
    matchId,
    playerId: profile.playerId,
    playerName: profile.playerName,
    score,
    effectiveDurationMs,
    endReason,
    configFingerprint: summary.fingerprint,
    configSnapshot: config,
    finishedAtIso,
    seed,
  };
};

/**
 * Queues a completed match and immediately attempts delivery.
 *
 * @returns the queued item, so the result screen can show live status.
 */
export const submitCompletedMatch = (payload: SubmitMatchRequest): void => {
  outbox.enqueue(payload);
  // Fire and forget: delivery failures are surfaced through the outbox, not here.
  void outbox.flush().catch(() => undefined);
};

/** Fingerprint of the current configuration, for the ranking filter. */
export const useConfigFingerprint = (config: GameConfig, options: GameOptions): string =>
  useMemo(
    () => matchConfigSummary(config, options.sessionSeconds, options.spawnIntervalSeconds).fingerprint,
    [config, options.sessionSeconds, options.spawnIntervalSeconds],
  );
