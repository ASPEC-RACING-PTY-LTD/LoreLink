export type ApiError = { error: { code: string; message: string } };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = data as ApiError;
    throw new Error(err.error?.message ?? `request failed (${res.status})`);
  }
  return data as T;
}

export type User = {
  id: string;
  email: string;
  name: string;
  status: string;
  instance_capabilities: string[];
  role?: { id: string; name: string; capabilities: string[] };
};

export type Organisation = { id: string; slug: string; name: string };
export type Project = {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string;
  visibility: string;
  docs_root: string;
  default_branch: string;
  publish_policy: string;
};
export type Role = { id: string; name: string; capabilities: string[] };
export type Instance = {
  id: string;
  name: string;
  public_base_url: string;
  portal_enabled: boolean;
  setup_completed: boolean;
};
export type AuditEvent = {
  id: string;
  action: string;
  target: string;
  created_at: string;
};

export const api = {
  setupStatus: () =>
    fetch("/api/v1/setup/status", { credentials: "include" }).then(async (res) => {
      if (res.status === 404) return { completed: true };
      if (!res.ok) throw new Error("could not read setup status");
      return res.json() as Promise<{ completed: boolean }>;
    }),
  setup: (body: Record<string, string>) =>
    request<{ completed: boolean }>("/api/v1/setup", { method: "POST", body: JSON.stringify(body) }),
  login: (email: string, password: string) =>
    request<{ ok: boolean }>("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
  me: () => request<{ user: User; organisations: Organisation[]; instance: Instance | null }>("/api/v1/me"),
  instance: () => request<Instance>("/api/v1/instance"),
  instanceUsers: () => request<{ users: User[] }>("/api/v1/instance/users"),
  roles: () => request<{ roles: Role[] }>("/api/v1/roles"),
  members: (orgID: string) => request<{ members: User[] }>(`/api/v1/orgs/${orgID}/members`),
  invite: (orgID: string, email: string, role_id: string) =>
    request<{ token: string; email: string; role: string }>(`/api/v1/orgs/${orgID}/invitations`, {
      method: "POST",
      body: JSON.stringify({ email, role_id }),
    }),
  invitation: (token: string) =>
    request<{ email: string; organisation: Organisation; role: Role }>(`/api/v1/invitations/${token}`),
  acceptInvitation: (token: string, name: string, password: string) =>
    request<{ ok: boolean }>(`/api/v1/invitations/${token}/accept`, {
      method: "POST",
      body: JSON.stringify({ name, password }),
    }),
  projects: (orgID: string) => request<{ projects: Project[] }>(`/api/v1/orgs/${orgID}/projects`),
  createProject: (orgID: string, body: Record<string, string>) =>
    request<Project>(`/api/v1/orgs/${orgID}/projects`, { method: "POST", body: JSON.stringify(body) }),
  activity: (orgID: string) => request<{ events: AuditEvent[] }>(`/api/v1/orgs/${orgID}/activity`),
};
