import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AuthFrame } from "../ui/AuthFrame";
import { Field, PasswordField } from "../ui/Field";

export function ResetPage() {
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () => api.resetPassword(token, password),
    onSuccess: () => navigate("/login"),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <AuthFrame
      kicker="Account"
      title="Set a new password"
      lede="Use the one-time token your administrator issued from User management."
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
        <Field label="Reset token" htmlFor="reset-token">
          <input id="reset-token" className="input" value={token} readOnly />
        </Field>
        <PasswordField id="reset-password" label="New password" value={password} onChange={setPassword} />
        <button type="submit" className="btn btn-primary btn-block" disabled={mutation.isPending || password.length < 10}>
          {mutation.isPending ? "Saving..." : "Update password"}
        </button>
      </form>
    </AuthFrame>
  );
}
