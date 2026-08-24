import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, BookOpen, Brain, Dna, FlaskConical, HeartPulse, ImageUp } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * Navegação do analisador.
 *
 * O menu encolheu DE NOVO a pedido do operador (18/08): Operação ao Vivo,
 * Erros/Diagnóstico, Claude Admin, Configurações e Gerenciamento saíram —
 * como Dashboard e Backtest antes deles. As ROTAS continuam existindo e
 * acessíveis por URL: o que mudou foi a navegação, não o sistema. O resumo
 * útil do Gerenciamento passou a viver dentro do Analisar Print, que é onde
 * a decisão acontece; /gerenciamento segue sendo o lugar de editar.
 */
const items = [
  { title: "Analisar Print", url: "/analisar-print", icon: ImageUp },
  { title: "Analisador", url: "/analisador", icon: Activity },
  { title: "Aprendizado", url: "/aprendizado", icon: Brain },
  { title: "DNA T4", url: "/dna-t4", icon: Dna },
  { title: "Biblioteca", url: "/biblioteca", icon: BookOpen },
  { title: "Pesquisa T4", url: "/pesquisa", icon: FlaskConical },
  { title: "Saúde", url: "/saude", icon: HeartPulse },
] as const;

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 px-2 py-2.5">
          {/* Logotipo tipográfico NEXUS: monograma com barra cyan. */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/10 nexus-glow-cyan">
            <span className="font-display text-sm font-bold text-primary">N</span>
          </div>
          {!collapsed && (
            <div className="leading-tight">
              <p className="font-display text-sm font-bold tracking-[0.18em] text-foreground">
                NEXUS
              </p>
              <p className="text-[9px] uppercase tracking-[0.22em] text-primary/80">
                Trading Intelligence
              </p>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Operação</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                // A raiz saiu do menu, então nenhum item é mais o prefixo de
                // todos: `startsWith` basta e não marca tudo como ativo.
                const active = pathname.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link
                        to={item.url}
                        className={
                          "relative flex items-center gap-2 transition-colors " +
                          (active
                            ? "text-primary before:absolute before:-left-2 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary before:shadow-[0_0_8px_var(--color-primary)]"
                            : "hover:text-foreground")
                        }
                      >
                        <item.icon className="h-4 w-4" />
                        {!collapsed && <span>{item.title}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
