import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ActivityPage } from "./pages/ActivityPage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { HomePage } from "./pages/HomePage";
import { InstancePage } from "./pages/InstancePage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ResetPage } from "./pages/ResetPage";
import { RolesPage } from "./pages/RolesPage";
import { SetupPage } from "./pages/SetupPage";
import { Shell } from "./pages/Shell";
import { TeamsPage } from "./pages/TeamsPage";

function PortalDisabled() {
  return (
    <div className="panel px-6 py-10">
      <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Portal</p>
      <h1 className="mt-3 font-serif text-3xl font-semibold tracking-tight">Portal is disabled</h1>
      <p className="page-lede mt-3">
        An instance administrator turned off the management portal. Published documentation at /view/ still works.
      </p>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background text-foreground">
      <span className="spinner" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

export default function App() {
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

  if (setup.isLoading) {
    return <Loading label="Loading LoreLink" />;
  }

  const needsSetup = setup.data && !setup.data.completed;
  const portalOff = Boolean(me.data?.instance && me.data.instance.portal_enabled === false);
  const isInstanceAdmin = Boolean(me.data?.user.instance_capabilities.includes("instance.admin"));

  return (
    <Routes>
      <Route path="/setup" element={needsSetup ? <SetupPage /> : <Navigate to="/" replace />} />
      <Route path="/login" element={me.data ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/reset/:token" element={<ResetPage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route
        element={
          me.data ? (
            <Shell me={me.data} />
          ) : me.isLoading ? (
            <Loading label="Loading session" />
          ) : needsSetup ? (
            <Navigate to="/setup" replace />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      >
        <Route
          path="/"
          element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <HomePage />}
        />
        <Route path="/projects/:projectID" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <ProjectPage />} />
        <Route path="/connections" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <ConnectionsPage />} />
        <Route path="/teams" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <TeamsPage />} />
        <Route path="/members" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <MembersPage />} />
        <Route path="/roles" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <RolesPage />} />
        <Route path="/api-keys" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <ApiKeysPage />} />
        <Route path="/activity" element={portalOff && !isInstanceAdmin ? <PortalDisabled /> : <ActivityPage />} />
        <Route path="/instance" element={<InstancePage />} />
      </Route>
    </Routes>
  );
}
