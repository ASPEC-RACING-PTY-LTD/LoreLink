import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api, type Project } from "../api";
import { Field } from "../ui/Field";
import { IconPlus } from "../ui/icons";
import { PageHeader } from "../ui/PageHeader";
import { ErrorAlert } from "../ui/states";
import type { ShellContext } from "./Shell";

function bindingLabel(project: Project) {
  const binding = project.binding;
  if (!binding) return "Not connected";
  if (binding.status_error) return binding.status || "Error";
  if (binding.status) return binding.status;
  if (binding.repo_full_name || binding.repo_url) return "Connected";
  return "Not connected";
}

export function HomePage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const projects = useQuery({
    queryKey: ["projects", orgID],
    queryFn: () => api.projects(orgID),
    enabled: Boolean(orgID),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => api.createProject(orgID, { name, description, visibility }),
    onSuccess: async (project) => {
      setOpen(false);
      setName("");
      setDescription("");
      await qc.invalidateQueries({ queryKey: ["projects", orgID] });
      if (project.id) navigate(`/projects/${project.id}`);
    },
    onError: (err: Error) => setError(err.message),
  });

  function openCreate() {
    setError("");
    setOpen(true);
  }

  const createButton = (
    <button type="button" className="btn btn-primary" onClick={openCreate}>
      <IconPlus />
      Create project
    </button>
  );

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Projects"]}
        title="Projects"
        lede="Each project is a named documentation workspace. Bind a Git repository, edit LoreMark, and publish from the project page."
        action={orgID ? createButton : undefined}
      />

      {projects.isLoading ? (
        <div className="mt-10 flex items-center gap-3 text-muted-foreground">
          <span className="spinner" />
          Loading projects
        </div>
      ) : null}

      {!orgID ? (
        <section className="panel mt-8 px-6 py-10 sm:px-10">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Organisation</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight">No organisation selected</h2>
          <p className="page-lede mt-3">
            This account is not in an organisation yet. Create one from the header if you are an instance administrator.
          </p>
        </section>
      ) : null}

      {orgID && projects.data && projects.data.projects.length === 0 ? (
        <section className="panel mt-8 px-6 py-10 sm:px-10">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Get started</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight">No projects yet</h2>
          <p className="page-lede mt-3">
            Create the first workspace for this organisation. Git binding, editing, and publishing are available on the
            project page.
          </p>
          <div className="mt-8">{createButton}</div>
        </section>
      ) : null}

      {projects.isError ? <ErrorAlert>{projects.error.message}</ErrorAlert> : null}

      {projects.data && projects.data.projects.length > 0 ? (
        <div className="panel mt-8 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Visibility</th>
                <th>Git</th>
                <th>Docs root</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <div className="mt-1 text-sm text-muted-foreground">{p.description || "No description"}</div>
                  </td>
                  <td>
                    <span className="badge">{p.visibility}</span>
                  </td>
                  <td className="text-sm text-muted-foreground">{bindingLabel(p)}</td>
                  <td className="font-mono text-sm">{p.docs_root}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {open ? (
        <div className="modal-layer">
          <div className="modal-panel" role="dialog" aria-labelledby="create-project-title">
            <h2 id="create-project-title" className="font-serif text-2xl font-semibold tracking-tight">
              Create project
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Reserve the project name and visibility. Bind a Git repository from the project page after it is created.
            </p>
            {error ? (
              <div role="alert" className="alert alert-error mt-4">
                {error}
              </div>
            ) : null}
            <div className="mt-5 grid gap-4">
              <Field label="Name" htmlFor="project-name">
                <input id="project-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Description" htmlFor="project-description">
                <textarea
                  id="project-description"
                  className="textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </Field>
              <Field label="Visibility" htmlFor="project-visibility">
                <select id="project-visibility" className="select" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                  <option value="private">private</option>
                  <option value="internal">internal</option>
                  <option value="public">public</option>
                </select>
              </Field>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Creating..." : "Create project"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
