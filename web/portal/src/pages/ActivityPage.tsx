import { useQuery } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { api } from "../api";
import { PageHeader } from "../ui/PageHeader";
import type { ShellContext } from "./Shell";

export function ActivityPage() {
  const { orgID, org } = useOutletContext<ShellContext>();
  const activity = useQuery({
    queryKey: ["activity", orgID],
    queryFn: () => api.activity(orgID),
    enabled: Boolean(orgID),
  });

  return (
    <div>
      <PageHeader
        crumbs={[org?.name ?? "Organisation", "Activity"]}
        title="Activity"
        lede="Audit events for this organisation. Secrets are never stored here."
      />

      {activity.isLoading ? (
        <div className="mt-10 flex items-center gap-3 text-muted-foreground">
          <span className="spinner" />
          Loading activity
        </div>
      ) : null}

      {activity.data?.events.length === 0 ? (
        <section className="panel mt-8 px-6 py-10 sm:px-10">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">No recorded activity yet</h2>
          <p className="page-lede mt-3">
            Creating projects, inviting members, and signing in write audit events for this organisation.
          </p>
        </section>
      ) : null}

      {activity.data && activity.data.events.length > 0 ? (
        <div className="panel mt-8 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {activity.data.events.map((ev) => (
                <tr key={ev.id}>
                  <td className="font-mono text-sm">{ev.action}</td>
                  <td className="text-sm text-muted-foreground">{ev.target || "no target"}</td>
                  <td className="text-sm text-muted-foreground">{new Date(ev.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
