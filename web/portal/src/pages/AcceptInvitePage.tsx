import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AuthFrame } from "../ui/AuthFrame";
import { Field, PasswordField } from "../ui/Field";

export function AcceptInvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => api.invitation(token), enabled: Boolean(token) });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const accept = useMutation({
    mutationFn: () => api.acceptInvitation(token, name, password),
    onSuccess: () => navigate("/login"),
    onError: (err: Error) => setError(err.message),
  });

  if (invite.isError) {
    return (
      <AuthFrame kicker="Invitation" title="This invitation is not valid" lede="The link is missing, expired, or has already been used.">
        <Link className="btn btn-primary" to="/login">
          Back to sign in
        </Link>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      kicker="Invitation"
      title={`Join ${invite.data?.organisation.name ?? "this organisation"}`}
      lede={`You are invited as ${invite.data?.role.name ?? "a member"}. Create your account to continue.`}
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          accept.mutate();
        }}
      >
        {error ? (
          <div role="alert" className="alert alert-error">
            {error}
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">{invite.data?.email ?? "Your account"}</p>
        <Field label="Your name" htmlFor="invite-name">
          <input id="invite-name" className="input" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <PasswordField id="invite-password" label="Password" value={password} autoComplete="new-password" onChange={setPassword} />
        <button type="submit" className="btn btn-primary btn-block" disabled={accept.isPending || invite.isLoading}>
          {accept.isPending ? "Accepting..." : "Accept invitation"}
        </button>
      </form>
    </AuthFrame>
  );
}
