import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { ErrorAlert } from "../ui/states";

export function ApiKeysPage() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.apiKeys });
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () => api.createAPIKey(name.trim()),
    onSuccess: async (key) => {
      setName("");
      setSecret(key.secret ?? "");
      setError("");
      await qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div>
      <PageHeader
        crumbs={["Account", "API keys"]}
        title="API keys"
        lede="Keys use the ASPEC api-keys format (HMAC pepper, scopes, rotation). The secret is shown once."
      />

      <section className="panel mt-8 px-5 py-6 sm:px-6">
        <h2 className="font-serif text-xl font-semibold tracking-tight">Create a key</h2>
        <form
          className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name" htmlFor="key-name">
            <input id="key-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="CLI, CI, integration" />
          </Field>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary" disabled={create.isPending}>
              {create.isPending ? "Creating..." : "Create key"}
            </button>
          </div>
        </form>
        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        {secret ? (
          <div role="alert" className="alert alert-info mt-4">
            Copy this secret now. It will not be shown again.
            <pre className="mt-2 overflow-x-auto font-mono text-xs">{secret}</pre>
          </div>
        ) : null}
      </section>

      {keys.isLoading ? (
        <div className="mt-8 flex items-center gap-3 text-muted-foreground">
          <span className="spinner" />
          Loading keys
        </div>
      ) : (
        <div className="panel mt-6 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Status</th>
                <th>Uses</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(keys.data?.keys ?? []).map((k) => (
                <tr key={k.id}>
                  <td>
                    <div className="font-medium">{k.name}</div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{k.display_prefix}</div>
                  </td>
                  <td>
                    <span className="badge">{k.status}</span>
                  </td>
                  <td className="text-sm text-muted-foreground">{k.use_count}</td>
                  <td className="text-right">
                    {k.status === "active" ? (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={async () => {
                            try {
                              const rotated = await api.rotateAPIKey(k.id);
                              setSecret(rotated.secret);
                              setError("");
                              await qc.invalidateQueries({ queryKey: ["api-keys"] });
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "could not rotate key");
                            }
                          }}
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={async () => {
                            try {
                              await api.revokeAPIKey(k.id);
                              await qc.invalidateQueries({ queryKey: ["api-keys"] });
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "could not revoke key");
                            }
                          }}
                        >
                          Revoke
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(keys.data?.keys ?? []).length === 0 ? <p className="px-5 py-6 text-sm text-muted-foreground">No API keys yet.</p> : null}
        </div>
      )}
    </div>
  );
}
