import { initTheme, type LoreLinkTheme } from "@lorelink/shared/theme";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, type Organisation, type User } from "../api";
import { BrandMark } from "../ui/BrandMark";
import { IconActivity, IconAdmin, IconDocs, IconMembers, IconMenu, IconProjects } from "../ui/icons";
import { ThemeToggle } from "../ui/ThemeToggle";

type Me = { user: User; organisations: Organisation[]; instance: { name: string } | null };

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? "nav-link nav-link-active" : "nav-link";
}

export function Shell({ me }: { me: Me }) {
  const [orgID, setOrgID] = useState(me.organisations[0]?.id ?? "");
  const [theme, setTheme] = useState<LoreLinkTheme>(() => initTheme());
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isInstanceAdmin = me.user.instance_capabilities.includes("instance.admin");
  const org = me.organisations.find((o) => o.id === orgID) ?? me.organisations[0];
  const initials = me.user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  async function logout() {
    await api.logout();
    await qc.clear();
    navigate("/login");
  }

  function closeNav() {
    setNavOpen(false);
  }

  const navigation = (
    <>
      <div className="border-b border-border px-5 py-5">
        <BrandMark />
      </div>
      <nav className="flex-1 px-3 py-4" aria-label="Portal">
        <p className="nav-title">Organisation</p>
        <NavLink to="/" end className={navClass} onClick={closeNav}>
          <IconProjects />
          Projects
        </NavLink>
        <NavLink to="/members" className={navClass} onClick={closeNav}>
          <IconMembers />
          Members
        </NavLink>
        <NavLink to="/activity" className={navClass} onClick={closeNav}>
          <IconActivity />
          Activity
        </NavLink>
        {isInstanceAdmin ? (
          <>
            <p className="nav-title">Instance</p>
            <NavLink to="/instance" className={navClass} onClick={closeNav}>
              <IconAdmin />
              Administration
            </NavLink>
          </>
        ) : null}
        <p className="nav-title">Reading</p>
        <a className="nav-link" href="/view/" onClick={closeNav}>
          <IconDocs />
          Docs site
        </a>
      </nav>
      <div className="border-t border-border px-5 py-4 text-sm">
        <p className="font-medium">{me.user.name}</p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{me.user.email}</p>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[var(--sidebar-w)_1fr]">
      <aside className="hidden min-h-screen flex-col border-r border-border bg-sidebar lg:flex">{navigation}</aside>

      {navOpen ? (
        <div className="lg:hidden">
          <button type="button" className="overlay" aria-label="Close navigation" onClick={closeNav} />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-sidebar">{navigation}</aside>
        </div>
      ) : null}

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="btn btn-ghost btn-square lg:hidden" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
              <IconMenu />
            </button>
            <span className="hidden sm:inline lg:hidden">
              <BrandMark size="sm" />
            </span>
            <div className="min-w-0">
              {me.organisations.length > 1 ? (
                <select className="select max-w-48 sm:max-w-xs" value={orgID} onChange={(e) => setOrgID(e.target.value)} aria-label="Organisation">
                  {me.organisations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="truncate text-sm font-medium">{org?.name ?? "No organisation"}</p>
              )}
            </div>
          </div>
          <div className="hidden max-w-md flex-1 md:flex">
            <div className="search-chip w-full">
              <kbd className="kbd">Ctrl</kbd>
              <kbd className="kbd">K</kbd>
              <span>Search projects and members</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {me.instance?.name ? (
              <span className="hidden max-w-40 truncate text-sm text-muted-foreground lg:inline" title={me.instance.name}>
                {me.instance.name}
              </span>
            ) : null}
            <ThemeToggle theme={theme} onChange={setTheme} />
            <details className="relative">
              <summary className="btn btn-ghost cursor-pointer list-none">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                  {initials || "U"}
                </span>
                <span className="hidden text-left sm:block">
                  <span className="block text-sm font-medium">{me.user.name}</span>
                </span>
              </summary>
              <div className="absolute right-0 z-50 mt-2 w-56 rounded-lg border border-border bg-card p-2">
                <p className="px-2 py-1 text-xs text-muted-foreground">{me.user.email}</p>
                <button type="button" className="btn btn-ghost w-full justify-start" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            </details>
          </div>
        </header>
        <main className="flex-1 px-4 py-8 sm:px-6 lg:px-10">
          <div className="mx-auto w-full max-w-5xl">
            <Outlet context={{ orgID: org?.id ?? "", org, me }} />
          </div>
        </main>
      </div>
    </div>
  );
}

export type ShellContext = {
  orgID: string;
  org?: Organisation;
  me: Me;
};
