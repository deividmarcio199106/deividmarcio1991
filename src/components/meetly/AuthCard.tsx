import type { ReactNode } from "react";

import { MeetlyLogo } from "./MeetlyBrand";

/** Moldura das telas de login e cadastro. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md py-4">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
        <div className="bg-linear-to-r from-[#00B7FF] to-[#0341FB] px-6 py-6 text-white">
          <div className="flex items-center gap-3">
            <MeetlyLogo className="h-11 w-11 rounded-xl" />
            <div>
              <h1 className="font-display text-2xl font-bold">{title}</h1>
              <p className="text-sm text-white/85">{subtitle}</p>
            </div>
          </div>
        </div>
        <div className="space-y-5 px-6 py-6">{children}</div>
      </div>
      <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}
