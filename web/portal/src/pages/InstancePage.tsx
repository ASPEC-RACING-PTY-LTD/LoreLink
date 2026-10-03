import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../api";
import { Field, PasswordField } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { ErrorAlert } from "../ui/states";
import type { ShellContext } from "./Shell";

export function InstancePage() {
  const { orgID } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const instance = useQuery({ queryKey: ["instance"], queryFn: api.instance });
  const users = useQuery({ queryKey: ["instance-users"], queryFn: api.instanceUsers });
  const roles = useQuery({ queryKey: ["roles"], queryFn: api.roles });
  const [toggleError, setToggleError] = useState("");
  const [formError, setFormError] = useState("");
  const [resetPath, setResetPath] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleID, setRoleID] = useState("");

  const togglePortal = useMutation({
    mutationFn: (portal_enabled: boolean) => api.patchInstance(portal_enabled),
    onSuccess: async () => {
      setToggleError("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["instance"] }),
        qc.invalidateQueries({ queryKey: ["me"] }),
      ]);
    },
    onError: (err: Error) => setToggleError(err.message),
  });

  const createUser = useMutation({
    mutationFn: () =>
      api.createUser({
        name: name.trim(),
        email: email.trim(),
        password,
        org_id: orgID || undefined,
        role_id: roleID || undefined,
      }),
    onSuccess: async () => {
      setName("");
      setEmail("");
      setPassword("");
      setFormError("");
      await qc.invalidateQueries({ queryKey: ["instance-users"] });
      await qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (err: Error) => setFormError(err.message),
  });

  async function refreshUsers() {
    await qc.invalidateQueries({ queryKey: ["instance-users"] });
    await qc.invalidateQueries({ queryKey: ["members"] });
    await qc.invalidateQueries({ queryKey: ["me"] });
  }

  if (instance.isError) {
    return (
      <div role="alert" className="alert alert-error">
        You do not have instance.admin.
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        crumbs={["Instance", "Administration"]}
        title={instance.data?.name ?? "Instance"}
        lede="Instance settings and the ASPEC user-management module. This view is limited to instance administrators."
      />

      <section className="panel mt-8 px-6 py-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Instance</h2>
        <dl className="mt-4 grid gap-5 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Public URL</dt>
            <dd className="mt-1 break-all font-mono text-sm">{instance.data?.public_base_url ?? "-"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Portal</dt>
            <dd className="mt-2 flex flex-wrap items-center gap-3">
              <span className="badge">{instance.data?.portal_enabled ? "enabled" : "disabled"}</span>
              <button
                type="button"
                className="btn btn-ghost"
                role="switch"
                aria-checked={Boolean(instance.data?.portal_enabled)}
                disabled={!instance.data || togglePortal.isPending}
                onClick={() => instance.data && togglePortal.mutate(!instance.data.portal_enabled)}
              >
                {togglePortal.isPending ? "Updating..." : instance.data?.portal_enabled ? "Disable portal" : "Enable portal"}
              </button>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Setup</dt>
            <dd className="mt-1">
              <span className="badge">{instance.data?.setup_completed ? "completed" : "open"}</span>
            </dd>
          </div>
        </dl>
      </section>
      {toggleError ? <ErrorAlert>{toggleError}</ErrorAlert> : null}

      <section className="panel mt-8 px-5 py-6 sm:px-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Create a user</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Creates an active account. If an organisation is selected, they are added with the chosen role.
        </p>
        <form
          className="mt-5 grid gap-3 lg:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            createUser.mutate();
          }}
        >
          <Field label="Name" htmlFor="new-user-name">
            <input id="new-user-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="new-user-email">
            <input id="new-user-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <PasswordField id="new-user-password" label="Password" value={password} onChange={setPassword} />
          <Field label="Organisation role" htmlFor="new-user-role">
            <select id="new-user-role" className="select" value={roleID} onChange={(e) => setRoleID(e.target.value)}>
              <option value="">Writer</option>
              {(roles.data?.roles ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="lg:col-span-2">
            <button type="submit" className="btn btn-primary" disabled={createUser.isPending || password.length < 10}>
              {createUser.isPending ? "Creating..." : "Create user"}
            </button>
          </div>
        </form>
        {formError ? <ErrorAlert>{formError}</ErrorAlert> : null}
        {resetPath ? (
          <div role="alert" className="alert alert-info mt-4">
            Password reset link: <span className="font-mono">{resetPath}</span>
          </div>
        ) : null}
      </section>

      <h2 className="mt-10 font-serif text-xl font-semibold tracking-tight">Users</h2>
      <p className="mt-1 text-sm text-muted-foreground">Suspend, activate, grant instance.admin, or issue a one-time reset token.</p>
      {users.isLoading ? (
        <div className="mt-6 flex items-center gap-3 text-muted-foreground">
          <span className="spinner" />
          Loading users
        </div>
      ) : (
        <div className="panel mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Instance grant</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="font-medium">{u.name}</div>
                    <div className="mt-1 font-mono text-sm text-muted-foreground">{u.email}</div>
                  </td>
                  <td>
                    <span className="badge">{u.status}</span>
                    {u.suspend_reason ? <div className="mt-1 text-xs text-muted-foreground">{u.suspend_reason}</div> : null}
                  </td>
                  <td>
                    <span className="badge">{u.instance_capabilities.includes("instance.admin") ? "instance.admin" : "none"}</span>
                  </td>
                  <td className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {u.status === "active" ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={async () => {
                            try {
                              await api.suspendUser(u.id, "Suspended by administrator");
                              await refreshUsers();
                            } catch (err) {
                              setFormError(err instanceof Error ? err.message : "could not suspend user");
                            }
                          }}
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={async () => {
                            try {
                              await api.activateUser(u.id);
                              await refreshUsers();
                            } catch (err) {
                              setFormError(err instanceof Error ? err.message : "could not activate user");
                            }
                          }}
                        >
                          Activate
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={async () => {
                          try {
                            const issued = await api.issuePasswordReset(u.id);
                            setResetPath(issued.path);
                            setFormError("");
                          } catch (err) {
                            setFormError(err instanceof Error ? err.message : "could not issue reset");
                          }
                        }}
                      >
                        Reset password
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={async () => {
                          try {
                            await api.setInstanceAdmin(u.id, !u.instance_capabilities.includes("instance.admin"));
                            await refreshUsers();
                          } catch (err) {
                            setFormError(err instanceof Error ? err.message : "could not update instance grant");
                          }
                        }}
                      >
                        {u.instance_capabilities.includes("instance.admin") ? "Remove admin" : "Make admin"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
