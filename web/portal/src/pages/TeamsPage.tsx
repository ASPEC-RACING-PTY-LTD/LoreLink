import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../api";
import { Field } from "../ui/Field";
import { IconPlus } from "../ui/icons";
import { PageHeader } from "../ui/PageHeader";
import { EmptyPanel, ErrorAlert, LoadingLine } from "../ui/states";
import type { ShellContext } from "./Shell";

export function TeamsPage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const teams = useQuery({
    queryKey: ["teams", orgID],
    queryFn: () => api.teams(orgID),
    enabled: Boolean(orgID),
  });
  const members = useQuery({
    queryKey: ["members", orgID],
    queryFn: () => api.members(orgID),
    enabled: Boolean(orgID),
  });
  const [selectedID, setSelectedID] = useState("");
  const [name, setName] = useState("");
  const [userID, setUserID] = useState("");
  const [error, setError] = useState("");

  const selected = useMemo(
    () => teams.data?.teams.find((t) => t.id === selectedID) ?? teams.data?.teams[0],
    [selectedID, teams.data],
  );

  const teamMembers = useQuery({
    queryKey: ["team-members", orgID, selected?.id],
    queryFn: () => api.teamMembers(orgID, selected?.id ?? ""),
    enabled: Boolean(orgID && selected?.id),
  });

  const create = useMutation({
    mutationFn: () => api.createTeam(orgID, name.trim()),
    onSuccess: async (team) => {
      setName("");
      setError("");
      setSelectedID(team.id);
      await qc.invalidateQueries({ queryKey: ["teams", orgID] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const addMember = useMutation({
    mutationFn: () => api.addTeamMember(orgID, selected?.id ?? "", userID),
    onSuccess: async () => {
      setUserID("");
      setError("");
      await qc.invalidateQueries({ queryKey: ["team-members", orgID, selected?.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const available = (members.data?.members ?? []).filter(
    (member) => !(teamMembers.data?.members ?? []).some((tm) => tm.id === member.id),
  );

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Teams"]}
        title="Teams"
        lede="Group organisation members for project work. Teams do not replace organisation roles."
      />

      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {teams.isLoading ? <LoadingLine label="Loading teams" /> : null}
      {teams.isError ? <ErrorAlert>{teams.error.message}</ErrorAlert> : null}

      <section className="panel mt-8 px-5 py-6 sm:px-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Create a team</h2>
        <form
          className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            create.mutate();
          }}
        >
          <Field label="Name" htmlFor="team-name">
            <input
              id="team-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary" disabled={create.isPending || !name.trim()}>
              <IconPlus />
              {create.isPending ? "Creating..." : "Create team"}
            </button>
          </div>
        </form>
      </section>

      {teams.data && teams.data.teams.length === 0 ? (
        <EmptyPanel title="No teams yet">Create a team, then add organisation members to it.</EmptyPanel>
      ) : null}

      {teams.data && teams.data.teams.length > 0 ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_1fr]">
          <aside className="panel overflow-hidden">
            <p className="border-b border-border px-4 py-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Teams
            </p>
            <ul>
              {teams.data.teams.map((team) => (
                <li key={team.id}>
                  <button
                    type="button"
                    className={selected?.id === team.id ? "nav-link nav-link-active w-full" : "nav-link w-full"}
                    onClick={() => setSelectedID(team.id)}
                  >
                    {team.name}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section>
            <h2 className="font-serif text-xl font-semibold tracking-tight">{selected?.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Members of this team.</p>

            <form
              className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (!userID) return;
                setError("");
                addMember.mutate();
              }}
            >
              <Field label="Organisation member" htmlFor="team-user">
                <select id="team-user" className="select" value={userID} onChange={(e) => setUserID(e.target.value)}>
                  <option value="">Select a member</option>
                  {available.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} ({member.email})
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end">
                <button type="submit" className="btn btn-primary" disabled={addMember.isPending || !userID}>
                  {addMember.isPending ? "Adding..." : "Add member"}
                </button>
              </div>
            </form>

            {teamMembers.isLoading ? <LoadingLine label="Loading team members" /> : null}
            {teamMembers.isError ? <ErrorAlert>{teamMembers.error.message}</ErrorAlert> : null}
            {teamMembers.data && teamMembers.data.members.length === 0 ? (
              <p className="mt-6 text-sm text-muted-foreground">This team has no members yet.</p>
            ) : null}
            {teamMembers.data && teamMembers.data.members.length > 0 ? (
              <div className="panel mt-6 overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamMembers.data.members.map((member) => (
                      <tr key={member.id}>
                        <td>
                          <div className="font-medium">{member.name}</div>
                          <div className="mt-1 font-mono text-sm text-muted-foreground">{member.email}</div>
                        </td>
                        <td>
                          <span className="badge">{member.status || "active"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
