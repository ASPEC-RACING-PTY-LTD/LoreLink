import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { PageHeader } from "../ui/PageHeader";

export function InstancePage() {
  const instance = useQuery({ queryKey: ["instance"], queryFn: api.instance });
  const users = useQuery({ queryKey: ["instance-users"], queryFn: api.instanceUsers });

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
        lede="Instance-wide settings and accounts. This view is limited to instance.admin."
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
            <dd className="mt-1">
              <span className="badge">{instance.data?.portal_enabled ? "enabled" : "disabled"}</span>
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

      <h2 className="mt-10 font-serif text-xl font-semibold tracking-tight">Users</h2>
      <p className="mt-1 text-sm text-muted-foreground">Every account on this instance.</p>
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
                  </td>
                  <td>
                    <span className="badge">{u.instance_capabilities.includes("instance.admin") ? "instance.admin" : "none"}</span>
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
