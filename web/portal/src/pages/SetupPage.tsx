import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { AuthFrame } from "../ui/AuthFrame";
import { Field, PasswordField } from "../ui/Field";

const steps = [
  {
    label: "Instance",
    title: "Name this instance",
    lede: "The instance name appears in the portal header. The public URL is used for canonical links and can be changed later.",
  },
  {
    label: "Administrator",
    title: "Create the first administrator",
    lede: "This account signs in after setup and receives instance.admin. The password must be at least 10 characters.",
  },
  {
    label: "Organisation",
    title: "Create the first organisation",
    lede: "Projects and members live inside an organisation. You can invite people after you sign in.",
  },
];

export function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    instance_name: "LoreLink",
    public_url: window.location.origin,
    admin_name: "",
    admin_email: "",
    admin_password: "",
    organisation_name: "",
    organisation_slug: "",
  });

  const mutation = useMutation({
    mutationFn: () => api.setup(form),
    onSuccess: () => navigate("/login"),
    onError: (err: Error) => setError(err.message),
  });

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function next() {
    setError("");
    if (step === 0 && !form.instance_name.trim()) {
      setError("Give the instance a name.");
      return;
    }
    if (step === 1 && (!form.admin_name || !form.admin_email || form.admin_password.length < 10)) {
      setError("Administrator name, email, and a password of at least 10 characters are required.");
      return;
    }
    if (step === 2) {
      mutation.mutate();
      return;
    }
    setStep((s) => s + 1);
  }

  const current = steps[step];

  return (
    <AuthFrame kicker="First-run setup" title={current.title} lede={current.lede}>
      <ol className="grid grid-cols-3 gap-2 text-xs font-medium tracking-wide uppercase">
        {steps.map((item, i) => (
          <li key={item.label} className={i <= step ? "text-foreground" : "text-muted-foreground"}>
            <span className={`mb-1 block h-1 rounded-full ${i <= step ? "bg-accent" : "bg-border"}`} />
            {i + 1}. {item.label}
          </li>
        ))}
      </ol>

      <div className="mt-8 grid gap-4">
        {error ? (
          <div role="alert" className="alert alert-error">
            {error}
          </div>
        ) : null}
        {step === 0 ? (
          <>
            <Field label="Instance name" htmlFor="instance-name">
              <input id="instance-name" className="input" value={form.instance_name} onChange={(e) => set("instance_name", e.target.value)} />
            </Field>
            <Field label="Public URL" htmlFor="public-url" hint="Used for canonical links. You can change this later.">
              <input id="public-url" className="input" value={form.public_url} onChange={(e) => set("public_url", e.target.value)} />
            </Field>
          </>
        ) : null}
        {step === 1 ? (
          <>
            <Field label="Name" htmlFor="admin-name">
              <input id="admin-name" className="input" value={form.admin_name} autoComplete="name" onChange={(e) => set("admin_name", e.target.value)} />
            </Field>
            <Field label="Email" htmlFor="admin-email">
              <input
                id="admin-email"
                className="input"
                type="email"
                value={form.admin_email}
                autoComplete="username"
                onChange={(e) => set("admin_email", e.target.value)}
              />
            </Field>
            <PasswordField
              id="admin-password"
              label="Password"
              value={form.admin_password}
              autoComplete="new-password"
              onChange={(value) => set("admin_password", value)}
            />
            <p className="text-sm text-muted-foreground">At least 10 characters. This account receives instance.admin.</p>
          </>
        ) : null}
        {step === 2 ? (
          <>
            <Field label="Organisation name" htmlFor="org-name">
              <input id="org-name" className="input" value={form.organisation_name} onChange={(e) => set("organisation_name", e.target.value)} />
            </Field>
            <Field label="Slug (optional)" htmlFor="org-slug">
              <input id="org-slug" className="input" value={form.organisation_slug} onChange={(e) => set("organisation_slug", e.target.value)} />
            </Field>
          </>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <button type="button" className="btn btn-ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={next} disabled={mutation.isPending}>
            {step === 2 ? (mutation.isPending ? "Creating..." : "Create instance") : "Continue"}
          </button>
        </div>
        <p className="text-sm text-muted-foreground">This route closes after the first administrator is created.</p>
      </div>
    </AuthFrame>
  );
}
