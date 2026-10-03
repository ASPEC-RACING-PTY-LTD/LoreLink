import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { api, type Connection, type ConnectionCreate, type Repo } from "../api";
import { Field, PasswordField } from "../ui/Field";
import { IconPlus, IconTrash } from "../ui/icons";
import { PageHeader } from "../ui/PageHeader";
import { EmptyPanel, ErrorAlert, InfoAlert, LoadingLine } from "../ui/states";
import type { ShellContext } from "./Shell";

const emptyForm: ConnectionCreate = {
  provider: "generic",
  display_name: "",
  base_url: "",
  auth_kind: "token",
  token: "",
  username: "",
  password: "",
};

export function ConnectionsPage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ["connections", orgID],
    queryFn: () => api.connections(orgID),
    enabled: Boolean(orgID),
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [reposFor, setReposFor] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  const create = useMutation({
    mutationFn: () => api.createConnection(orgID, form),
    onSuccess: async (res) => {
      setOpen(false);
      setForm(emptyForm);
      setError("");
      setWarning(res.warning ?? "");
      await qc.invalidateQueries({ queryKey: ["connections", orgID] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(orgID, id),
    onSuccess: async () => {
      setConfirmDelete("");
      await qc.invalidateQueries({ queryKey: ["connections", orgID] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const repos = useQuery({
    queryKey: ["connection-repos", orgID, reposFor],
    queryFn: () => api.connectionRepos(orgID, reposFor),
    enabled: Boolean(orgID && reposFor),
  });

  const createButton = (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => {
        setError("");
        setOpen(true);
      }}
    >
      <IconPlus />
      Add connection
    </button>
  );

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Connections"]}
        title="Connections"
        lede="Connect Git hosts for this organisation. Bind a repository from a project after the connection is saved."
        action={orgID ? createButton : undefined}
      />

      {connections.isLoading ? <LoadingLine label="Loading connections" /> : null}
      {connections.isError ? <ErrorAlert>{connections.error.message}</ErrorAlert> : null}
      {error && !open ? <ErrorAlert>{error}</ErrorAlert> : null}
      {warning ? <InfoAlert>{warning}</InfoAlert> : null}

      {connections.data && connections.data.connections.length === 0 ? (
        <EmptyPanel title="No connections yet" action={createButton}>
          Add a generic Git remote, GitHub, or CodeHold connection. Tokens are stored encrypted on this instance.
        </EmptyPanel>
      ) : null}

      {connections.data && connections.data.connections.length > 0 ? (
        <div className="panel mt-8 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Provider</th>
                <th>Auth</th>
                <th>Repositories</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connections.data.connections.map((c) => (
                <ConnectionRow
                  key={c.id}
                  connection={c}
                  expanded={reposFor === c.id}
                  repos={reposFor === c.id ? repos.data?.repos : undefined}
                  reposLoading={reposFor === c.id && repos.isLoading}
                  reposError={reposFor === c.id && repos.isError ? repos.error.message : ""}
                  confirmDelete={confirmDelete === c.id}
                  onToggleRepos={() => setReposFor((id) => (id === c.id ? "" : c.id))}
                  onDelete={() => {
                    setError("");
                    if (confirmDelete === c.id) remove.mutate(c.id);
                    else setConfirmDelete(c.id);
                  }}
                  deleting={remove.isPending && confirmDelete === c.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {open ? (
        <div className="modal-layer">
          <div className="modal-panel" role="dialog" aria-labelledby="create-connection-title">
            <h2 id="create-connection-title" className="font-serif text-2xl font-semibold tracking-tight">
              Add connection
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The secret is encrypted before it is stored. A failed live test still saves the connection so you can retry later.
            </p>
            {error ? <ErrorAlert>{error}</ErrorAlert> : null}
            <div className="mt-5 grid gap-4">
              <Field label="Display name" htmlFor="conn-name">
                <input
                  id="conn-name"
                  className="input"
                  value={form.display_name}
                  onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                />
              </Field>
              <Field label="Provider" htmlFor="conn-provider">
                <select
                  id="conn-provider"
                  className="select"
                  value={form.provider}
                  onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                >
                  <option value="generic">generic</option>
                  <option value="github">github</option>
                  <option value="codehold">codehold</option>
                </select>
              </Field>
              <Field label="Base URL" htmlFor="conn-url" hint="Optional for github.com. Required for GitHub Enterprise, CodeHold, and generic remotes.">
                <input
                  id="conn-url"
                  className="input"
                  value={form.base_url}
                  onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                  placeholder="https://git.example.com"
                />
              </Field>
              <Field label="Auth kind" htmlFor="conn-auth">
                <select
                  id="conn-auth"
                  className="select"
                  value={form.auth_kind}
                  onChange={(e) => setForm((f) => ({ ...f, auth_kind: e.target.value }))}
                >
                  <option value="token">token</option>
                  <option value="basic">basic</option>
                </select>
              </Field>
              {form.auth_kind === "basic" ? (
                <>
                  <Field label="Username" htmlFor="conn-user">
                    <input
                      id="conn-user"
                      className="input"
                      value={form.username}
                      autoComplete="username"
                      onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                    />
                  </Field>
                  <PasswordField
                    id="conn-password"
                    label="Password"
                    value={form.password ?? ""}
                    onChange={(value) => setForm((f) => ({ ...f, password: value }))}
                    autoComplete="new-password"
                  />
                </>
              ) : (
                <PasswordField
                  id="conn-token"
                  label="Token"
                  value={form.token ?? ""}
                  onChange={(value) => setForm((f) => ({ ...f, token: value }))}
                  autoComplete="new-password"
                />
              )}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Saving..." : "Save connection"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionRow({
  connection,
  expanded,
  repos,
  reposLoading,
  reposError,
  confirmDelete,
  onToggleRepos,
  onDelete,
  deleting,
}: {
  connection: Connection;
  expanded: boolean;
  repos?: Repo[];
  reposLoading: boolean;
  reposError: string;
  confirmDelete: boolean;
  onToggleRepos: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <>
      <tr>
        <td>
          <div className="font-medium">{connection.display_name}</div>
          <div className="mt-1 font-mono text-sm text-muted-foreground">{connection.base_url || "default host"}</div>
        </td>
        <td>
          <span className="badge">{connection.provider}</span>
        </td>
        <td className="text-sm text-muted-foreground">{connection.auth_kind || "token"}</td>
        <td>
          <button type="button" className="btn btn-ghost" onClick={onToggleRepos}>
            {expanded ? "Hide repositories" : "List repositories"}
          </button>
        </td>
        <td>
          <button type="button" className="btn btn-ghost text-destructive" onClick={onDelete} disabled={deleting}>
            <IconTrash />
            {confirmDelete ? (deleting ? "Removing..." : "Confirm remove") : "Remove"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5}>
            {reposLoading ? <LoadingLine label="Loading repositories" /> : null}
            {reposError ? <ErrorAlert>{reposError}</ErrorAlert> : null}
            {repos && repos.length === 0 ? <p className="text-sm text-muted-foreground">No repositories returned.</p> : null}
            {repos && repos.length > 0 ? (
              <ul className="grid gap-2">
                {repos.map((repo) => (
                  <li key={repo.full_name || repo.clone_url} className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{repo.full_name || repo.clone_url}</p>
                      <p className="font-mono text-sm text-muted-foreground">{repo.clone_url}</p>
                    </div>
                    <span className="badge">{repo.private ? "private" : "public"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
