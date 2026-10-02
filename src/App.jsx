import { useEffect, useState } from "react";
import AdminDashboard from "./components/AdminDashboard";
import GroupLeaderDashboard from "./components/GroupLeaderDashboard";
import Layout from "./components/Layout";
import Login from "./components/Login";
import WorkerDashboard from "./components/WorkerDashboard";
import { Alert } from "./components/ui";
import { clearApiSession } from "./lib/repository";
import { normalizeRole } from "./lib/scoring";
import { clearApplicationSessionState } from "./lib/sessionState";

const SESSION_KEY = "formulario_usuario_v2";

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export default function App() {
  const [user, setUser] = useState(readStoredUser);
  const [adminSection, setAdminSection] = useState("Dashboard");

  const handleLogout = () => {
    clearApiSession();
    clearApplicationSessionState();
    setUser(null);
  };

  useEffect(() => {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
  }, [user]);

  if (!user) return <Login onLogin={setUser} />;

  const role = normalizeRole(user.rol);

  return (
    <Layout
      key={user.id}
      user={user}
      adminSection={adminSection}
      onAdminSectionChange={setAdminSection}
      onLogout={handleLogout}
    >
      {role === "administrador" ? <AdminDashboard section={adminSection} user={user} onLogout={handleLogout} /> : null}
      {role === "operante" ? <WorkerDashboard user={user} /> : null}
      {["lider de equipo", "otros"].includes(role) ? <GroupLeaderDashboard user={user} /> : null}
      {!["administrador", "operante", "lider de equipo", "otros"].includes(role) ? (
        <Alert type="error">Rol no reconocido. Usa administrador, operante, líder de equipo u otros.</Alert>
      ) : null}
    </Layout>
  );
}
