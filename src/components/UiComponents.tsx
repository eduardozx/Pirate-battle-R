import { type ReactNode, type ButtonHTMLAttributes } from 'react';

/* ==========================================================================
   Pure CSS UI Components — zero spritesheet dependency
   ========================================================================== */

/* --------------------------------------------------------------------- Panel */
export interface UiPanelProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  logicalWidth?: number;
  logicalHeight?: number;
}

export function UiPanel({
  children,
  className,
  style,
  logicalWidth = 620,
  logicalHeight = 520,
}: UiPanelProps): JSX.Element {
  return (
    <div
      className={`panel panel--menu ${className ?? ''}`}
      style={{
        ...style,
        width: `min(${logicalWidth}px, 100%)`,
        maxWidth: '100%',
        minHeight: logicalHeight,
      }}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------- Buttons */
interface BaseButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  type?: 'button' | 'submit' | 'reset';
}

export function UiPrimaryButton(
  props: BaseButtonProps & ButtonHTMLAttributes<HTMLButtonElement>
): JSX.Element {
  const { children, onClick, disabled, className, style, 'aria-label': ariaLabel, type = 'button', ...rest } = props;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`button button--primary ${className ?? ''}`}
      style={{
        ...style,
        minWidth: 180,
      }}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  );
}

export function UiSecondaryButton(
  props: BaseButtonProps & ButtonHTMLAttributes<HTMLButtonElement>
): JSX.Element {
  const { children, onClick, disabled, className, style, 'aria-label': ariaLabel, type = 'button', ...rest } = props;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`button button--secondary ${className ?? ''}`}
      style={{
        ...style,
        minWidth: 180,
      }}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  );
}

export function UiRoundButton(
  props: BaseButtonProps & {
    onPointerDown?: () => void;
    onPointerUp?: () => void;
    onPointerLeave?: () => void;
    onPointerCancel?: () => void;
  } & ButtonHTMLAttributes<HTMLButtonElement>
): JSX.Element {
  const {
    children,
    onClick,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
    disabled,
    className,
    style,
    'aria-label': ariaLabel,
    ...rest
  } = props;

  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      disabled={disabled}
      className={`button button--round ${className ?? ''}`}
      style={{
        ...style,
      }}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------- Title Logo */
export function UiTitle({ style, className }: { style?: React.CSSProperties; className?: string }): JSX.Element {
  return (
    <img
      src="/assets/png/default/ui/menu/title_pirate_battle.png"
      alt="Pirate Battle"
      className={className}
      style={{
        display: 'block',
        margin: '0 auto 18px',
        width: 384,
        height: 128,
        ...style,
      }}
    />
  );
}