import { useEffect, useMemo, useState } from "react";
import { LockKeyhole, LogIn, UserRound } from "lucide-react";
import { verifyUser } from "../lib/repository";
import { isSupabaseConfigured } from "../lib/supabaseClient";
import { Alert, Button } from "./ui";
import loginVideoUrl from "../../genera_un_video_de_fondo_para.mp4";
import packageJson from "../../package.json";

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

const ADDITIONAL_MOTIVATIONAL_PHRASES = [
  "Si esperas a estar listo, probablemente esperarás toda la vida.",
  "Sueña en grande. Comienza en pequeño, pero sobre todo comienza.",
  "Cuando dejas de soñar, dejas de avanzar.",
  "El éxito no se construye en un día, pero sí comienza con una decisión.",
  "La persistencia convierte lo imposible de hoy en lo posible de mañana.",
  "El fracaso más grande es nunca haberlo intentado.",
  "Solo quienes se atreven a fracasar tienen la oportunidad de alcanzar grandes éxitos.",
  "No necesitas ver toda la escalera; solo necesitas dar el primer paso.",
  "A veces ganar significa simplemente no rendirse.",
  "Lo que hoy parece pequeño puede convertirse mañana en algo extraordinario.",
  "No compares tu comienzo con el capítulo veinte de otra persona.",
  "Las grandes cosas casi siempre comienzan con una idea que alguien se atrevió a tomar en serio.",
  "No tengas miedo de empezar de cero. Esta vez sabes más que antes.",
  "El camino difícil suele llevar a lugares donde pocos están dispuestos a llegar.",
  "La disciplina te llevará lugares donde la motivación no alcanza.",
  "Hazlo con miedo, pero hazlo.",
  "El momento perfecto rara vez llega; el momento de empezar es ahora.",
  "No necesitas suerte cuando tienes preparación, constancia y paciencia.",
  "Las oportunidades no siempre parecen oportunidades cuando aparecen.",
  "Si quieres resultados diferentes, tendrás que atreverte a hacer cosas diferentes.",
  "El talento puede abrir una puerta; la constancia decide cuánto tiempo permaneces dentro.",
  "No abandones algo que quieres solo porque todavía no sabes cómo conseguirlo.",
  "Los grandes resultados son la suma de pequeños esfuerzos repetidos durante mucho tiempo.",
  "Tu futuro se construye con las decisiones que tomas cuando nadie está mirando.",
  "No todo avance se nota inmediatamente. Algunas raíces crecen en silencio.",
  "El miedo también puede ser una señal de que estás creciendo.",
  "No permitas que una mala temporada te haga pensar que tienes una mala vida.",
  "A veces el camino cambia, pero el sueño puede permanecer.",
  "No necesitas tener todas las respuestas para comenzar a hacer las preguntas correctas.",
  "La constancia vence a la inspiración cuando la inspiración decide no aparecer.",
  "Quien quiere llegar lejos aprende a disfrutar también del camino.",
  "No construyas tu vida para impresionar a otros; constrúyela para estar orgulloso de ti.",
  "Las personas que hoy admiras también tuvieron un día en el que no sabían por dónde empezar.",
  "El éxito no siempre hace ruido. A veces se parece a levantarte y continuar.",
  "No confundas ir lento con estar detenido.",
  "Cada intento te acerca un poco más a descubrir qué funciona.",
  "Si el plan no funciona, cambia el plan, no necesariamente el objetivo.",
  "La paciencia también es una forma de valentía.",
  "No hay progreso sin incomodidad, ni aprendizaje sin errores.",
  "Tu única competencia real es la persona que eras ayer.",
  "El tiempo va a pasar de todos modos. Haz que también trabaje a tu favor.",
  "Un día agradecerás haber insistido cuando tenías razones para abandonar.",
  "No necesitas demostrarle a nadie que puedes. Solo necesitas demostrarte a ti mismo que lo intentaste.",
  "Las decisiones pequeñas de hoy pueden cambiar por completo la historia de mañana.",
  "No dejes que la posibilidad de equivocarte te robe la posibilidad de acertar.",
  "La vida cambia cuando dejas de esperar permiso para perseguir lo que quieres.",
  "Rodéate de personas que te recuerden quién puedes llegar a ser.",
  "Los amigos y las buenas maneras pueden abrir puertas que el dinero jamás podrá comprar.",
  "No todo lo que pierdes es una pérdida; algunas cosas hacen espacio para algo mejor.",
  "A veces cerrar una puerta es exactamente lo que necesitas para empezar a construir otra.",
  "El éxito tiene muchas definiciones. Asegúrate de escribir la tuya.",
  "No trabajes solamente por llegar a un lugar; conviértete en alguien capaz de permanecer allí.",
  "La suerte suele encontrar trabajando a quienes estaban preparados cuando llegó la oportunidad.",
  "Si vas a pensar en grande, piensa también en grande sobre lo que eres capaz de aprender.",
  "No dejes que un “todavía no” se convierta en un “nunca”.",
  "El comienzo puede ser imperfecto y aun así ser el comienzo correcto.",
  "Los sueños no tienen fecha de vencimiento; pero necesitan acciones para convertirse en realidad.",
  "Cuando no puedas avanzar rápido, avanza despacio. Pero sigue avanzando.",
  "Algún día mirarás hacia atrás y entenderás por qué necesitabas ser paciente.",
  "No sabes hasta dónde puedes llegar si nunca decides dar el primer paso."
];

function createMotivationalFlow() {
  const shuffled = [...MOTIVATIONAL_PHRASES, ...ADDITIONAL_MOTIVATIONAL_PHRASES];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  const lanes = [7, 16, 26, 37, 48, 59, 69, 78, 87, 94];
  return shuffled.slice(0, 10).map((phrase, index) => ({
    phrase,
    top: lanes[index % lanes.length] + (Math.random() * 3 - 1.5),
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
      <span className="login-version">V {packageJson.version}</span>
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
