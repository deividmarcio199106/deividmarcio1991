import { cn } from "@/lib/utils";

/** Gradiente do app original (gradient_toolbar: #00B7FF → #0341FB). */
export const meetlyGradient =
  "bg-linear-to-r from-[#00B7FF] to-[#0341FB] text-white shadow hover:opacity-90 transition-opacity";

export function MeetlyLogo({ className }: { className?: string }) {
  return (
    <img
      src="/meetly/logo.png"
      alt=""
      width={36}
      height={36}
      className={cn("h-9 w-9 shrink-0 rounded-lg", className)}
    />
  );
}

export function MeetlyBrand({ subtitle = true }: { subtitle?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <MeetlyLogo />
      <div className="leading-tight">
        <p className="font-display text-lg font-bold tracking-wide text-foreground">Meetly</p>
        {subtitle ? (
          <p className="text-[10px] uppercase tracking-[0.18em] text-[#00B7FF]">
            Reuniões e videochamadas
          </p>
        ) : null}
      </div>
    </div>
  );
}
