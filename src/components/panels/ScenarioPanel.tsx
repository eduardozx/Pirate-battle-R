import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { SCENARIOS } from '../../services/msw/scenarios';
import { resetMockServer, selectScenario } from '../../services/msw/browser';
import { resetMockState } from '../../services/outbox/outboxStore';
import { forgetRevisions } from '../../services/data/revisions';
import { scenarioRuntime } from '../../services/msw/handlers';
import { useOutbox, useSubmitMatchesMutation } from '../../services/data/queries';

/**
 * Scenario selector.
 *
 * The brief requires "a way to select scenarios and restore the initial state".
 * This panel is that control: pick a network condition, watch the current
 * submission queue, and reset everything back to the starting point.
 *
 * Selecting a scenario invalidates both record queries, so switching from
 * "success" to "http-500" shows the error state immediately rather than on the
 * next natural refetch.
 */
export function ScenarioPanel(): ReactNode {
  const queryClient = useQueryClient();
  const items = useOutbox();
  const retry = useSubmitMatchesMutation();
  const [activeId, setActiveId] = useState(scenarioRuntime.active.id);

  const pending = items.filter((item) => item.status !== 'confirmed');
  const confirmed = items.filter((item) => item.status === 'confirmed');

  const apply = (id: string): void => {
    setActiveId(selectScenario(id));
    void queryClient.invalidateQueries({ queryKey: ['ranking'] });
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
  };

  const handleReset = (): void => {
    /* ORDER MATTERS, and it used to be the other way round.
       `resetMockState` empties the queue and the query cache; `resetMockServer`
       then restores the DEFAULT scenario and re-seeds the fixtures. Reversed,
       the record store ended up wiped AFTER the re-seed — "reset" deleted the
       demo ranking instead of restoring it. */
    resetMockState();
    resetMockServer();
    /* The mock server restarts its revision counters with the fresh fixtures, so
       the gate's memory of higher revisions has to go with it — otherwise every
       response from the reset server would look stale and the panels would keep
       showing data that no longer exists. */
    forgetRevisions();
    setActiveId(scenarioRuntime.active.id);
    void queryClient.invalidateQueries({ queryKey: ['ranking'] });
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
  };

  return (
    <section className="scenarios" aria-label="Network scenarios" data-testid="scenario-panel">
      <h3 className="scenarios__title">Network scenarios</h3>

      <div className="scenarios__row">
        <label className="scenarios__label" htmlFor="scenario-select">
          Scenario
        </label>
        <select
          id="scenario-select"
          className="scenarios__select"
          value={activeId}
          onChange={(event) => apply(event.target.value)}
          data-testid="scenario-select"
        >
          {SCENARIOS.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.label}
            </option>
          ))}
        </select>
      </div>

      <p className="scenarios__description" data-testid="scenario-description">
        {SCENARIOS.find((scenario) => scenario.id === activeId)?.description}
      </p>

      <div className="scenarios__queue" data-testid="outbox-summary">
        <span>
          Pending submissions: <strong data-testid="pending-count">{pending.length}</strong>
        </span>
        <span>
          Confirmed: <strong data-testid="confirmed-count">{confirmed.length}</strong>
        </span>
      </div>

      {pending.length > 0 && (
        <ul className="scenarios__items">
          {pending.slice(0, 4).map((item) => (
            <li key={item.matchId}>
              <code>{item.matchId.slice(0, 8)}</code> · {item.status} · {item.attempts} attempt
              {item.attempts === 1 ? '' : 's'}
              {item.lastError !== null ? ` — ${item.lastError}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="scenarios__actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => retry.mutate()}
          data-testid="flush-outbox"
        >
          Retry now
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={handleReset}
          data-testid="reset-mocks"
        >
          Reset mock state
        </button>
      </div>
    </section>
  );
}
