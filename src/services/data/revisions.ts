/**
 * Response revision gate.
 *
 * THE PROBLEM IT SOLVES. Every list endpoint ships a `revision` — monotonic per
 * collection — precisely so a client that has already applied revision N can
 * recognise a late response carrying N-1 and drop it. Without the check, a slow
 * response that lands after a faster one silently replaces fresher rows with
 * staler ones: the table looks fine, is simply wrong, and nothing reports it.
 *
 * WHY THE SCOPE IS THE COLLECTION, NOT THE PAGE. The mock server keeps one
 * counter per collection (`rankingRevision`, `matchesRevision`), so a page-2
 * response at revision 7 IS older than a page-1 response at revision 9 — the
 * gate must see them as the same stream to be able to compare them. Pages are
 * separate cache entries; revisions are not.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: fail. Discarding a stale response is not an
 * error the player should see, and it must not turn into an error panel. The
 * caller falls back to whatever is already cached — which is, by definition, the
 * fresher data this gate exists to protect.
 */

const applied = new Map<string, number>();

/** Named collections tracked by the gate. Matches the API's revision counters. */
export type RevisionScope = 'ranking' | 'matches';

/**
 * Records `revision` and reports whether it may be shown.
 *
 * Equal revisions are accepted: two reads at the same revision are equally
 * fresh, and rejecting one would keep the panel spinning for no gain.
 */
export const acceptRevision = (scope: RevisionScope, revision: number): boolean => {
  if (!Number.isFinite(revision)) return true; // Untrusted value: nothing to compare.

  const seen = applied.get(scope);
  if (seen !== undefined && revision < seen) return false;

  if (seen === undefined || revision > seen) applied.set(scope, revision);
  return true;
};

/** Highest revision applied for a scope — used by tests and diagnostics. */
export const appliedRevision = (scope: RevisionScope): number | undefined =>
  applied.get(scope);

/**
 * Forgets a scope so the next read is judged on its own.
 *
 * Called when the mock state is reset: the server restarts its counters, and a
 * remembered high revision would reject every response from the fresh server.
 */
export const forgetRevisions = (scope?: RevisionScope): void => {
  if (scope === undefined) applied.clear();
  else applied.delete(scope);
};
