import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Camera, KeyRound, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { toast } from "sonner";

import { FieldError } from "@/components/meetly/AuthCard";
import { MeetlyAvatar } from "@/components/meetly/MeetlyAvatar";
import { meetlyGradient } from "@/components/meetly/MeetlyBrand";
import { useRequireMeetlyUser } from "@/components/meetly/useMeetlySession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { meetlyApi, meetlyKeys } from "@/lib/meetly/api";
import { isValidPhone, MEETLY_LIMITS } from "@/lib/meetly/rules";
import type { MeetlyUser } from "@/lib/meetly/types";

export const Route = createFileRoute("/meetly/perfil")({
  component: ProfilePage,
  head: () => ({ meta: [{ title: "Meu perfil — Meetly" }] }),
});

const AVATAR_SIZE = 192;

/**
 * Reduz a foto escolhida para 192×192 (recorte central) e devolve um data URL
 * JPEG pequeno — o Firebase Storage do app vira um campo no próprio banco.
 */
async function resizeImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Não foi possível ler esta imagem."));
      img.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Seu navegador não conseguiu processar a imagem.");
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** UserProfile: foto, nome, telefone — e a troca de senha. */
function ProfilePage() {
  const { user } = useRequireMeetlyUser();
  if (!user) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">Meu perfil</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <ProfileForm user={user} />
        <PasswordForm />
      </div>
    </div>
  );
}

function ProfileForm({ user }: { user: MeetlyUser }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [phone, setPhone] = useState(user.phone);
  const [imageUrl, setImageUrl] = useState(user.imageUrl);
  const [errors, setErrors] = useState<{ displayName?: string; phone?: string }>({});

  useEffect(() => {
    setDisplayName(user.displayName);
    setPhone(user.phone);
    setImageUrl(user.imageUrl);
  }, [user]);

  const save = useMutation({
    mutationFn: meetlyApi.updateProfile,
    onSuccess: (updated) => {
      queryClient.setQueryData(meetlyKeys.me, updated);
      // Nome e foto aparecem nas listas de participantes.
      void queryClient.invalidateQueries({ queryKey: ["meetly", "meeting"] });
      toast.success("Perfil atualizado com sucesso!");
    },
    onError: (error) => toast.error(error.message),
  });

  async function pickImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Escolha um arquivo de imagem.");
      return;
    }
    try {
      const resized = await resizeImage(file);
      if (resized.length > MEETLY_LIMITS.imageMaxChars) {
        toast.error("Imagem grande demais. Tente outra.");
        return;
      }
      setImageUrl(resized);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível usar esta imagem.");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!displayName.trim()) found.displayName = "Informe o nome!";
    if (!isValidPhone(phone.trim())) found.phone = "Use só números, espaços, +, ( ) e -.";
    setErrors(found);
    if (Object.keys(found).length === 0) {
      save.mutate({ displayName: displayName.trim(), phone: phone.trim(), imageUrl });
    }
  }

  const dirty =
    displayName !== user.displayName || phone !== user.phone || imageUrl !== user.imageUrl;

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
      noValidate
    >
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
          aria-label="Trocar foto de perfil"
        >
          <MeetlyAvatar
            name={displayName || user.displayName}
            seed={user.id}
            imageUrl={imageUrl}
            className="h-20 w-20 text-xl"
          />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Camera className="h-6 w-6 text-white" />
          </span>
        </button>
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            <Camera /> Trocar foto
          </Button>
          {imageUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setImageUrl("")}
            >
              <Trash2 /> Remover foto
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void pickImage(e)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="profile-name">Nome</Label>
        <Input
          id="profile-name"
          value={displayName}
          maxLength={MEETLY_LIMITS.nameMax}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setErrors((c) => ({ ...c, displayName: undefined }));
          }}
          aria-invalid={Boolean(errors.displayName)}
        />
        <FieldError message={errors.displayName} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="profile-email">E-mail</Label>
        <Input id="profile-email" value={user.email} readOnly disabled />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="profile-phone">Telefone</Label>
        <Input
          id="profile-phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          maxLength={MEETLY_LIMITS.phoneMax}
          onChange={(e) => {
            setPhone(e.target.value);
            setErrors((c) => ({ ...c, phone: undefined }));
          }}
          aria-invalid={Boolean(errors.phone)}
          placeholder="+55 11 99999-0000"
        />
        <FieldError message={errors.phone} />
      </div>
      <Button
        type="submit"
        className={`mt-auto ${meetlyGradient}`}
        disabled={save.isPending || !dirty}
      >
        <Save /> {save.isPending ? "Salvando…" : "Salvar alterações"}
      </Button>
    </form>
  );
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();

  const change = useMutation({
    mutationFn: meetlyApi.changePassword,
    onSuccess: () => {
      toast.success("Senha alterada! Outras sessões abertas foram encerradas.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    },
    onError: (err) => setError(err.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!currentPassword) return setError("Informe a senha atual.");
    if (newPassword.length < MEETLY_LIMITS.passwordMin) {
      return setError(
        `A nova senha precisa ter pelo menos ${MEETLY_LIMITS.passwordMin} caracteres.`,
      );
    }
    if (newPassword !== confirm) return setError("A confirmação não confere com a nova senha.");
    setError(undefined);
    change.mutate({ currentPassword, newPassword });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
      noValidate
    >
      <div>
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <KeyRound className="h-5 w-5 text-[#00B7FF]" /> Alterar senha
        </h2>
        <p className="text-sm text-muted-foreground">
          Ao trocar a senha, as outras sessões abertas são encerradas.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password-current">Senha atual</Label>
        <Input
          id="password-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password-new">Nova senha</Label>
        <Input
          id="password-new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password-confirm">Confirmar nova senha</Label>
        <Input
          id="password-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <FieldError message={error} />
      <Button type="submit" variant="outline" className="mt-auto" disabled={change.isPending}>
        <KeyRound /> {change.isPending ? "Alterando…" : "Alterar senha"}
      </Button>
    </form>
  );
}
