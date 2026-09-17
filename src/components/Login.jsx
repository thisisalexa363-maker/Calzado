import { useEffect, useMemo, useState } from "react";
import { LockKeyhole, LogIn, UserRound } from "lucide-react";
import { verifyUser } from "../lib/repository";
import { isSupabaseConfigured } from "../lib/supabaseClient";
import { Alert, Button } from "./ui";
import loginVideoUrl from "../../genera_un_video_de_fondo_para.mp4";

const MOTIVATIONAL_PHRASES = [
  "Cada paso cuenta",
  "Tu esfuerzo deja huella",
  "Calidad en cada detalle",
  "Hoy avanzamos juntos",
  "La constancia crea resultados",
  "Grandes metas, acciones diarias",
  "Crecer también es insistir",
  "Haz que hoy cuente",
  "Avanzar también es ganar",
  "Juntos llegamos más lejos"
];

function createMotivationalFlow() {
  const shuffled = [...MOTIVATIONAL_PHRASES];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  const lanes = [7, 16, 26, 37, 48, 59, 69, 78, 87, 94];
  return shuffled.map((phrase, index) => ({
    phrase,
    top: lanes[index] + (Math.random() * 3 - 1.5),
    duration: 17 + Math.random() * 12,
    delay: -(Math.random() * 28)
  }));
}

function isInactive(user) {
  const value = String(user?.activo ?? true).trim().toLowerCase();
  return ["false", "0", "no"].includes(value);
}

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [loadBackgroundVideo, setLoadBackgroundVideo] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const motivationalFlow = useMemo(createMotivationalFlow, []);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const savesData = navigator.connection?.saveData === true;
    if (prefersReducedMotion || savesData) return undefined;

    let idleId;
    const timerId = window.setTimeout(() => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(() => setLoadBackgroundVideo(true), { timeout: 2500 });
      } else {
        setLoadBackgroundVideo(true);
      }
    }, 600);

    return () => {
      window.clearTimeout(timerId);
      if (idleId !== undefined && "cancelIdleCallback" in window) window.cancelIdleCallback(idleId);
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");

    if (!email.trim() || !password) {
      setMessage("Completa usuario y contrasena.");
      return;
    }

    setLoading(true);
    try {
      const user = await verifyUser(email, password);
      if (!user) {
        setMessage("Credenciales invalidas o usuario no existe.");
        return;
      }
      if (isInactive(user)) {
        setMessage("Cuenta bloqueada. Tu usuario está inactivo y no puede ingresar. Contacta al administrador.");
        return;
      }
      onLogin(user);
    } catch (error) {
      setMessage(error?.message || "No se pudo iniciar sesion.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      {loadBackgroundVideo ? (
        <video
          className={`login-background-video${videoReady ? " is-ready" : ""}`}
          autoPlay
          muted
          loop
          playsInline
          preload="none"
          disablePictureInPicture
          aria-hidden="true"
          tabIndex={-1}
          onCanPlay={() => setVideoReady(true)}
        >
          <source src={loginVideoUrl} type="video/mp4" />
        </video>
      ) : null}
      <div className="login-overlay" />
      <div className="login-ambient login-ambient--teal" aria-hidden="true" />
      <div className="login-ambient login-ambient--gold" aria-hidden="true" />
      <div className="login-motivation-cloud" aria-hidden="true">
        {motivationalFlow.map(({ phrase, top, duration, delay }) => (
          <span
            className="login-motivation-pill"
            key={phrase}
            style={{
              "--login-phrase-top": `${top}%`,
              "--login-phrase-duration": `${duration}s`,
              "--login-phrase-delay": `${delay}s`
            }}
          >
            <i />
            {phrase}
          </span>
        ))}
      </div>
      <section className="login-card" aria-label="Inicio de sesion">
        <div className="login-card-topline">
          <div className="brand-mark">F</div>
          <div className="login-brand-copy">
            <strong>Formulario</strong>
            <span>Gestión operativa</span>
          </div>
          <span className="login-status"><i /> En línea</span>
        </div>
        <p className="eyebrow">Sistema por roles</p>
        <h1>Ingreso al sistema</h1>
        <p className="login-copy">Todo tu trabajo, progreso y resultados en un solo lugar.</p>

        {!isSupabaseConfigured ? (
          <Alert type="error">
            Faltan variables VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY. Revisa .env.example.
          </Alert>
        ) : null}

        {message ? <Alert type="error">{message}</Alert> : null}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="input-with-icon">
            <UserRound />
            <input
              type="text"
              placeholder="Usuario o correo"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="input-with-icon">
            <LockKeyhole />
            <input
              type="password"
              placeholder="Contrasena"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <Button type="submit" icon={LogIn} loading={loading} disabled={!isSupabaseConfigured}>
            Iniciar sesion
          </Button>
        </form>
        <p className="login-card-footnote"><span>●</span> Un equipo, un propósito, mejores resultados.</p>
      </section>
    </main>
  );
}
