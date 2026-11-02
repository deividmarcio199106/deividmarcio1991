import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthCard, FieldError } from "@/components/meetly/AuthCard";
import { meetlyGradient } from "@/components/meetly/MeetlyBrand";
import { useMeetlyMe } from "@/components/meetly/useMeetlySession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { meetlyApi, meetlyKeys } from "@/lib/meetly/api";
import { isValidEmail, MEETLY_LIMITS, normalizeEmail } from "@/lib/meetly/rules";

export const Route = createFileRoute("/meetly/cadastro")({
  component: RegisterPage,
  head: () => ({ meta: [{ title: "Criar conta — Meetly" }] }),
});

type Errors = { name?: string; email?: string; password?: string };

/** RegisterActivity: nome, e-mail e senha (mínimo de 6 caracteres). */
function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMeetlyMe();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    if (me.data) void navigate({ to: "/meetly", replace: true });
  }, [me.data, navigate]);

  const register = useMutation({
    mutationFn: meetlyApi.register,
    onSuccess: (user) => {
      queryClient.setQueryData(meetlyKeys.me, user);
      toast.success("Cadastro concluído com sucesso!");
      void navigate({ to: "/meetly" });
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = normalizeEmail(email);
    const found: Errors = {};
    if (!name.trim()) found.name = "Informe um nome!";
    if (!value) found.email = "Informe um e-mail!";
    else if (!isValidEmail(value)) found.email = "Informe um e-mail válido!";
    if (!password) found.password = "Informe a senha!";
    else if (password.length < MEETLY_LIMITS.passwordMin) {
      found.password = `A senha precisa ter pelo menos ${MEETLY_LIMITS.passwordMin} caracteres!`;
    }
    setErrors(found);
    if (Object.keys(found).length === 0) {
      register.mutate({ name: name.trim(), email: value, password });
    }
  }

  return (
    <AuthCard
      title="Criar conta"
      subtitle="Leva menos de um minuto."
      footer={
        <>
          Já tem uma conta?{" "}
          <Link to="/meetly/entrar" className="font-medium text-[#00B7FF] hover:underline">
            Entrar
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-1.5">
          <Label htmlFor="register-name">Nome</Label>
          <Input
            id="register-name"
            autoComplete="name"
            value={name}
            maxLength={MEETLY_LIMITS.nameMax}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((c) => ({ ...c, name: undefined }));
            }}
            aria-invalid={Boolean(errors.name)}
            autoFocus
          />
          <FieldError message={errors.name} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="register-email">E-mail</Label>
          <Input
            id="register-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((c) => ({ ...c, email: undefined }));
            }}
            aria-invalid={Boolean(errors.email)}
          />
          <FieldError message={errors.email} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="register-password">Senha</Label>
          <Input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErrors((c) => ({ ...c, password: undefined }));
            }}
            aria-invalid={Boolean(errors.password)}
          />
          <FieldError message={errors.password} />
        </div>
        <Button type="submit" className={`w-full ${meetlyGradient}`} disabled={register.isPending}>
          {register.isPending ? "Criando conta…" : "Cadastrar"}
        </Button>
      </form>
    </AuthCard>
  );
}
