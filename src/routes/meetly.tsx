import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { CalendarDays, Info, LogOut, UserRound, WifiOff } from "lucide-react";
import { toast } from "sonner";

import { MeetlyAvatar } from "@/components/meetly/MeetlyAvatar";
import { MeetlyBrand } from "@/components/meetly/MeetlyBrand";
import {
  clearMeetlyCache,
  useMeetlyMe,
  useMeetlySessionGuard,
  useOnline,
} from "@/components/meetly/useMeetlySession";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { meetlyApi } from "@/lib/meetly/api";

export const Route = createFileRoute("/meetly")({
  component: MeetlyLayout,
  head: () => ({
    meta: [
      { title: "Meetly — Reuniões e videochamadas" },
      {
        name: "description",
        content:
          "Agende reuniões, convide participantes e entre na videochamada com um clique. Versão web do Meetly.",
      },
    ],
  }),
});

const navItems = [
  { to: "/meetly", label: "Reuniões", icon: CalendarDays, exact: true },
  { to: "/meetly/perfil", label: "Perfil", icon: UserRound, exact: false },
  { to: "/meetly/sobre", label: "Sobre", icon: Info, exact: false },
] as const;

/**
 * Casca do Meetly: cabeçalho com marca, navegação (o drawer do app Android)
 * e o menu do usuário. As páginas filhas decidem se exigem login.
 */
function MeetlyLayout() {
  useMeetlySessionGuard();
  const me = useMeetlyMe();
  const online = useOnline();
  const user = me.data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const logout = useMutation({
    mutationFn: meetlyApi.logout,
    onSuccess: () => {
      clearMeetlyCache(queryClient);
      toast.success("Você saiu do Meetly.");
      void navigate({ to: "/meetly/entrar" });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-card px-4 py-3">
        <Link to={user ? "/meetly" : "/meetly/entrar"} className="rounded-md outline-none">
          <MeetlyBrand />
        </Link>
        {user ? (
          <>
            <nav className="order-3 flex w-full gap-1 sm:order-none sm:w-auto sm:flex-1">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.exact }}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-[#00B7FF]/10 data-[status=active]:text-[#00B7FF]"
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              ))}
            </nav>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="ml-auto h-auto gap-2 px-2 py-1 sm:ml-0">
                  <MeetlyAvatar
                    name={user.displayName}
                    seed={user.id}
                    imageUrl={user.imageUrl}
                    className="h-8 w-8"
                  />
                  <span className="hidden max-w-[10rem] truncate text-sm sm:inline">
                    {user.displayName}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="truncate font-normal">
                  <span className="block truncate font-medium">{user.displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/meetly/perfil">
                    <UserRound className="h-4 w-4" /> Meu perfil
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => logout.mutate()}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="h-4 w-4" /> Sair
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </header>

      {!online ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
        >
          <WifiOff className="h-4 w-4" />
          Sem conexão com a internet. As alterações voltam a funcionar quando a conexão retornar.
        </div>
      ) : null}

      <Outlet />
    </div>
  );
}
