import { Icon } from "./Icon";

/** A clickable button with an optional leading icon. */
export function Button({
  variant = "primary",
  disabled,
  icon,
  onClick,
  children,
}: {
  /** Visual variant. */
  variant?: "primary" | "secondary" | "danger";
  /** Disables interaction. */
  disabled: boolean;
  /** Optional leading icon (any ReactNode). */
  icon?: unknown;
  onClick?: (event: { id: string }) => void;
  children?: unknown;
}) {
  return (
    <button disabled={disabled} data-variant={variant}>
      {icon ?? <Icon name="none" />}
      {children}
    </button>
  );
}
