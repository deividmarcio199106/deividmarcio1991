import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthCard, FieldError } from "@/components/meetly/AuthCard";
import { meetlyGradient } from "@/components/meetly/MeetlyBrand";
import { clearMeetlyCache, useMeetlyMe } from "@/components/meetly/useMeetlySession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { meetlyApi, meetlyKeys } from "@/lib/meetly/api";
import { isValidEmail, MEETLY_LIMITS, normalizeEmail } from "@/lib/meetly/rules";

export const Route = createFileRoute("/meetly/entrar")({
  component: LoginPage,
  head: () => ({ meta: [{ title: "Entrar — Meetly" }] }),
});

/** LoginActivity: e-mail + senha, com as mesmas validações do app. */
function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMeetlyMe();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  useEffect(() => {
    if (me.data) void navigate({ to: "/meetly", replace: true });
  }, [me.data, navigate]);

  const login = useMutation({
    mutationFn: meetlyApi.login,
    onSuccess: (user) => {
      // Nada da conta anterior (outra pessoa no mesmo navegador) pode sobrar.
      // A consulta "me" fica (o cabeçalho a observa) e recebe o usuário novo.
      clearMeetlyCache(queryClient);
      queryClient.setQueryData(meetlyKeys.me, user);
      toast.success(`Bem-vindo de volta, ${user.displayName}!`);
      void navigate({ to: "/meetly" });
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = normalizeEmail(email);
    const found: typeof errors = {};
    if (!value) found.email = "Informe o e-mail!";
    else if (!isValidEmail(value)) found.email = "Informe um e-mail válido!";
    if (!password) found.password = "Informe a senha!";
    else if (password.length < MEETLY_LIMITS.passwordMin) found.password = "Senha muito curta!";
    setErrors(found);
    if (Object.keys(found).length === 0) login.mutate({ email: value, password });
  }

  return (
    <AuthCard
      title="Entrar"
      subtitle="Organize suas reuniões em um só lugar."
      footer={
        <>
          Não tem uma conta?{" "}
          <Link to="/meetly/cadastro" className="font-medium text-[#00B7FF] hover:underline">
            Cadastre-se
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-1.5">
          <Label htmlFor="login-email">E-mail</Label>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((c) => ({ ...c, email: undefined }));
            }}
            aria-invalid={Boolean(errors.email)}
            autoFocus
          />
          <FieldError message={errors.email} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="login-password">Senha</Label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErrors((c) => ({ ...c, password: undefined }));
            }}
            aria-invalid={Boolean(errors.password)}
          />
          <FieldError message={errors.password} />
        </div>
        <Button type="submit" className={`w-full ${meetlyGradient}`} disabled={login.isPending}>
          {login.isPending ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </AuthCard>
  );
}
