import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { AuthFrame } from "../ui/AuthFrame";
import { Field, PasswordField } from "../ui/Field";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <AuthFrame
      kicker="Portal"
      title="Sign in"
      lede="Use the administrator account from setup, or an invitation you have already accepted."
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          mutation.mutate();
        }}
      >
        {error ? (
          <div role="alert" className="alert alert-error">
            {error}
          </div>
        ) : null}
        <Field label="Email" htmlFor="login-email">
          <input
            id="login-email"
            className="input"
            type="email"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <PasswordField id="login-password" label="Password" value={password} onChange={setPassword} />
        <button type="submit" className="btn btn-primary btn-block" disabled={mutation.isPending}>
          {mutation.isPending ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        Invited? Open the invitation link from your administrator. Forgot your password? Ask an instance administrator to issue a reset token.
      </p>
    </AuthFrame>
  );
}
