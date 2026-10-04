import { useCallback, useId, useState } from 'react';

import {
  OPTIONS_LIMITS,
  useOptions,
  useOptionsActions,
  type GameOptions,
  type OptionErrors,
  type OptionField,
  type OptionsStore,
} from '../../store/optionsStore';

/**
 * Options form.
 *
 * Validation is inline and immediate, errors are wired through `aria-invalid`
 * + `aria-describedby` so they are announced rather than merely coloured, and
 * every value is clamped against the documented limits.
 *
 * Options persist to localStorage through the store, so they survive a refresh.
 * The running match is unaffected: it snapshotted the config when it started.
 */

export interface OptionsScreenProps {
  readonly store: OptionsStore;
  readonly onBack: () => void;
}

interface FieldSpec {
  readonly field: OptionField;
  readonly label: string;
  readonly hint: string;
  readonly unit: string;
}

const FIELDS: readonly FieldSpec[] = [
  {
    field: 'sessionSeconds',
    label: 'Game session time',
    hint: 'Total active match duration.',
    unit: 'seconds',
  },
  {
    field: 'spawnIntervalSeconds',
    label: 'Enemy spawn time',
    hint: 'Average delay between enemy waves.',
    unit: 'seconds',
  },
];

export function OptionsScreen({ store, onBack }: OptionsScreenProps): JSX.Element {
  const options = useOptions(store);
  const actions = useOptionsActions(store);
  const [errors, setErrors] = useState<OptionErrors>({});
  const headingId = useId();

  const handleChange = useCallback(
    (field: OptionField, raw: string) => {
      const error = actions.setField(field, raw);
      setErrors((current) => {
        const next = { ...current };
        if (error === null) delete next[field];
        else next[field] = error;
        return next;
      });
    },
    [actions],
  );

  const handleReset = useCallback(() => {
    actions.reset();
    setErrors({});
  }, [actions]);

  return (
    <div className="screen screen--center" data-testid="options-screen">
      <div className="panel">
        <h1 className="panel__title" id={headingId}>
          Options
        </h1>

        <form className="form" onSubmit={(event) => event.preventDefault()}>
          {FIELDS.map((spec) => {
            const limits = OPTIONS_LIMITS[spec.field];
            const fieldId = `option-${spec.field}`;
            const errorId = `${fieldId}-error`;
            const hintId = `${fieldId}-hint`;
            const error = errors[spec.field];

            return (
              <div className="form__field" key={spec.field}>
                <label className="form__label" htmlFor={fieldId}>
                  {spec.label}
                </label>
                <div className="form__control">
                  <input
                    id={fieldId}
                    className="form__input"
                    type="number"
                    inputMode="decimal"
                    min={limits.min}
                    max={limits.max}
                    step={limits.step}
                    value={String(options[spec.field])}
                    aria-invalid={error !== undefined}
                    aria-describedby={error !== undefined ? `${hintId} ${errorId}` : hintId}
                    data-testid={fieldId}
                    onChange={(event) => handleChange(spec.field, event.target.value)}
                  />
                  <span className="form__unit">{spec.unit}</span>
                </div>
                <p className="form__hint" id={hintId}>
                  {spec.hint} Allowed range: {limits.min}–{limits.max} {spec.unit}.
                </p>
                {error !== undefined && (
                  <p className="form__error" id={errorId} role="alert">
                    {error}
                  </p>
                )}
              </div>
            );
          })}

          <p className="form__note">
            Changes apply to the next match. A match in progress keeps the settings it
            started with.
          </p>

          <div className="panel__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={handleReset}
              data-testid="options-reset"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={onBack}
              data-testid="options-back"
            >
              Back
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export type { GameOptions };
