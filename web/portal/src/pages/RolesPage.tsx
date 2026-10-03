import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api } from "../api";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { ErrorAlert } from "../ui/states";
import type { ShellContext } from "./Shell";

export function RolesPage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const rbac = useQuery({ queryKey: ["rbac-roles"], queryFn: api.rbacRoles });
  const orgRoles = useQuery({ queryKey: ["org-roles", orgID], queryFn: () => api.orgRoles(orgID), enabled: Boolean(orgID) });
  const perms = useQuery({ queryKey: ["rbac-permissions"], queryFn: api.permissions });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => api.createOrgRole(orgID, name.trim(), selected),
    onSuccess: async () => {
      setName("");
      setSelected([]);
      setError("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["org-roles", orgID] }),
        qc.invalidateQueries({ queryKey: ["rbac-roles"] }),
        qc.invalidateQueries({ queryKey: ["roles"] }),
      ]);
    },
    onError: (err: Error) => setError(err.message),
  });

  const assignable = (perms.data?.permissions ?? []).filter((p) => !p.key.startsWith("instance."));

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Roles"]}
        title="Roles and permissions"
        lede="System presets come from the ASPEC RBAC catalogue. Organisation roles can add extra capability sets."
      />

      <section className="panel mt-8 px-5 py-6 sm:px-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Create an organisation role</h2>
        {!orgID ? (
          <p className="mt-3 text-sm text-muted-foreground">Select or create an organisation first.</p>
        ) : (
          <form
            className="mt-5 grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Role name" htmlFor="role-name">
              <input id="role-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <fieldset>
              <legend className="text-sm font-medium">Capabilities</legend>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {assignable.map((p) => (
                  <label key={p.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(p.key)}
                      onChange={() =>
                        setSelected((cur) => (cur.includes(p.key) ? cur.filter((k) => k !== p.key) : [...cur, p.key]))
                      }
                    />
                    <span>
                      <span className="font-mono text-xs">{p.key}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <button type="submit" className="btn btn-primary" disabled={create.isPending || !name.trim() || selected.length === 0}>
                {create.isPending ? "Creating..." : "Create role"}
              </button>
            </div>
          </form>
        )}
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      </section>

      <h2 className="mt-10 font-serif text-xl font-semibold tracking-tight">Catalogue</h2>
      <div className="panel mt-4 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Source</th>
              <th>Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {(rbac.data?.roles ?? []).map((role) => (
              <tr key={role.key}>
                <td>
                  <div className="font-medium">{role.name}</div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">{role.key}</div>
                </td>
                <td>
                  <span className="badge">{role.system ? "system" : "custom"}</span>
                </td>
                <td className="text-xs text-muted-foreground">{role.permissions.join(", ")}</td>
              </tr>
            ))}
            {(orgRoles.data?.roles ?? [])
              .filter((r) => r.org_id)
              .map((role) => (
                <tr key={role.id}>
                  <td>
                    <div className="font-medium">{role.name}</div>
                  </td>
                  <td>
                    <span className="badge">organisation</span>
                  </td>
                  <td className="text-xs text-muted-foreground">{role.capabilities.join(", ")}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
