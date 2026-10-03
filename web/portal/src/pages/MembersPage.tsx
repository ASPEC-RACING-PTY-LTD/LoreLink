import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../api";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import type { ShellContext } from "./Shell";

export function MembersPage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members", orgID], queryFn: () => api.members(orgID), enabled: Boolean(orgID) });
  const roles = useQuery({ queryKey: ["roles"], queryFn: api.roles });
  const [email, setEmail] = useState("");
  const [roleID, setRoleID] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [error, setError] = useState("");

  const invite = useMutation({
    mutationFn: () => api.invite(orgID, email, roleID || roles.data?.roles.find((r) => r.name === "Writer")?.id || ""),
    onSuccess: async (res) => {
      setInviteToken(res.token);
      setEmail("");
      await qc.invalidateQueries({ queryKey: ["members", orgID] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Members"]}
        title="Members"
        lede="Invite people with a capability preset. Invitations cannot grant instance.admin."
      />

      <section className="panel mt-8 px-5 py-6 sm:px-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Invite a member</h2>
        <p className="mt-1 text-sm text-muted-foreground">They receive a tokenised link. Share it out of band.</p>
        <form
          className="mt-5 grid gap-3 lg:grid-cols-[1fr_12rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            setInviteToken("");
            invite.mutate();
          }}
        >
          <Field label="Email" htmlFor="invite-email">
            <input
              id="invite-email"
              className="input"
              type="email"
              required
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <select id="invite-role" className="select" value={roleID} onChange={(e) => setRoleID(e.target.value)}>
              <option value="">Writer</option>
              {roles.data?.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary" disabled={invite.isPending}>
              {invite.isPending ? "Inviting..." : "Invite"}
            </button>
          </div>
        </form>
        {error ? (
          <div role="alert" className="alert alert-error mt-4">
            {error}
          </div>
        ) : null}
        {inviteToken ? (
          <div role="alert" className="alert alert-info mt-4">
            Invitation created. Share <span className="font-mono">/invite/{inviteToken}</span>
          </div>
        ) : null}
      </section>

      {members.isLoading ? (
        <div className="mt-8 flex items-center gap-3 text-muted-foreground">
          <span className="spinner" />
          Loading members
        </div>
      ) : (
        <div className="panel mt-6 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Instance</th>
              </tr>
            </thead>
            <tbody>
              {members.data?.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="font-medium">{m.name}</div>
                    <div className="mt-1 font-mono text-sm text-muted-foreground">{m.email}</div>
                  </td>
                  <td>
                    <span className="badge">{m.role?.name}</span>
                  </td>
                  <td className="text-sm text-muted-foreground">
                    {m.instance_capabilities.includes("instance.admin") ? "instance admin" : "member"}
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
