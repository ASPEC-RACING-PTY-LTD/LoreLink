import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type FileEntry, type LoreBlock, type LoreDoc } from "../../api";
import { Field } from "../../ui/Field";
import { IconFile, IconFolder, IconPlus, IconTrash } from "../../ui/icons";
import { ErrorAlert, InfoAlert, LoadingLine } from "../../ui/states";

type Mode = "source" | "split" | "visual";

const emptyDoc: LoreDoc = { title: "", description: "", html: "", text: "", headings: [], blocks: [] };

export function DocEditor({ orgID, projectID, bound }: { orgID: string; projectID: string; bound: boolean }) {
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<Mode>("split");
  const [content, setContent] = useState("");
  const [blocks, setBlocks] = useState<LoreBlock[]>([]);
  const [doc, setDoc] = useState<LoreDoc>(emptyDoc);
  const [dirty, setDirty] = useState(false);
  const [leaseToken, setLeaseToken] = useState("");
  const [leaseError, setLeaseError] = useState("");
  const [newPath, setNewPath] = useState("docs/untitled.md");
  const [commitMessage, setCommitMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionInfo, setActionInfo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const leaseRef = useRef("");

  const files = useQuery({
    queryKey: ["project-files", orgID, projectID],
    queryFn: () => api.files(orgID, projectID),
    enabled: Boolean(orgID && projectID && bound),
  });

  const file = useQuery({
    queryKey: ["project-file", orgID, projectID, path],
    queryFn: () => api.file(orgID, projectID, path),
    enabled: Boolean(orgID && projectID && path && bound),
  });

  useEffect(() => {
    setDirty(false);
    setActionInfo("");
    setActionError("");
    setConfirmDelete(false);
  }, [path]);

  useEffect(() => {
    if (!file.data || dirty) return;
    setContent(file.data.content);
    setBlocks(file.data.doc.blocks);
    setDoc(file.data.doc);
    setConfirmDelete(false);
  }, [file.data, dirty]);

  useEffect(() => {
    if (!orgID || !projectID || !path || !bound) return;
    let active = true;
    leaseRef.current = "";
    setLeaseToken("");
    setLeaseError("");
    api
      .acquireLease(orgID, projectID, path)
      .then((lease) => {
        if (!active) {
          void api.releaseLease(orgID, projectID, lease.token);
          return;
        }
        leaseRef.current = lease.token;
        setLeaseToken(lease.token);
      })
      .catch((err: Error) => {
        if (active) setLeaseError(err.message);
      });
    return () => {
      active = false;
      const token = leaseRef.current;
      if (token) void api.releaseLease(orgID, projectID, token);
      leaseRef.current = "";
    };
  }, [orgID, projectID, path, bound]);

  const save = useMutation({
    mutationFn: () => {
      if (mode === "visual") {
        return api.putFile(orgID, projectID, { path, blocks, lease: leaseToken || undefined });
      }
      return api.putFile(orgID, projectID, { path, content, lease: leaseToken || undefined });
    },
    onSuccess: async (res) => {
      setDoc(res.doc);
      setBlocks(res.doc.blocks);
      setDirty(false);
      setActionError("");
      setActionInfo("Saved to the workspace.");
      await qc.invalidateQueries({ queryKey: ["project-file", orgID, projectID, path] });
      await qc.invalidateQueries({ queryKey: ["project-files", orgID, projectID] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const createFile = useMutation({
    mutationFn: () =>
      api.putFile(orgID, projectID, {
        path: newPath.trim(),
        content: `# ${newPath.trim().split("/").pop()?.replace(/\.md$/i, "") || "Untitled"}\n`,
      }),
    onSuccess: async () => {
      const created = newPath.trim();
      setActionError("");
      setActionInfo(`Created ${created}.`);
      await qc.invalidateQueries({ queryKey: ["project-files", orgID, projectID] });
      setPath(created);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const removeFile = useMutation({
    mutationFn: () => api.deleteFile(orgID, projectID, path),
    onSuccess: async () => {
      setPath("");
      setContent("");
      setBlocks([]);
      setDoc(emptyDoc);
      setConfirmDelete(false);
      setActionInfo("File deleted from the workspace.");
      await qc.invalidateQueries({ queryKey: ["project-files", orgID, projectID] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const commit = useMutation({
    mutationFn: () => api.commit(orgID, projectID, commitMessage.trim()),
    onSuccess: async (res) => {
      setCommitMessage("");
      setActionError("");
      setActionInfo(res.sha ? `Committed ${res.sha.slice(0, 12)}.` : "Commit pushed.");
      await qc.invalidateQueries({ queryKey: ["project", orgID, projectID] });
      await qc.invalidateQueries({ queryKey: ["project-jobs", orgID, projectID] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const tree = useMemo(() => files.data?.files ?? [], [files.data]);

  if (!bound) {
    return (
      <section className="panel mt-6 px-6 py-10">
        <h2 className="font-serif text-2xl font-semibold tracking-tight">Bind a repository first</h2>
        <p className="page-lede mt-3">The editor reads and writes files from the bound Git workspace.</p>
      </section>
    );
  }

  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[16.5rem_1fr]">
      <aside className="panel overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Files</p>
        </div>
        {files.isLoading ? <div className="px-4"><LoadingLine label="Loading files" /></div> : null}
        {files.isError ? <div className="px-4 pb-4"><ErrorAlert>{files.error.message}</ErrorAlert></div> : null}
        {files.data && files.data.files.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No files in the workspace yet.</p>
        ) : null}
        <nav aria-label="Project files" className="max-h-[32rem] overflow-auto py-2">
          {tree.map((entry) => (
            <FileRow key={entry.path} entry={entry} active={path === entry.path} onOpen={setPath} />
          ))}
        </nav>
        <form
          className="grid gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newPath.trim()) return;
            createFile.mutate();
          }}
        >
          <Field label="New file path" htmlFor="new-file-path">
            <input
              id="new-file-path"
              className="input"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
            />
          </Field>
          <button type="submit" className="btn btn-ghost" disabled={createFile.isPending}>
            <IconPlus />
            {createFile.isPending ? "Creating..." : "Create file"}
          </button>
        </form>
      </aside>

      <section className="min-w-0">
        {!path ? (
          <div className="panel px-6 py-10">
            <h2 className="font-serif text-2xl font-semibold tracking-tight">Select a file</h2>
            <p className="page-lede mt-3">Open a workspace file to edit LoreMark source, or switch to the visual block editor.</p>
          </div>
        ) : (
          <div className="panel overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{path}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {leaseToken
                    ? "Edit lease held on this file."
                    : leaseError
                      ? `View only: ${leaseError}`
                      : "Acquiring edit lease..."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Editor mode">
                {(["source", "split", "visual"] as Mode[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={mode === item}
                    className={mode === item ? "nav-link nav-link-active" : "nav-link"}
                    onClick={() => setMode(item)}
                  >
                    {item === "source" ? "Source" : item === "split" ? "Split" : "Visual"}
                  </button>
                ))}
              </div>
            </div>

            {file.isLoading ? <div className="px-4"><LoadingLine label="Loading file" /></div> : null}
            {file.isError ? <div className="px-4 pb-3"><ErrorAlert>{file.error.message}</ErrorAlert></div> : null}
            {actionError ? <div className="px-4"><ErrorAlert>{actionError}</ErrorAlert></div> : null}
            {actionInfo ? <div className="px-4"><InfoAlert>{actionInfo}</InfoAlert></div> : null}

            {mode === "source" ? (
              <textarea
                className="textarea min-h-[28rem] rounded-none border-0 font-mono text-sm"
                value={content}
                aria-label="Source"
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                  setActionInfo("");
                }}
              />
            ) : null}

            {mode === "split" ? (
              <div className="grid min-h-[28rem] lg:grid-cols-2">
                <textarea
                  className="textarea min-h-[28rem] rounded-none border-0 font-mono text-sm lg:border-r lg:border-border"
                  value={content}
                  aria-label="Source"
                  onChange={(e) => {
                    setContent(e.target.value);
                    setDirty(true);
                    setActionInfo("");
                  }}
                />
                <HtmlPreview html={doc.html} />
              </div>
            ) : null}

            {mode === "visual" ? (
              <VisualEditor
                blocks={blocks}
                onChange={(next) => {
                  setBlocks(next);
                  setDirty(true);
                  setActionInfo("");
                }}
              />
            ) : null}

            <div className="grid gap-3 border-t border-border px-4 py-4 sm:grid-cols-[1fr_auto_auto]">
              <Field label="Commit message" htmlFor="commit-message">
                <input
                  id="commit-message"
                  className="input"
                  value={commitMessage}
                  placeholder="docs: update from LoreLink"
                  onChange={(e) => setCommitMessage(e.target.value)}
                />
              </Field>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={save.isPending || !path}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? "Saving..." : dirty ? "Save" : "Saved"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={commit.isPending}
                  onClick={() => commit.mutate()}
                >
                  {commit.isPending ? "Committing..." : "Commit"}
                </button>
              </div>
              <div className="flex items-end justify-end">
                <button
                  type="button"
                  className="btn btn-ghost text-destructive"
                  disabled={removeFile.isPending || !path}
                  onClick={() => {
                    if (!confirmDelete) {
                      setConfirmDelete(true);
                      return;
                    }
                    removeFile.mutate();
                  }}
                >
                  <IconTrash />
                  {confirmDelete ? (removeFile.isPending ? "Deleting..." : "Confirm delete") : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function FileRow({ entry, active, onOpen }: { entry: FileEntry; active: boolean; onOpen: (path: string) => void }) {
  const depth = entry.path.split("/").filter(Boolean).length - 1;
  if (entry.dir) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground" style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}>
        <IconFolder />
        <span>{entry.name}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={active ? "nav-link nav-link-active w-full justify-start" : "nav-link w-full justify-start"}
      style={{ paddingLeft: `${0.7 + depth * 0.85}rem` }}
      onClick={() => onOpen(entry.path)}
    >
      <IconFile />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

function HtmlPreview({ html }: { html: string }) {
  return (
    <div className="min-h-[28rem] overflow-auto bg-background px-5 py-4">
      <p className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">LoreMark preview</p>
      {html ? (
        <div className="docs-prose" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="text-sm text-muted-foreground">Preview updates from the server after you save.</p>
      )}
    </div>
  );
}

function VisualEditor({ blocks, onChange }: { blocks: LoreBlock[]; onChange: (blocks: LoreBlock[]) => void }) {
  function update(index: number, patch: Partial<LoreBlock>) {
    onChange(blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)));
  }

  function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= blocks.length) return;
    const copy = [...blocks];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onChange(copy);
  }

  function remove(index: number) {
    onChange(blocks.filter((_, i) => i !== index));
  }

  function add(type: LoreBlock["type"]) {
    const block: LoreBlock =
      type === "heading"
        ? { type, level: 2, text: "" }
        : type === "ul" || type === "ol"
          ? { type, items: [""] }
          : type === "code"
            ? { type, lang: "", text: "" }
            : type === "callout"
              ? { type, kind: "note", text: "" }
              : { type: "paragraph", text: "" };
    onChange([...blocks, block]);
  }

  return (
    <div className="grid gap-4 px-4 py-4">
      {blocks.length === 0 ? <p className="text-sm text-muted-foreground">No blocks yet. Add a heading or paragraph.</p> : null}
      {blocks.map((block, index) => (
        <article key={`${block.type}-${index}-${block.id ?? ""}`} className="rounded-lg border border-border p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="badge">{block.type}</span>
            <div className="flex gap-1">
              <button type="button" className="btn btn-ghost" onClick={() => move(index, -1)} disabled={index === 0}>
                Up
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => move(index, 1)} disabled={index === blocks.length - 1}>
                Down
              </button>
              <button type="button" className="btn btn-ghost text-destructive" onClick={() => remove(index)}>
                Remove
              </button>
            </div>
          </div>
          {block.type === "heading" ? (
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="Level" htmlFor={`heading-level-${index}`}>
                <select
                  id={`heading-level-${index}`}
                  className="select"
                  value={block.level ?? 2}
                  onChange={(e) => update(index, { level: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6].map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Text" htmlFor={`heading-text-${index}`}>
                <input
                  id={`heading-text-${index}`}
                  className="input"
                  value={block.text ?? ""}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
              </Field>
            </div>
          ) : null}
          {block.type === "paragraph" ? (
            <Field label="Paragraph" htmlFor={`para-${index}`}>
              <textarea
                id={`para-${index}`}
                className="textarea"
                rows={3}
                value={block.text ?? ""}
                onChange={(e) => update(index, { text: e.target.value })}
              />
            </Field>
          ) : null}
          {block.type === "ul" || block.type === "ol" ? (
            <Field label={block.type === "ul" ? "Bullets (one per line)" : "Numbered items (one per line)"} htmlFor={`list-${index}`}>
              <textarea
                id={`list-${index}`}
                className="textarea"
                rows={4}
                value={(block.items ?? []).join("\n")}
                onChange={(e) => update(index, { items: e.target.value.split("\n") })}
              />
            </Field>
          ) : null}
          {block.type === "code" ? (
            <div className="grid gap-3">
              <Field label="Language" htmlFor={`code-lang-${index}`}>
                <input
                  id={`code-lang-${index}`}
                  className="input"
                  value={block.lang ?? ""}
                  onChange={(e) => update(index, { lang: e.target.value })}
                />
              </Field>
              <Field label="Code" htmlFor={`code-text-${index}`}>
                <textarea
                  id={`code-text-${index}`}
                  className="textarea font-mono"
                  rows={6}
                  value={block.text ?? ""}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
              </Field>
            </div>
          ) : null}
          {block.type === "callout" ? (
            <div className="grid gap-3">
              <Field label="Kind" htmlFor={`callout-kind-${index}`}>
                <select
                  id={`callout-kind-${index}`}
                  className="select"
                  value={block.kind ?? "note"}
                  onChange={(e) => update(index, { kind: e.target.value })}
                >
                  <option value="note">note</option>
                  <option value="tip">tip</option>
                  <option value="info">info</option>
                  <option value="warning">warning</option>
                  <option value="danger">danger</option>
                </select>
              </Field>
              <Field label="Body" htmlFor={`callout-text-${index}`}>
                <textarea
                  id={`callout-text-${index}`}
                  className="textarea"
                  rows={4}
                  value={block.text ?? ""}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
              </Field>
            </div>
          ) : null}
          {block.type === "table" ? (
            <p className="text-sm text-muted-foreground">Tables are preserved. Switch to Source to edit table rows.</p>
          ) : null}
          {!["heading", "paragraph", "ul", "ol", "code", "callout", "table"].includes(block.type) ? (
            <Field label="Text" htmlFor={`block-text-${index}`}>
              <textarea
                id={`block-text-${index}`}
                className="textarea"
                rows={3}
                value={block.text ?? ""}
                onChange={(e) => update(index, { text: e.target.value })}
              />
            </Field>
          ) : null}
        </article>
      ))}
      <div className="flex flex-wrap gap-2">
        {(["heading", "paragraph", "ul", "ol", "code", "callout"] as const).map((type) => (
          <button key={type} type="button" className="btn btn-ghost" onClick={() => add(type)}>
            Add {type}
          </button>
        ))}
      </div>
    </div>
  );
}
