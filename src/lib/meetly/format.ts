/** Formatação de data/hora das reuniões em pt-BR. */

function parseIsoDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** "ter., 3 de nov. de 2026" */
export function formatMeetingDate(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  return parsed.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "03/11/2026" */
export function formatShortDate(date: string): string {
  const parsed = parseIsoDate(date);
  return parsed ? parsed.toLocaleDateString("pt-BR") : date;
}

/** Instante local de início da reunião, para separar próximas e passadas. */
export function meetingStart(date: string, time: string): number {
  const parsed = parseIsoDate(date);
  if (!parsed) return 0;
  const [h, m] = time.split(":").map(Number);
  parsed.setHours(h ?? 0, m ?? 0, 0, 0);
  return parsed.getTime();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}
