import * as React from "react";

import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Visual invalid state (adds destructive ring). */
  invalid?: boolean;
}

/** A styled single-line text input. */
const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, invalid, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn("flex h-10 w-full rounded-md border px-3 py-2", invalid && "ring-destructive", className)}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
