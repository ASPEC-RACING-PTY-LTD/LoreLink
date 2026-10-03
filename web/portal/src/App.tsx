import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ActivityPage } from "./pages/ActivityPage";
import { HomePage } from "./pages/HomePage";
import { InstancePage } from "./pages/InstancePage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { SetupPage } from "./pages/SetupPage";
import { Shell } from "./pages/Shell";

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

  return (
    <Routes>
      <Route path="/setup" element={needsSetup ? <SetupPage /> : <Navigate to="/" replace />} />
      <Route path="/login" element={me.data ? <Navigate to="/" replace /> : <LoginPage />} />
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
        <Route path="/" element={<HomePage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/instance" element={<InstancePage />} />
      </Route>
    </Routes>
  );
}
