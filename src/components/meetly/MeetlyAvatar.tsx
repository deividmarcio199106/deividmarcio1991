import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/meetly/format";
import { MEETLY_COLORS } from "@/lib/meetly/rules";
import { cn } from "@/lib/utils";

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return MEETLY_COLORS[hash % MEETLY_COLORS.length]!;
}

/** Foto do usuário ou, sem foto, as iniciais numa cor fixa por pessoa. */
export function MeetlyAvatar({
  name,
  seed,
  imageUrl,
  className,
}: {
  name: string;
  seed: string;
  imageUrl?: string;
  className?: string;
}) {
  return (
    <Avatar className={cn("h-9 w-9", className)}>
      {imageUrl ? <AvatarImage src={imageUrl} alt={name} className="object-cover" /> : null}
      <AvatarFallback
        className="font-semibold text-white"
        style={{ backgroundColor: colorFor(seed) }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
