"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/actions";
import { cn } from "@/lib/utils";

type Action = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

export function SubmitButton({ children, variant, size, className, confirm }: {
  children: React.ReactNode;
  variant?: "default" | "outline" | "danger" | "success" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "Saving…" : children}
    </Button>
  );
}

/**
 * Form bound to a server action. Shows the action's error / success message
 * inline, never swallowing failures.
 */
export function ActionForm({ action, children, className, resetOnSuccess = false }: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {state ? (
        <p
          role={state.ok ? "status" : "alert"}
          className={cn(
            "mt-2 rounded-md px-3 py-2 text-sm",
            state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700",
          )}
        >
          {state.ok ? state.message ?? "Saved." : state.error}
        </p>
      ) : null}
    </form>
  );
}
