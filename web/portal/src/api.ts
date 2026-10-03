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

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => asString(item)).filter(Boolean);
}

export type User = {
  id: string;
  email: string;
  name: string;
  display_name?: string;
  status: string;
  instance_capabilities: string[];
  suspend_reason?: string;
  last_login_at?: string | null;
  created_at?: string;
  role?: { id: string; name: string; capabilities: string[] };
};
export type APIKey = {
  id: string;
  public_id: string;
  display_prefix: string;
  name: string;
  scopes: string[];
  status: string;
  created_at: number;
  last_used_at?: number | null;
  use_count: number;
  secret?: string;
};
export type Permission = { key: string; description: string; system: boolean };
export type RBACRole = {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  system: boolean;
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
  host: string;
  base_path: string;
  binding?: Binding | null;
};
export type Binding = {
  connection_id: string;
  repo_url: string;
  repo_full_name: string;
  default_branch: string;
  docs_root: string;
  generated_roots: string[];
  last_synced_sha: string;
  last_synced_at: string | null;
  poll_fallback: boolean;
  status: string;
  status_error: string;
  webhook_id: string;
};
export type Role = { id: string; name: string; capabilities: string[]; org_id?: string | null };
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
export type Connection = {
  id: string;
  org_id: string;
  provider: string;
  display_name: string;
  base_url: string;
  auth_kind: string;
  created_at: string;
};
export type ConnectionCreate = {
  provider: "generic" | "codehold" | "github" | string;
  display_name: string;
  base_url?: string;
  auth_kind?: string;
  token?: string;
  username?: string;
  password?: string;
};
export type Repo = {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
};
export type FileEntry = {
  path: string;
  name: string;
  dir: boolean;
  bytes: number;
};
export type LoreBlock = {
  type: string;
  level?: number;
  lang?: string;
  text?: string;
  items?: string[];
  kind?: string;
  rows?: string[][];
  id?: string;
};
export type LoreDoc = {
  title: string;
  description: string;
  html: string;
  text: string;
  headings: { level: number; text: string; id: string }[];
  blocks: LoreBlock[];
};
export type ProjectFile = {
  path: string;
  content: string;
  doc: LoreDoc;
};
export type Lease = {
  token: string;
  expires_at: string;
  path: string;
};
export type Job = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string;
  created_at: string;
  updated_at: string;
};
export type DocVersion = {
  id: string;
  project_id: string;
  name: string;
  alias: string;
  git_ref: string;
  immutable: boolean;
  created_at: string;
};
export type PublishRun = {
  id: string;
  project_id: string;
  target: string;
  version_name: string;
  status: string;
  artifact_path: string;
  public_url: string;
  error: string;
  created_at: string;
  finished_at: string | null;
};
export type SearchHit = {
  path: string;
  title: string;
  headings: string;
  body: string;
};
export type Mapping = {
  id: string;
  project_id: string;
  source_match: string;
  extractor: string;
  output: string;
  options_json: string;
  created_at: string;
};
export type MaintainerReport = {
  enabled: boolean;
  findings: { level: string; mapping: string; message: string; path?: string }[];
  coverage: { mappings: number; sources: number; outputs: number; drift: number };
  explain?: { output: string; source: string; excerpt: string }[];
};
export type Team = {
  id: string;
  org_id: string;
  name: string;
};
export type ProjectPatch = {
  name?: string;
  description?: string;
  visibility?: string;
  docs_root?: string;
  default_branch?: string;
  publish_policy?: string;
  host?: string;
  base_path?: string;
};
export type BindBody = {
  connection_id: string;
  repo_url: string;
  repo_full_name: string;
  default_branch: string;
  docs_root: string;
  generated_roots: string[];
};

export function normalizeBinding(raw: unknown): Binding {
  const obj = rec(raw);
  const syncedAt = pick(obj, "last_synced_at", "LastSyncedAt");
  return {
    connection_id: asString(pick(obj, "connection_id", "ConnectionID")),
    repo_url: asString(pick(obj, "repo_url", "RepoURL")),
    repo_full_name: asString(pick(obj, "repo_full_name", "RepoFullName")),
    default_branch: asString(pick(obj, "default_branch", "DefaultBranch")),
    docs_root: asString(pick(obj, "docs_root", "DocsRoot")),
    generated_roots: asStringList(pick(obj, "generated_roots", "GeneratedRoots")),
    last_synced_sha: asString(pick(obj, "last_synced_sha", "LastSyncedSHA")),
    last_synced_at: syncedAt == null ? null : asString(syncedAt),
    poll_fallback: asBool(pick(obj, "poll_fallback", "PollFallback")),
    status: asString(pick(obj, "status", "Status")),
    status_error: asString(pick(obj, "status_error", "StatusError")),
    webhook_id: asString(pick(obj, "webhook_id", "WebhookID")),
  };
}

export function normalizeProject(raw: unknown): Project {
  const obj = rec(raw);
  const nested = pick(obj, "binding", "Binding");
  return {
    id: asString(pick(obj, "id", "ID")),
    org_id: asString(pick(obj, "org_id", "OrgID")),
    name: asString(pick(obj, "name", "Name")),
    slug: asString(pick(obj, "slug", "Slug")),
    description: asString(pick(obj, "description", "Description")),
    visibility: asString(pick(obj, "visibility", "Visibility"), "private"),
    docs_root: asString(pick(obj, "docs_root", "DocsRoot"), "docs"),
    default_branch: asString(pick(obj, "default_branch", "DefaultBranch"), "main"),
    publish_policy: asString(pick(obj, "publish_policy", "PublishPolicy")),
    host: asString(pick(obj, "host", "Host")),
    base_path: asString(pick(obj, "base_path", "BasePath")),
    binding: nested ? normalizeBinding(nested) : undefined,
  };
}

function normalizeOrg(raw: unknown): Organisation {
  const obj = rec(raw);
  return {
    id: asString(pick(obj, "id", "ID")),
    slug: asString(pick(obj, "slug", "Slug")),
    name: asString(pick(obj, "name", "Name")),
  };
}

function normalizeInstance(raw: unknown): Instance | null {
  if (!raw) return null;
  const obj = rec(raw);
  return {
    id: asString(pick(obj, "id", "ID")),
    name: asString(pick(obj, "name", "Name")),
    public_base_url: asString(pick(obj, "public_base_url", "PublicBaseURL", "public_url")),
    portal_enabled: asBool(pick(obj, "portal_enabled", "PortalEnabled"), true),
    setup_completed: asBool(pick(obj, "setup_completed", "setup_completed_at", "SetupCompleted")),
  };
}

function normalizeUser(raw: unknown): User {
  const obj = rec(raw);
  const roleRaw = rec(pick(obj, "role", "Role"));
  const caps = pick(obj, "instance_capabilities", "InstanceCapabilities");
  const roleCaps = pick(roleRaw, "capabilities", "Capabilities");
  const roleID = asString(pick(roleRaw, "id", "ID"));
  return {
    id: asString(pick(obj, "id", "ID")),
    email: asString(pick(obj, "email", "Email")),
    name: asString(pick(obj, "name", "Name")),
    display_name: asString(pick(obj, "display_name", "DisplayName")) || undefined,
    status: asString(pick(obj, "status", "Status")),
    instance_capabilities: asStringList(caps),
    suspend_reason: asString(pick(obj, "suspend_reason", "SuspendReason")) || undefined,
    last_login_at: (() => {
      const v = pick(obj, "last_login_at", "LastLoginAt");
      return v == null ? null : asString(v);
    })(),
    created_at: asString(pick(obj, "created_at", "CreatedAt")) || undefined,
    role: roleID
      ? {
          id: roleID,
          name: asString(pick(roleRaw, "name", "Name")),
          capabilities: asStringList(roleCaps),
        }
      : undefined,
  };
}

function normalizeConnection(raw: unknown): Connection {
  const obj = rec(raw);
  return {
    id: asString(pick(obj, "id", "ID")),
    org_id: asString(pick(obj, "org_id", "OrgID")),
    provider: asString(pick(obj, "provider", "Provider")),
    display_name: asString(pick(obj, "display_name", "DisplayName")),
    base_url: asString(pick(obj, "base_url", "BaseURL")),
    auth_kind: asString(pick(obj, "auth_kind", "AuthKind")),
    created_at: asString(pick(obj, "created_at", "CreatedAt")),
  };
}

function normalizeRepo(raw: unknown): Repo {
  const obj = rec(raw);
  return {
    full_name: asString(pick(obj, "full_name", "FullName")),
    clone_url: asString(pick(obj, "clone_url", "CloneURL")),
    default_branch: asString(pick(obj, "default_branch", "DefaultBranch"), "main"),
    private: asBool(pick(obj, "private", "Private")),
  };
}

function normalizeFileEntry(raw: unknown): FileEntry {
  const obj = rec(raw);
  return {
    path: asString(pick(obj, "path", "Path")),
    name: asString(pick(obj, "name", "Name")),
    dir: asBool(pick(obj, "dir", "Dir")),
    bytes: asNumber(pick(obj, "bytes", "Bytes")),
  };
}

function normalizeBlock(raw: unknown): LoreBlock {
  const obj = rec(raw);
  const rows = pick(obj, "rows", "Rows");
  return {
    type: asString(pick(obj, "type", "Type"), "paragraph"),
    level: asNumber(pick(obj, "level", "Level")) || undefined,
    lang: asString(pick(obj, "lang", "Lang")) || undefined,
    text: asString(pick(obj, "text", "Text")) || undefined,
    items: Array.isArray(pick(obj, "items", "Items")) ? asStringList(pick(obj, "items", "Items")) : undefined,
    kind: asString(pick(obj, "kind", "Kind")) || undefined,
    rows: Array.isArray(rows) ? (rows as unknown[]).map((row) => (Array.isArray(row) ? row.map((cell) => asString(cell)) : [])) : undefined,
    id: asString(pick(obj, "id", "ID")) || undefined,
  };
}

function normalizeDoc(raw: unknown): LoreDoc {
  const obj = rec(raw);
  const headings = pick(obj, "headings", "Headings");
  const blocks = pick(obj, "blocks", "Blocks");
  return {
    title: asString(pick(obj, "title", "Title")),
    description: asString(pick(obj, "description", "Description")),
    html: asString(pick(obj, "html", "HTML")),
    text: asString(pick(obj, "text", "Text")),
    headings: Array.isArray(headings)
      ? headings.map((h) => {
          const item = rec(h);
          return {
            level: asNumber(pick(item, "level", "Level"), 1),
            text: asString(pick(item, "text", "Text")),
            id: asString(pick(item, "id", "ID")),
          };
        })
      : [],
    blocks: Array.isArray(blocks) ? blocks.map(normalizeBlock) : [],
  };
}

function normalizeLease(raw: unknown): Lease {
  const obj = rec(raw);
  return {
    token: asString(pick(obj, "token", "Token")),
    expires_at: asString(pick(obj, "expires_at", "ExpiresAt")),
    path: asString(pick(obj, "path", "Path")),
  };
}

function normalizeJob(raw: unknown): Job {
  const obj = rec(raw);
  return {
    id: asString(pick(obj, "id", "ID")),
    kind: asString(pick(obj, "kind", "Kind")),
    status: asString(pick(obj, "status", "Status")),
    attempts: asNumber(pick(obj, "attempts", "Attempts")),
    last_error: asString(pick(obj, "last_error", "LastError")),
    created_at: asString(pick(obj, "created_at", "CreatedAt")),
    updated_at: asString(pick(obj, "updated_at", "UpdatedAt")),
  };
}

function normalizeVersion(raw: unknown): DocVersion {
  const obj = rec(raw);
  return {
    id: asString(pick(obj, "id", "ID")),
    project_id: asString(pick(obj, "project_id", "ProjectID")),
    name: asString(pick(obj, "name", "Name")),
    alias: asString(pick(obj, "alias", "Alias")),
    git_ref: asString(pick(obj, "git_ref", "GitRef")),
    immutable: asBool(pick(obj, "immutable", "Immutable")),
    created_at: asString(pick(obj, "created_at", "CreatedAt")),
  };
}

function normalizePublishRun(raw: unknown): PublishRun {
  const obj = rec(raw);
  const finished = pick(obj, "finished_at", "FinishedAt");
  return {
    id: asString(pick(obj, "id", "ID")),
    project_id: asString(pick(obj, "project_id", "ProjectID")),
    target: asString(pick(obj, "target", "Target")),
    version_name: asString(pick(obj, "version_name", "VersionName")),
    status: asString(pick(obj, "status", "Status")),
    artifact_path: asString(pick(obj, "artifact_path", "ArtifactPath")),
    public_url: asString(pick(obj, "public_url", "PublicURL")),
    error: asString(pick(obj, "error", "Error")),
    created_at: asString(pick(obj, "created_at", "CreatedAt")),
    finished_at: finished == null ? null : asString(finished),
  };
}

function normalizeSearchHit(raw: unknown): SearchHit {
  const obj = rec(raw);
  const headings = pick(obj, "headings", "Headings");
  return {
    path: asString(pick(obj, "path", "Path")),
    title: asString(pick(obj, "title", "Title")),
    headings: typeof headings === "string" ? headings : asStringList(headings).join(", "),
    body: asString(pick(obj, "body", "Body")),
  };
}

function normalizeMapping(raw: unknown): Mapping {
  const obj = rec(raw);
  const options = pick(obj, "options_json", "OptionsJSON");
  return {
    id: asString(pick(obj, "id", "ID")),
    project_id: asString(pick(obj, "project_id", "ProjectID")),
    source_match: asString(pick(obj, "source_match", "SourceMatch")),
    extractor: asString(pick(obj, "extractor", "Extractor")),
    output: asString(pick(obj, "output", "Output")),
    options_json: typeof options === "string" ? options : options ? JSON.stringify(options) : "",
    created_at: asString(pick(obj, "created_at", "CreatedAt")),
  };
}

function normalizeAPIKey(raw: unknown): APIKey {
  const obj = rec(raw);
  const lastUsed = pick(obj, "last_used_at", "LastUsedAt");
  return {
    id: asString(pick(obj, "id", "ID")),
    public_id: asString(pick(obj, "public_id", "PublicID")),
    display_prefix: asString(pick(obj, "display_prefix", "DisplayPrefix")),
    name: asString(pick(obj, "name", "Name")),
    scopes: asStringList(pick(obj, "scopes", "Scopes")),
    status: asString(pick(obj, "status", "Status")),
    created_at: asNumber(pick(obj, "created_at", "CreatedAt")),
    last_used_at: lastUsed == null ? null : asNumber(lastUsed),
    use_count: asNumber(pick(obj, "use_count", "UseCount")),
    secret: asString(pick(obj, "secret", "Secret")) || undefined,
  };
}

function normalizeTeam(raw: unknown): Team {
  const obj = rec(raw);
  return {
    id: asString(pick(obj, "id", "ID")),
    org_id: asString(pick(obj, "org_id", "OrgID")),
    name: asString(pick(obj, "name", "Name")),
  };
}

function listOf<T>(raw: unknown, key: string, alt: string, map: (item: unknown) => T): T[] {
  const obj = rec(raw);
  const items = pick(obj, key, alt);
  return Array.isArray(items) ? items.map(map) : [];
}

function projectPatchPayload(body: ProjectPatch) {
  return {
    name: body.name,
    Name: body.name,
    description: body.description,
    Description: body.description,
    visibility: body.visibility,
    Visibility: body.visibility,
    docs_root: body.docs_root,
    DocsRoot: body.docs_root,
    default_branch: body.default_branch,
    DefaultBranch: body.default_branch,
    publish_policy: body.publish_policy,
    PublishPolicy: body.publish_policy,
    host: body.host,
    Host: body.host,
    base_path: body.base_path,
    BasePath: body.base_path,
  };
}

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
  me: async () => {
    const data = rec(await request<unknown>("/api/v1/me"));
    return {
      user: normalizeUser(pick(data, "user", "User") ?? data),
      organisations: listOf(data, "organisations", "Organisations", normalizeOrg),
      instance: normalizeInstance(pick(data, "instance", "Instance")),
    };
  },
  createOrganisation: async (name: string, slug = "") =>
    normalizeOrg(await request<unknown>("/api/v1/orgs", { method: "POST", body: JSON.stringify({ name, slug }) })),
  instance: () => request<Instance>("/api/v1/instance"),
  patchInstance: (portal_enabled: boolean) =>
    request<Instance>("/api/v1/instance", { method: "PATCH", body: JSON.stringify({ portal_enabled }) }),
  instanceUsers: () => request<{ users: User[] }>("/api/v1/instance/users"),
  createUser: (body: { email: string; name: string; password: string; org_id?: string; role_id?: string }) =>
    request<User>("/api/v1/instance/users", { method: "POST", body: JSON.stringify(body) }),
  patchUser: (userID: string, body: { name?: string; email?: string }) =>
    request<User>(`/api/v1/instance/users/${userID}`, { method: "PATCH", body: JSON.stringify(body) }),
  suspendUser: (userID: string, reason: string) =>
    request<User>(`/api/v1/instance/users/${userID}/suspend`, { method: "POST", body: JSON.stringify({ reason }) }),
  activateUser: (userID: string) =>
    request<User>(`/api/v1/instance/users/${userID}/activate`, { method: "POST", body: "{}" }),
  issuePasswordReset: (userID: string) =>
    request<{ token: string; path: string }>(`/api/v1/instance/users/${userID}/password-reset`, { method: "POST", body: "{}" }),
  setInstanceAdmin: (userID: string, admin: boolean) =>
    request<User>(`/api/v1/instance/users/${userID}/instance-admin`, { method: "POST", body: JSON.stringify({ admin }) }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean }>("/api/v1/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) }),
  apiKeys: async () => {
    const data = await request<unknown>("/api/v1/me/api-keys");
    return { keys: listOf(data, "keys", "Keys", normalizeAPIKey) };
  },
  createAPIKey: async (name: string, scopes: string[] = []) =>
    normalizeAPIKey(await request<unknown>("/api/v1/me/api-keys", { method: "POST", body: JSON.stringify({ name, scopes }) })),
  revokeAPIKey: (keyID: string) => request<{ ok: boolean }>(`/api/v1/me/api-keys/${keyID}`, { method: "DELETE" }),
  rotateAPIKey: (keyID: string) =>
    request<{ secret: string; display_prefix: string; public_id: string }>(`/api/v1/me/api-keys/${keyID}/rotate`, {
      method: "POST",
      body: "{}",
    }),
  permissions: () => request<{ permissions: Permission[] }>("/api/v1/rbac/permissions"),
  rbacRoles: () => request<{ roles: RBACRole[] }>("/api/v1/rbac/roles"),
  orgRoles: (orgID: string) => request<{ roles: Role[] }>(`/api/v1/orgs/${orgID}/roles`),
  createOrgRole: (orgID: string, name: string, capabilities: string[]) =>
    request<Role>(`/api/v1/orgs/${orgID}/roles`, { method: "POST", body: JSON.stringify({ name, capabilities }) }),
  changeMemberRole: (orgID: string, userID: string, role_id: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/members/${userID}`, {
      method: "PATCH",
      body: JSON.stringify({ role_id }),
    }),
  removeMember: (orgID: string, userID: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/members/${userID}`, { method: "DELETE" }),
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
  projects: async (orgID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects`);
    return { projects: listOf(data, "projects", "Projects", normalizeProject) };
  },
  createProject: async (orgID: string, body: Record<string, string>) =>
    normalizeProject(await request<unknown>(`/api/v1/orgs/${orgID}/projects`, { method: "POST", body: JSON.stringify(body) })),
  project: async (orgID: string, projectID: string) => {
    const data = rec(await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}`));
    const bindingRaw = pick(data, "binding", "Binding");
    return {
      project: normalizeProject(pick(data, "project", "Project") ?? data),
      binding: bindingRaw ? normalizeBinding(bindingRaw) : null,
    };
  },
  patchProject: async (orgID: string, projectID: string, body: ProjectPatch) =>
    normalizeProject(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}`, {
        method: "PATCH",
        body: JSON.stringify(projectPatchPayload(body)),
      }),
    ),
  connections: async (orgID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/connections`);
    return { connections: listOf(data, "connections", "Connections", normalizeConnection) };
  },
  createConnection: async (orgID: string, body: ConnectionCreate) => {
    const data = rec(
      await request<unknown>(`/api/v1/orgs/${orgID}/connections`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return {
      connection: normalizeConnection(pick(data, "connection", "Connection") ?? data),
      warning: asString(pick(data, "warning", "Warning")) || undefined,
    };
  },
  connectionRepos: async (orgID: string, connectionID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/connections/${connectionID}/repos`);
    return { repos: listOf(data, "repos", "Repos", normalizeRepo) };
  },
  deleteConnection: (orgID: string, connectionID: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/connections/${connectionID}`, { method: "DELETE" }),
  bindProject: async (orgID: string, projectID: string, body: BindBody) => {
    const data = rec(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/bind`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const bindingRaw = pick(data, "binding", "Binding");
    return {
      binding: bindingRaw ? normalizeBinding(bindingRaw) : null,
      poll_fallback: asBool(pick(data, "poll_fallback", "PollFallback")),
    };
  },
  syncProject: async (orgID: string, projectID: string) =>
    normalizeJob(await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/sync`, { method: "POST", body: "{}" })),
  jobs: async (orgID: string, projectID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/jobs`);
    return { jobs: listOf(data, "jobs", "Jobs", normalizeJob) };
  },
  files: async (orgID: string, projectID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/files`);
    return { files: listOf(data, "files", "Files", normalizeFileEntry) };
  },
  file: async (orgID: string, projectID: string, path: string) => {
    const data = rec(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/file?path=${encodeURIComponent(path)}`),
    );
    return {
      path: asString(pick(data, "path", "Path"), path),
      content: asString(pick(data, "content", "Content")),
      doc: normalizeDoc(pick(data, "doc", "Doc")),
    } satisfies ProjectFile;
  },
  putFile: async (
    orgID: string,
    projectID: string,
    body: { path: string; content?: string; blocks?: LoreBlock[]; lease?: string },
  ) => {
    const data = rec(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/file`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
    return { ok: true, doc: normalizeDoc(pick(data, "doc", "Doc")) };
  },
  deleteFile: (orgID: string, projectID: string, path: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/projects/${projectID}/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  acquireLease: async (orgID: string, projectID: string, path: string) =>
    normalizeLease(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/lease`, {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    ),
  releaseLease: (orgID: string, projectID: string, token: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/projects/${projectID}/lease?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
    }),
  commit: (orgID: string, projectID: string, message: string) =>
    request<{ sha: string }>(`/api/v1/orgs/${orgID}/projects/${projectID}/commit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  versions: async (orgID: string, projectID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/versions`);
    return { versions: listOf(data, "versions", "Versions", normalizeVersion) };
  },
  createVersion: async (
    orgID: string,
    projectID: string,
    body: { name: string; alias?: string; git_ref?: string; immutable?: boolean },
  ) =>
    normalizeVersion(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/versions`, {
        method: "POST",
        body: JSON.stringify({
          name: body.name,
          alias: body.alias ?? "",
          git_ref: body.git_ref ?? "",
          immutable: Boolean(body.immutable),
          Name: body.name,
          Alias: body.alias ?? "",
          GitRef: body.git_ref ?? "",
          Immutable: Boolean(body.immutable),
        }),
      }),
    ),
  publish: async (orgID: string, projectID: string, body: { target: "hosted" | "filesystem" | "download" | string; version: string }) =>
    normalizePublishRun(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/publish`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    ),
  publishRuns: async (orgID: string, projectID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/publish`);
    return { runs: listOf(data, "runs", "Runs", normalizePublishRun) };
  },
  publishDownloadURL: (orgID: string, projectID: string, runID: string) =>
    `/api/v1/orgs/${orgID}/projects/${projectID}/publish/${runID}/download`,
  search: async (orgID: string, projectID: string, q: string, version = "") => {
    const params = new URLSearchParams();
    params.set("q", q);
    if (version) params.set("version", version);
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/search?${params.toString()}`);
    return { results: listOf(data, "results", "Results", normalizeSearchHit) };
  },
  reindex: async (orgID: string, projectID: string) =>
    normalizeJob(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/search/reindex`, {
        method: "POST",
        body: "{}",
      }),
    ),
  mappings: async (orgID: string, projectID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/maintainer/mappings`);
    return { mappings: listOf(data, "mappings", "Mappings", normalizeMapping) };
  },
  createMapping: async (
    orgID: string,
    projectID: string,
    body: { source_match: string; extractor: string; output: string; options_json?: string },
  ) =>
    normalizeMapping(
      await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/maintainer/mappings`, {
        method: "POST",
        body: JSON.stringify({
          source_match: body.source_match,
          extractor: body.extractor,
          output: body.output,
          options_json: body.options_json ?? "",
          SourceMatch: body.source_match,
          Extractor: body.extractor,
          Output: body.output,
          OptionsJSON: body.options_json ?? "",
        }),
      }),
    ),
  deleteMapping: (orgID: string, projectID: string, mappingID: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/projects/${projectID}/maintainer/mappings/${mappingID}`, {
      method: "DELETE",
    }),
  maintainerAction: (orgID: string, projectID: string, action: "check" | "sync" | "explain") =>
    request<MaintainerReport>(`/api/v1/orgs/${orgID}/projects/${projectID}/maintainer/${action}`, {
      method: "POST",
      body: "{}",
    }),
  teams: async (orgID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/teams`);
    return { teams: listOf(data, "teams", "Teams", normalizeTeam) };
  },
  createTeam: async (orgID: string, name: string) =>
    normalizeTeam(await request<unknown>(`/api/v1/orgs/${orgID}/teams`, { method: "POST", body: JSON.stringify({ name }) })),
  teamMembers: async (orgID: string, teamID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/teams/${teamID}/members`);
    return { members: listOf(data, "members", "Members", normalizeUser) };
  },
  addTeamMember: (orgID: string, teamID: string, user_id: string) =>
    request<{ ok: boolean }>(`/api/v1/orgs/${orgID}/teams/${teamID}/members`, {
      method: "POST",
      body: JSON.stringify({ user_id }),
    }),
  redirects: async (orgID: string, projectID: string) => {
    const data = await request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/redirects`);
    return {
      redirects: listOf(data, "redirects", "Redirects", (raw) => {
        const obj = rec(raw);
        return {
          id: asString(pick(obj, "id", "ID")),
          from_path: asString(pick(obj, "from_path", "FromPath")),
          to_path: asString(pick(obj, "to_path", "ToPath")),
        };
      }),
    };
  },
  createRedirect: (orgID: string, projectID: string, from_path: string, to_path: string) =>
    request<unknown>(`/api/v1/orgs/${orgID}/projects/${projectID}/redirects`, {
      method: "POST",
      body: JSON.stringify({ from_path, to_path, FromPath: from_path, ToPath: to_path }),
    }),
  activity: (orgID: string) => request<{ events: AuditEvent[] }>(`/api/v1/orgs/${orgID}/activity`),
};
