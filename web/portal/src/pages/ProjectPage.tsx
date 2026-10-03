import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api, type Binding, type Project, type Repo } from "../api";
import { Field } from "../ui/Field";
import { IconGit, IconPlus, IconSearch, IconSettings, IconSync, IconTrash } from "../ui/icons";
import { PageHeader } from "../ui/PageHeader";
import { EmptyPanel, ErrorAlert, InfoAlert, LoadingLine, formatWhen, shortSha } from "../ui/states";
import type { ShellContext } from "./Shell";
import { DocEditor } from "./project/DocEditor";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "repository", label: "Repository" },
  { id: "files", label: "Files" },
  { id: "publish", label: "Publish" },
  { id: "search", label: "Search" },
  { id: "maintainer", label: "Maintainer" },
  { id: "jobs", label: "Jobs" },
  { id: "settings", label: "Settings" },
] as const;

type Tab = (typeof tabs)[number]["id"];

export function ProjectPage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const { projectID = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (tabs.some((item) => item.id === params.get("tab")) ? params.get("tab") : "overview") as Tab;

  const detail = useQuery({
    queryKey: ["project", orgID, projectID],
    queryFn: () => api.project(orgID, projectID),
    enabled: Boolean(orgID && projectID),
  });

  const project = detail.data?.project;
  const binding = detail.data?.binding ?? project?.binding ?? null;
  const docsHref = org?.slug && project?.slug ? `/view/${org.slug}/${project.slug}/` : "";

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Projects", project?.name ?? "Project"]}
        title={project?.name ?? "Project"}
        lede={project?.description || "Bind a repository, edit LoreMark, search, and publish this documentation workspace."}
        action={
          docsHref ? (
            <a className="btn btn-ghost" href={docsHref}>
              Open docs site
            </a>
          ) : undefined
        }
      />

      {detail.isLoading ? <LoadingLine label="Loading project" /> : null}
      {detail.isError ? <ErrorAlert>{detail.error.message}</ErrorAlert> : null}

      {project ? (
        <>
          <div className="mt-6 flex flex-wrap gap-1 border-b border-border" role="tablist" aria-label="Project sections">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? "nav-link nav-link-active" : "nav-link"}
                onClick={() => setParams(item.id === "overview" ? {} : { tab: item.id })}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === "overview" ? <Overview project={project} binding={binding} orgSlug={org?.slug ?? ""} /> : null}
          {tab === "repository" ? <Repository orgID={orgID} project={project} binding={binding} /> : null}
          {tab === "files" ? <DocEditor orgID={orgID} projectID={project.id} bound={Boolean(binding)} /> : null}
          {tab === "publish" ? <PublishSection orgID={orgID} project={project} /> : null}
          {tab === "search" ? <SearchSection orgID={orgID} project={project} /> : null}
          {tab === "maintainer" ? <MaintainerSection orgID={orgID} project={project} /> : null}
          {tab === "jobs" ? <JobsSection orgID={orgID} project={project} /> : null}
          {tab === "settings" ? <SettingsSection orgID={orgID} project={project} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Overview({ project, binding, orgSlug }: { project: Project; binding: Binding | null; orgSlug: string }) {
  const docsHref = orgSlug && project.slug ? `/view/${orgSlug}/${project.slug}/` : "";
  return (
    <section className="panel mt-8 px-6 py-6">
      <h2 className="font-serif text-xl font-semibold tracking-tight">Overview</h2>
      <dl className="mt-4 grid gap-5 sm:grid-cols-2">
        <Item label="Name" value={project.name} />
        <Item label="Visibility" value={project.visibility} badge />
        <Item label="Slug" value={project.slug} mono />
        <Item label="Docs root" value={project.docs_root || "docs"} mono />
        <Item label="Default branch" value={binding?.default_branch || project.default_branch || "main"} mono />
        <Item label="Binding" value={binding ? binding.status || "connected" : "Not connected"} badge />
        <Item label="Last SHA" value={shortSha(binding?.last_synced_sha)} mono />
        <Item label="Last synced" value={formatWhen(binding?.last_synced_at)} />
        <Item label="Poll fallback" value={binding ? (binding.poll_fallback ? "polling" : "webhook") : "n/a"} badge />
        <Item label="Repository" value={binding?.repo_full_name || binding?.repo_url || "None"} />
      </dl>
      {binding?.status_error ? <ErrorAlert>{binding.status_error}</ErrorAlert> : null}
      <div className="mt-6 flex flex-wrap gap-3">
        {docsHref ? (
          <a className="btn btn-primary" href={docsHref}>
            Read /view/{orgSlug}/{project.slug}/
          </a>
        ) : null}
        <Link className="btn btn-ghost" to="/connections">
          Manage connections
        </Link>
      </div>
    </section>
  );
}

function Item({ label, value, badge, mono }: { label: string; value: string; badge?: boolean; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1">
        {badge ? <span className="badge">{value}</span> : <span className={mono ? "break-all font-mono text-sm" : "text-sm"}>{value}</span>}
      </dd>
    </div>
  );
}

function Repository({ orgID, project, binding }: { orgID: string; project: Project; binding: Binding | null }) {
  const qc = useQueryClient();
  const connections = useQuery({
    queryKey: ["connections", orgID],
    queryFn: () => api.connections(orgID),
    enabled: Boolean(orgID),
  });
  const [connectionID, setConnectionID] = useState(binding?.connection_id ?? "");
  const [repoURL, setRepoURL] = useState(binding?.repo_url ?? "");
  const [repoFullName, setRepoFullName] = useState(binding?.repo_full_name ?? "");
  const [branch, setBranch] = useState(binding?.default_branch || project.default_branch || "main");
  const [docsRoot, setDocsRoot] = useState(binding?.docs_root || project.docs_root || "docs");
  const [generated, setGenerated] = useState((binding?.generated_roots ?? []).join(", "));
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const repos = useQuery({
    queryKey: ["connection-repos", orgID, connectionID],
    queryFn: () => api.connectionRepos(orgID, connectionID),
    enabled: Boolean(orgID && connectionID),
  });

  const bind = useMutation({
    mutationFn: () =>
      api.bindProject(orgID, project.id, {
        connection_id: connectionID,
        repo_url: repoURL,
        repo_full_name: repoFullName,
        default_branch: branch,
        docs_root: docsRoot,
        generated_roots: generated
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: async (res) => {
      setError("");
      setInfo(res.poll_fallback ? "Bound. Webhook registration fell back to polling." : "Bound. A sync job was queued.");
      await qc.invalidateQueries({ queryKey: ["project", orgID, project.id] });
      await qc.invalidateQueries({ queryKey: ["project-jobs", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const sync = useMutation({
    mutationFn: () => api.syncProject(orgID, project.id),
    onSuccess: async () => {
      setError("");
      setInfo("Sync queued.");
      await qc.invalidateQueries({ queryKey: ["project-jobs", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  function chooseRepo(repo: Repo) {
    setRepoFullName(repo.full_name);
    setRepoURL(repo.clone_url);
    if (repo.default_branch) setBranch(repo.default_branch);
  }

  return (
    <div className="mt-8 grid gap-6">
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {info ? <InfoAlert>{info}</InfoAlert> : null}

      <section className="panel px-6 py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold tracking-tight">Current binding</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {binding ? binding.repo_full_name || binding.repo_url : "This project is not bound to a repository."}
            </p>
          </div>
          <button type="button" className="btn btn-ghost" disabled={!binding || sync.isPending} onClick={() => sync.mutate()}>
            <IconSync />
            {sync.isPending ? "Queueing..." : "Sync now"}
          </button>
        </div>
        {binding ? (
          <dl className="mt-5 grid gap-5 sm:grid-cols-3">
            <Item label="Status" value={binding.status || "connected"} badge />
            <Item label="Last SHA" value={shortSha(binding.last_synced_sha)} mono />
            <Item label="Delivery" value={binding.poll_fallback ? "poll fallback" : "webhook"} badge />
            <Item label="Webhook" value={binding.webhook_id || "none"} mono />
            <Item label="Docs root" value={binding.docs_root || "docs"} mono />
            <Item label="Last synced" value={formatWhen(binding.last_synced_at)} />
          </dl>
        ) : null}
        {binding?.status_error ? <ErrorAlert>{binding.status_error}</ErrorAlert> : null}
      </section>

      <section className="panel px-6 py-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Bind repository</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose a connection, then a repository. Binding queues an initial sync.</p>
        {connections.isLoading ? <LoadingLine label="Loading connections" /> : null}
        {connections.data && connections.data.connections.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No connections yet. <Link to="/connections">Add a connection</Link> first.
          </p>
        ) : null}
        <div className="mt-5 grid gap-4">
          <Field label="Connection" htmlFor="bind-connection">
            <select id="bind-connection" className="select" value={connectionID} onChange={(e) => setConnectionID(e.target.value)}>
              <option value="">Select a connection</option>
              {connections.data?.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name} ({c.provider})
                </option>
              ))}
            </select>
          </Field>
          {repos.isLoading ? <LoadingLine label="Loading repositories" /> : null}
          {repos.isError ? <ErrorAlert>{repos.error.message}</ErrorAlert> : null}
          {repos.data && repos.data.repos.length > 0 ? (
            <Field label="Repository" htmlFor="bind-repo">
              <select
                id="bind-repo"
                className="select"
                value={repoFullName}
                onChange={(e) => {
                  const repo = repos.data?.repos.find((r) => r.full_name === e.target.value);
                  if (repo) chooseRepo(repo);
                  else setRepoFullName(e.target.value);
                }}
              >
                <option value="">Select a repository</option>
                {repos.data.repos.map((repo) => (
                  <option key={repo.full_name || repo.clone_url} value={repo.full_name}>
                    {repo.full_name || repo.clone_url}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Clone URL" htmlFor="bind-url">
            <input id="bind-url" className="input" value={repoURL} onChange={(e) => setRepoURL(e.target.value)} />
          </Field>
          <Field label="Full name" htmlFor="bind-full">
            <input id="bind-full" className="input" value={repoFullName} onChange={(e) => setRepoFullName(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default branch" htmlFor="bind-branch">
              <input id="bind-branch" className="input" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
            <Field label="Docs root" htmlFor="bind-docs">
              <input id="bind-docs" className="input" value={docsRoot} onChange={(e) => setDocsRoot(e.target.value)} />
            </Field>
          </div>
          <Field label="Generated roots" htmlFor="bind-generated" hint="Comma-separated paths the maintainer may write.">
            <input id="bind-generated" className="input" value={generated} onChange={(e) => setGenerated(e.target.value)} />
          </Field>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={bind.isPending || !connectionID || (!repoURL && !repoFullName)}
              onClick={() => bind.mutate()}
            >
              <IconGit />
              {bind.isPending ? "Binding..." : binding ? "Update binding" : "Bind repository"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PublishSection({ orgID, project }: { orgID: string; project: Project }) {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: ["project-versions", orgID, project.id],
    queryFn: () => api.versions(orgID, project.id),
    enabled: Boolean(orgID && project.id),
  });
  const runs = useQuery({
    queryKey: ["project-publish", orgID, project.id],
    queryFn: () => api.publishRuns(orgID, project.id),
    enabled: Boolean(orgID && project.id),
  });
  const [versionName, setVersionName] = useState("");
  const [alias, setAlias] = useState("");
  const [gitRef, setGitRef] = useState(project.default_branch || "main");
  const [immutable, setImmutable] = useState(false);
  const [target, setTarget] = useState<"hosted" | "filesystem" | "download">("hosted");
  const [publishVersion, setPublishVersion] = useState("latest");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const createVersion = useMutation({
    mutationFn: () => api.createVersion(orgID, project.id, { name: versionName.trim(), alias, git_ref: gitRef, immutable }),
    onSuccess: async () => {
      setVersionName("");
      setAlias("");
      setError("");
      setInfo("Version created.");
      await qc.invalidateQueries({ queryKey: ["project-versions", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const publish = useMutation({
    mutationFn: () => api.publish(orgID, project.id, { target, version: publishVersion }),
    onSuccess: async () => {
      setError("");
      setInfo("Publish run queued.");
      await qc.invalidateQueries({ queryKey: ["project-publish", orgID, project.id] });
      await qc.invalidateQueries({ queryKey: ["project-jobs", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="mt-8 grid gap-6">
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {info ? <InfoAlert>{info}</InfoAlert> : null}

      <section className="panel px-6 py-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Versions</h2>
        <form
          className="mt-5 grid gap-3 lg:grid-cols-[1fr_8rem_8rem_auto_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            createVersion.mutate();
          }}
        >
          <Field label="Name" htmlFor="version-name">
            <input id="version-name" className="input" value={versionName} onChange={(e) => setVersionName(e.target.value)} required />
          </Field>
          <Field label="Alias" htmlFor="version-alias">
            <input id="version-alias" className="input" value={alias} onChange={(e) => setAlias(e.target.value)} />
          </Field>
          <Field label="Git ref" htmlFor="version-ref">
            <input id="version-ref" className="input" value={gitRef} onChange={(e) => setGitRef(e.target.value)} />
          </Field>
          <Field label="Immutable" htmlFor="version-immutable">
            <select id="version-immutable" className="select" value={immutable ? "yes" : "no"} onChange={(e) => setImmutable(e.target.value === "yes")}>
              <option value="no">no</option>
              <option value="yes">yes</option>
            </select>
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary" disabled={createVersion.isPending}>
              <IconPlus />
              {createVersion.isPending ? "Creating..." : "Add version"}
            </button>
          </div>
        </form>
        {versions.isLoading ? <LoadingLine label="Loading versions" /> : null}
        {versions.data && versions.data.versions.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No named versions yet. Publishing can still target latest.</p>
        ) : null}
        {versions.data && versions.data.versions.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Alias</th>
                  <th>Git ref</th>
                  <th>Immutable</th>
                </tr>
              </thead>
              <tbody>
                {versions.data.versions.map((v) => (
                  <tr key={v.id}>
                    <td className="font-medium">{v.name}</td>
                    <td className="text-sm text-muted-foreground">{v.alias || "none"}</td>
                    <td className="font-mono text-sm">{v.git_ref}</td>
                    <td>
                      <span className="badge">{v.immutable ? "yes" : "no"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="panel px-6 py-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Publish</h2>
        <form
          className="mt-5 grid gap-3 sm:grid-cols-[12rem_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            publish.mutate();
          }}
        >
          <Field label="Target" htmlFor="publish-target">
            <select id="publish-target" className="select" value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
              <option value="hosted">hosted</option>
              <option value="filesystem">filesystem</option>
              <option value="download">download</option>
            </select>
          </Field>
          <Field label="Version" htmlFor="publish-version">
            <input id="publish-version" className="input" value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary" disabled={publish.isPending}>
              {publish.isPending ? "Queueing..." : "Publish"}
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="font-serif text-xl font-semibold tracking-tight">Publish runs</h2>
        {runs.isLoading ? <LoadingLine label="Loading publish runs" /> : null}
        {runs.data && runs.data.runs.length === 0 ? (
          <EmptyPanel title="No publish runs yet">Queue a hosted, filesystem, or download publish to create a run.</EmptyPanel>
        ) : null}
        {runs.data && runs.data.runs.length > 0 ? (
          <div className="panel mt-4 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Artifact</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.target}</td>
                    <td className="font-mono text-sm">{run.version_name}</td>
                    <td>
                      <span className="badge">{run.status}</span>
                    </td>
                    <td className="text-sm text-muted-foreground">{formatWhen(run.created_at)}</td>
                    <td>
                      {run.status === "ok" ? (
                        <a className="btn btn-ghost" href={api.publishDownloadURL(orgID, project.id, run.id)}>
                          Download
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground">{run.error || "pending"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SearchSection({ orgID, project }: { orgID: string; project: Project }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [version, setVersion] = useState("latest");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const results = useQuery({
    queryKey: ["project-search", orgID, project.id, submitted, version],
    queryFn: () => api.search(orgID, project.id, submitted, version),
    enabled: Boolean(orgID && project.id && submitted),
  });

  const reindex = useMutation({
    mutationFn: () => api.reindex(orgID, project.id),
    onSuccess: async () => {
      setError("");
      setInfo("Reindex queued.");
      await qc.invalidateQueries({ queryKey: ["project-jobs", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="mt-8">
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {info ? <InfoAlert>{info}</InfoAlert> : null}
      <section className="panel px-6 py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold tracking-tight">Search index</h2>
            <p className="mt-1 text-sm text-muted-foreground">Query the indexed LoreMark text. Reindex after large edits.</p>
          </div>
          <button type="button" className="btn btn-ghost" disabled={reindex.isPending} onClick={() => reindex.mutate()}>
            <IconSearch />
            {reindex.isPending ? "Queueing..." : "Reindex"}
          </button>
        </div>
        <form
          className="mt-5 grid gap-3 sm:grid-cols-[1fr_10rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(q.trim());
          }}
        >
          <Field label="Query" htmlFor="search-q">
            <input id="search-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Version" htmlFor="search-version">
            <input id="search-version" className="input" value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary" disabled={!q.trim()}>
              Search
            </button>
          </div>
        </form>
      </section>
      {results.isLoading ? <LoadingLine label="Searching" /> : null}
      {results.isError ? <ErrorAlert>{results.error.message}</ErrorAlert> : null}
      {submitted && results.data && results.data.results.length === 0 ? (
        <EmptyPanel title="No matching pages">Try a different query, or reindex this version.</EmptyPanel>
      ) : null}
      {results.data && results.data.results.length > 0 ? (
        <div className="panel mt-6 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Path</th>
                <th>Excerpt</th>
              </tr>
            </thead>
            <tbody>
              {results.data.results.map((hit) => (
                <tr key={`${hit.path}-${hit.title}`}>
                  <td className="font-medium">{hit.title || "Untitled"}</td>
                  <td className="font-mono text-sm">{hit.path}</td>
                  <td className="text-sm text-muted-foreground">{hit.body || hit.headings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function MaintainerSection({ orgID, project }: { orgID: string; project: Project }) {
  const qc = useQueryClient();
  const mappings = useQuery({
    queryKey: ["project-mappings", orgID, project.id],
    queryFn: () => api.mappings(orgID, project.id),
    enabled: Boolean(orgID && project.id),
  });
  const [sourceMatch, setSourceMatch] = useState("");
  const [extractor, setExtractor] = useState("openapi");
  const [output, setOutput] = useState("");
  const [options, setOptions] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createMapping(orgID, project.id, {
        source_match: sourceMatch.trim(),
        extractor,
        output: output.trim(),
        options_json: options.trim(),
      }),
    onSuccess: async () => {
      setSourceMatch("");
      setOutput("");
      setOptions("");
      setError("");
      await qc.invalidateQueries({ queryKey: ["project-mappings", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMapping(orgID, project.id, id),
    onSuccess: async () => {
      setConfirmDelete("");
      await qc.invalidateQueries({ queryKey: ["project-mappings", orgID, project.id] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const action = useMutation({
    mutationFn: (kind: "check" | "sync" | "explain") => api.maintainerAction(orgID, project.id, kind),
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="mt-8 grid gap-6">
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}

      <section className="panel px-6 py-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Mappings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Map source files to generated documentation output.</p>
        <form
          className="mt-5 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-3 lg:grid-cols-3">
            <Field label="Source match" htmlFor="map-source">
              <input id="map-source" className="input" value={sourceMatch} onChange={(e) => setSourceMatch(e.target.value)} required />
            </Field>
            <Field label="Extractor" htmlFor="map-extractor">
              <select id="map-extractor" className="select" value={extractor} onChange={(e) => setExtractor(e.target.value)}>
                <option value="openapi">openapi</option>
                <option value="go">go</option>
                <option value="generic">generic</option>
              </select>
            </Field>
            <Field label="Output" htmlFor="map-output">
              <input id="map-output" className="input" value={output} onChange={(e) => setOutput(e.target.value)} required />
            </Field>
          </div>
          <Field label="Options JSON" htmlFor="map-options">
            <textarea id="map-options" className="textarea font-mono" rows={3} value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
          <div>
            <button type="submit" className="btn btn-primary" disabled={create.isPending}>
              {create.isPending ? "Adding..." : "Add mapping"}
            </button>
          </div>
        </form>
        {mappings.isLoading ? <LoadingLine label="Loading mappings" /> : null}
        {mappings.data && mappings.data.mappings.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No mappings yet.</p>
        ) : null}
        {mappings.data && mappings.data.mappings.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Extractor</th>
                  <th>Output</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mappings.data.mappings.map((m) => (
                  <tr key={m.id}>
                    <td className="font-mono text-sm">{m.source_match}</td>
                    <td>
                      <span className="badge">{m.extractor}</span>
                    </td>
                    <td className="font-mono text-sm">{m.output}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirmDelete === m.id) remove.mutate(m.id);
                          else setConfirmDelete(m.id);
                        }}
                      >
                        <IconTrash />
                        {confirmDelete === m.id ? "Confirm delete" : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="panel px-6 py-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Check, sync, explain</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={action.isPending} onClick={() => action.mutate("check")}>
            Check
          </button>
          <button type="button" className="btn btn-ghost" disabled={action.isPending} onClick={() => action.mutate("sync")}>
            Sync generated
          </button>
          <button type="button" className="btn btn-ghost" disabled={action.isPending} onClick={() => action.mutate("explain")}>
            Explain
          </button>
        </div>
        {action.data ? (
          <div className="mt-6 grid gap-5">
            <dl className="grid gap-5 sm:grid-cols-4">
              <Item label="Enabled" value={action.data.enabled ? "yes" : "no"} badge />
              <Item label="Mappings" value={String(action.data.coverage.mappings)} />
              <Item label="Sources" value={String(action.data.coverage.sources)} />
              <Item label="Drift" value={String(action.data.coverage.drift)} />
            </dl>
            {action.data.findings.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Level</th>
                      <th>Mapping</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {action.data.findings.map((f, i) => (
                      <tr key={`${f.mapping}-${i}`}>
                        <td>
                          <span className="badge">{f.level}</span>
                        </td>
                        <td className="font-mono text-sm">{f.mapping}</td>
                        <td className="text-sm">{f.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No findings.</p>
            )}
            {action.data.explain && action.data.explain.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Output</th>
                      <th>Source</th>
                      <th>Excerpt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {action.data.explain.map((row, i) => (
                      <tr key={`${row.output}-${i}`}>
                        <td className="font-mono text-sm">{row.output}</td>
                        <td className="font-mono text-sm">{row.source}</td>
                        <td className="text-sm text-muted-foreground">{row.excerpt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function JobsSection({ orgID, project }: { orgID: string; project: Project }) {
  const jobs = useQuery({
    queryKey: ["project-jobs", orgID, project.id],
    queryFn: () => api.jobs(orgID, project.id),
    enabled: Boolean(orgID && project.id),
    refetchInterval: (query) => {
      const items = query.state.data?.jobs ?? [];
      return items.some((job) => job.status === "queued" || job.status === "running") ? 4000 : false;
    },
  });

  return (
    <div className="mt-8">
      {jobs.isLoading ? <LoadingLine label="Loading jobs" /> : null}
      {jobs.isError ? <ErrorAlert>{jobs.error.message}</ErrorAlert> : null}
      {jobs.data && jobs.data.jobs.length === 0 ? (
        <EmptyPanel title="No jobs yet">Sync, publish, and reindex enqueue jobs here.</EmptyPanel>
      ) : null}
      {jobs.data && jobs.data.jobs.length > 0 ? (
        <div className="panel overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>When</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.jobs.map((job) => (
                <tr key={job.id}>
                  <td className="font-mono text-sm">{job.kind}</td>
                  <td>
                    <span className="badge">{job.status}</span>
                  </td>
                  <td className="text-sm">{job.attempts}</td>
                  <td className="text-sm text-muted-foreground">{formatWhen(job.created_at)}</td>
                  <td className="text-sm text-muted-foreground">{job.last_error || "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function SettingsSection({ orgID, project }: { orgID: string; project: Project }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    docs_root: project.docs_root,
    default_branch: project.default_branch,
    publish_policy: project.publish_policy,
    host: project.host,
    base_path: project.base_path,
  });
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const save = useMutation({
    mutationFn: () => api.patchProject(orgID, project.id, form),
    onSuccess: async () => {
      setError("");
      setInfo("Project settings saved.");
      await qc.invalidateQueries({ queryKey: ["project", orgID, project.id] });
      await qc.invalidateQueries({ queryKey: ["projects", orgID] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const changed = useMemo(
    () =>
      form.name !== project.name ||
      form.description !== project.description ||
      form.visibility !== project.visibility ||
      form.docs_root !== project.docs_root ||
      form.default_branch !== project.default_branch ||
      form.publish_policy !== project.publish_policy ||
      form.host !== project.host ||
      form.base_path !== project.base_path,
    [form, project],
  );

  return (
    <section className="panel mt-8 px-6 py-6">
      <h2 className="font-serif text-xl font-semibold tracking-tight">Project settings</h2>
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {info ? <InfoAlert>{info}</InfoAlert> : null}
      <form
        className="mt-5 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" htmlFor="settings-name">
          <input id="settings-name" className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Description" htmlFor="settings-description">
          <textarea
            id="settings-description"
            className="textarea"
            rows={3}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Visibility" htmlFor="settings-visibility">
            <select
              id="settings-visibility"
              className="select"
              value={form.visibility}
              onChange={(e) => setForm((f) => ({ ...f, visibility: e.target.value }))}
            >
              <option value="private">private</option>
              <option value="internal">internal</option>
              <option value="public">public</option>
            </select>
          </Field>
          <Field label="Publish policy" htmlFor="settings-policy">
            <input
              id="settings-policy"
              className="input"
              value={form.publish_policy}
              onChange={(e) => setForm((f) => ({ ...f, publish_policy: e.target.value }))}
            />
          </Field>
          <Field label="Docs root" htmlFor="settings-docs">
            <input id="settings-docs" className="input" value={form.docs_root} onChange={(e) => setForm((f) => ({ ...f, docs_root: e.target.value }))} />
          </Field>
          <Field label="Default branch" htmlFor="settings-branch">
            <input
              id="settings-branch"
              className="input"
              value={form.default_branch}
              onChange={(e) => setForm((f) => ({ ...f, default_branch: e.target.value }))}
            />
          </Field>
          <Field label="Host" htmlFor="settings-host">
            <input id="settings-host" className="input" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
          </Field>
          <Field label="Base path" htmlFor="settings-base">
            <input id="settings-base" className="input" value={form.base_path} onChange={(e) => setForm((f) => ({ ...f, base_path: e.target.value }))} />
          </Field>
        </div>
        <div>
          <button type="submit" className="btn btn-primary" disabled={save.isPending || !changed}>
            <IconSettings />
            {save.isPending ? "Saving..." : "Save settings"}
          </button>
        </div>
      </form>
      <RedirectsEditor orgID={orgID} projectID={project.id} />
    </section>
  );
}

function RedirectsEditor({ orgID, projectID }: { orgID: string; projectID: string }) {
  const qc = useQueryClient();
  const [fromPath, setFromPath] = useState("");
  const [toPath, setToPath] = useState("");
  const [error, setError] = useState("");
  const list = useQuery({
    queryKey: ["redirects", orgID, projectID],
    queryFn: () => api.redirects(orgID, projectID),
    enabled: Boolean(orgID && projectID),
  });
  const create = useMutation({
    mutationFn: () => api.createRedirect(orgID, projectID, fromPath, toPath),
    onSuccess: async () => {
      setFromPath("");
      setToPath("");
      setError("");
      await qc.invalidateQueries({ queryKey: ["redirects", orgID, projectID] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="mt-10 border-t border-border pt-6">
      <h3 className="font-serif text-lg font-semibold tracking-tight">Redirects</h3>
      <p className="mt-1 text-sm text-muted-foreground">Map an old docs path to a new one. Applied on the public reader.</p>
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {list.data && list.data.redirects.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {list.data.redirects.map((row) => (
                <tr key={row.id || row.from_path}>
                  <td className="font-mono text-sm">{row.from_path}</td>
                  <td className="font-mono text-sm">{row.to_path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No redirects yet.</p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input className="input font-mono" placeholder="docs/old.md" value={fromPath} onChange={(e) => setFromPath(e.target.value)} />
        <input className="input font-mono" placeholder="docs/new.md" value={toPath} onChange={(e) => setToPath(e.target.value)} />
        <button type="button" className="btn btn-ghost" disabled={create.isPending || !fromPath || !toPath} onClick={() => create.mutate()}>
          Add
        </button>
      </div>
    </div>
  );
}
