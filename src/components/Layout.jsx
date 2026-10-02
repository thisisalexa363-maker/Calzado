import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  Bug,
  CalendarCheck2,
  ClipboardList,
  FileSpreadsheet,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Settings,
  ShieldCheck,
  Store,
  Truck,
  UsersRound
} from "lucide-react";
import { normalizeRole } from "../lib/scoring";
import { loadUserThemePreference, saveUserThemePreference } from "../lib/repository";
import { Alert, Button, IconButton } from "./ui";

const SIDEBAR_STATE_KEY = "formulario_sidebar_collapsed";
const themeStateKey = (userId) => `formulario_theme_user_${userId}`;

const CUSTOM_THEME_DEFAULTS = {
  background: "#090b10", sidebar: "#101318", surface: "#181c23", control: "#0e1117",
  accent: "#4f8cff", secondary: "#8bb4ff", text: "#f4f7fb", muted: "#b8c0cc",
  border: "#3b4656", buttonText: "#07101f"
};

const CUSTOM_THEME_FIELDS = [
  { key: "background", label: "Fondo general", description: "Fondo principal de la web" },
  { key: "sidebar", label: "Barra lateral", description: "Menú y navegación" },
  { key: "surface", label: "Paneles y tarjetas", description: "Superficies elevadas" },
  { key: "control", label: "Campos", description: "Casillas, listas y entradas" },
  { key: "accent", label: "Color principal", description: "Botones, selección y foco" },
  { key: "secondary", label: "Color secundario", description: "Detalles y encabezados" },
  { key: "text", label: "Texto principal", description: "Títulos y contenido" },
  { key: "muted", label: "Texto secundario", description: "Ayudas y descripciones" },
  { key: "border", label: "Bordes", description: "Contornos y divisiones" },
  { key: "buttonText", label: "Texto de botones", description: "Texto sobre el color principal" }
];

function customThemeProperties(theme) {
  return {
    "--bg": theme.background,
    "--bg-deep": theme.background,
    "--sidebar-bg": theme.sidebar,
    "--surface": theme.surface,
    "--surface-solid": theme.surface,
    "--surface-strong": `color-mix(in srgb, ${theme.surface} 82%, white)`,
    "--surface-raised": theme.surface,
    "--surface-soft": `color-mix(in srgb, ${theme.text} 7%, transparent)`,
    "--border": theme.border,
    "--border-strong": `color-mix(in srgb, ${theme.border} 72%, white)`,
    "--accent": theme.accent,
    "--accent-dark": `color-mix(in srgb, ${theme.accent} 72%, black)`,
    "--accent-soft": `color-mix(in srgb, ${theme.accent} 17%, transparent)`,
    "--gold": theme.secondary,
    "--gold-soft": `color-mix(in srgb, ${theme.secondary} 14%, transparent)`,
    "--text": theme.text,
    "--text-strong": theme.text,
    "--muted": theme.muted,
    "--muted-2": `color-mix(in srgb, ${theme.muted} 78%, ${theme.background})`,
    "--theme-control": theme.control,
    "--theme-control-focus": `color-mix(in srgb, ${theme.control} 88%, white)`,
    "--theme-panel-start": `color-mix(in srgb, ${theme.surface} 88%, white)`,
    "--theme-panel-end": theme.surface,
    "--theme-table-head": `color-mix(in srgb, ${theme.surface} 82%, white)`,
    "--theme-row-even": `color-mix(in srgb, ${theme.text} 4%, transparent)`,
    "--theme-accent-contrast": theme.buttonText,
    "--theme-accent-highlight": theme.secondary
  };
}

const APP_THEMES = [
  { key: "default", label: "Predeterminado", colors: ["#2dd4bf", "#f4b75e", "#07100f"] },
  { key: "purple", label: "Morado", colors: ["#a78bfa", "#d8b4fe", "#160f24"] },
  { key: "pink", label: "Rosado", colors: ["#f472b6", "#fda4af", "#211017"] },
  { key: "gold", label: "Dorado y negro", colors: ["#f5c451", "#d99b26", "#080808"] },
  { key: "green", label: "Verde", colors: ["#4ade80", "#a3e635", "#07150d"] },
  { key: "custom", label: "Personalizado", colors: ["#4f8cff", "#8bb4ff", "#090b10"] }
];

function validCustomTheme(colors) {
  return Object.fromEntries(Object.entries(CUSTOM_THEME_DEFAULTS).map(([key, defaultColor]) => [
    key, /^#[0-9a-fA-F]{6}$/.test(String(colors?.[key] || "")) ? colors[key] : defaultColor
  ]));
}

function readCachedTheme(userId) {
  try {
    const saved = JSON.parse(localStorage.getItem(themeStateKey(userId)) || "null");
    return {
      theme: APP_THEMES.some(({ key }) => key === saved?.theme) ? saved.theme : "default",
      colors: validCustomTheme(saved?.colors)
    };
  } catch {
    return { theme: "default", colors: CUSTOM_THEME_DEFAULTS };
  }
}

const adminItems = [
  { key: "Dashboard", label: "Dashboard calzado", icon: LayoutDashboard },
  { key: "Usuarios", icon: UsersRound },
  { key: "Capacitaciones", icon: GraduationCap },
  { key: "Tareas", label: "Tareas y puntajes", icon: ClipboardList },
  { key: "Asistencia", icon: CalendarCheck2 },
  { key: "Notificaciones", icon: BellRing },
  { key: "Tiendas", label: "Tiendas y Marcas", icon: Store },
  { key: "Lotes", icon: Package },
  { key: "Guias", icon: Truck },
  { key: "Errores", icon: Bug },
  { key: "Registros", label: "Registros operativos", icon: ClipboardList },
  { key: "Amonestaciones", icon: AlertTriangle },
  { key: "Documentos", icon: FileSpreadsheet }
];

function ThemePreview({ isDashboardView, title, section, style }) {
  return (
    <div className="custom-theme-preview" style={style} aria-label={`Vista previa de ${isDashboardView ? "Dashboard calzado" : title}`}>
      <div className="custom-preview-label"><span>Vista previa en vivo</span><strong>{isDashboardView ? "Dashboard calzado" : section || title}</strong></div>
      <div className="custom-preview-window">
        <aside className="custom-preview-sidebar">
          <div className="custom-preview-logo">F</div>
          <div className="custom-preview-user"><i /><span /><small /></div>
          <div className="custom-preview-nav is-active"><i /><span /></div>
          <div className="custom-preview-nav"><i /><span /></div>
          <div className="custom-preview-nav"><i /><span /></div>
          <div className="custom-preview-nav"><i /><span /></div>
        </aside>
        <div className="custom-preview-main">
          <header><span>{isDashboardView ? "CONTROL OPERATIVO" : title}</span><button type="button" tabIndex={-1}>Acción</button></header>
          <div className="custom-preview-title"><i /><div><strong>{isDashboardView ? "DASHBOARD CALZADO" : section || "Sistema de formularios"}</strong><small>Vista de colores y contraste</small></div></div>
          {isDashboardView ? (
            <div className="custom-preview-dashboard-grid">
              <article><small>Total trabajadores</small><strong>24</strong></article>
              <article><small>Producción</small><strong>1,248</strong></article>
              <article className="custom-preview-chart"><span style={{ height: "45%" }} /><span style={{ height: "72%" }} /><span style={{ height: "58%" }} /><span style={{ height: "86%" }} /></article>
            </div>
          ) : (
            <div className="custom-preview-form">
              <label><span>Nombre</span><i /></label>
              <label><span>Selección</span><i /></label>
              <button type="button" tabIndex={-1}>Guardar</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Layout({ user, adminSection, onAdminSectionChange, onLogout, children }) {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 980px)").matches
  ));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customTheme, setCustomTheme] = useState(() => readCachedTheme(user.id).colors);
  const [customThemeDraft, setCustomThemeDraft] = useState(customTheme);
  const customColorFrameRef = useRef(null);
  const pendingCustomThemeRef = useRef(customTheme);
  const [appTheme, setAppTheme] = useState(() => readCachedTheme(user.id).theme);
  const [themeSaveError, setThemeSaveError] = useState("");
  const themeEditVersionRef = useRef(0);
  const themeSaveChainRef = useRef(Promise.resolve());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STATE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let active = true;
    const editVersion = themeEditVersionRef.current;
    loadUserThemePreference().then((preference) => {
      if (!active || themeEditVersionRef.current !== editVersion) return;
      const theme = APP_THEMES.some(({ key }) => key === preference?.tema) ? preference.tema : "default";
      const colors = validCustomTheme(preference?.colores_personalizados);
      setAppTheme(theme);
      setCustomTheme(colors);
      setCustomThemeDraft(colors);
      pendingCustomThemeRef.current = colors;
      setThemeSaveError("");
    }).catch((error) => {
      if (active) setThemeSaveError(error.message || "No se pudieron cargar tus preferencias de tema.");
    });
    return () => { active = false; };
  }, [user.id]);

  useEffect(() => {
    try {
      localStorage.setItem(themeStateKey(user.id), JSON.stringify({ theme: appTheme, colors: customTheme }));
    } catch {
      // El tema sigue activo durante esta sesion si no hay almacenamiento local.
    }
  }, [user.id, appTheme, customTheme]);

  function persistTheme(theme, colors) {
    const version = ++themeEditVersionRef.current;
    setThemeSaveError("");
    themeSaveChainRef.current = themeSaveChainRef.current.catch(() => {}).then(() =>
      saveUserThemePreference({ tema: theme, colores_personalizados: colors })
    ).then(() => {
      if (version === themeEditVersionRef.current) setThemeSaveError("");
    }).catch((error) => {
      if (version === themeEditVersionRef.current) setThemeSaveError(error.message || "No se pudo guardar tu tema.");
    });
  }

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, String(sidebarCollapsed));
    } catch {
      // La barra sigue funcionando aunque el navegador bloquee el almacenamiento.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.body.dataset.appTheme = appTheme;
    return () => {
      delete document.body.dataset.appTheme;
    };
  }, [appTheme]);

  useEffect(() => {
    const customProperties = customThemeProperties(customTheme);
    Object.entries(customProperties).forEach(([property, value]) => {
      if (appTheme === "custom") document.body.style.setProperty(property, value);
      else document.body.style.removeProperty(property);
    });
    return () => Object.keys(customProperties).forEach((property) => document.body.style.removeProperty(property));
  }, [appTheme, customTheme]);

  useEffect(() => {
    if (settingsOpen) setCustomThemeDraft(customTheme);
  }, [settingsOpen, customTheme]);

  useEffect(() => {
    pendingCustomThemeRef.current = customThemeDraft;
  }, [customThemeDraft]);

  useEffect(() => () => {
    if (customColorFrameRef.current) window.cancelAnimationFrame(customColorFrameRef.current);
  }, []);

  function previewCustomColor(key, value) {
    themeEditVersionRef.current += 1;
    pendingCustomThemeRef.current = { ...pendingCustomThemeRef.current, [key]: value };
    if (customColorFrameRef.current) return;
    customColorFrameRef.current = window.requestAnimationFrame(() => {
      customColorFrameRef.current = null;
      setCustomThemeDraft(pendingCustomThemeRef.current);
    });
  }

  useEffect(() => {
    if (!profileMenuOpen && !settingsOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
        setSettingsOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [profileMenuOpen, settingsOpen]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const handleChange = (event) => {
      setIsMobile(event.matches);
      if (!event.matches) setMobileSidebarOpen(false);
    };
    setIsMobile(media.matches);
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    if (!isMobile || !mobileSidebarOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobile, mobileSidebarOpen]);

  const role = normalizeRole(user?.rol);
  const isDashboardView = role === "administrador" && adminSection === "Dashboard";
  const title =
    role === "administrador"
      ? "Panel Administrativo"
      : role === "lider de equipo"
        ? "Panel de Líder de Equipo"
        : role === "otros"
          ? "Perfil de Usuario"
        : "Panel de Trabajo";

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileSidebarOpen ? " mobile-sidebar-open" : ""}${isDashboardView ? " dashboard-view" : ""}`}>
      <aside className={`sidebar${!isMobile && sidebarCollapsed ? " collapsed" : ""}`} aria-label="Barra lateral">
        <div className="sidebar-top">
          <div className="sidebar-header-row">
            <div className="brand-row">
              <div className="brand-mark small">F</div>
              <div className="sidebar-copy">
                <strong>Formulario</strong>
                <span>Gestion operativa</span>
              </div>
            </div>
            <IconButton
              label={isMobile ? "Cerrar menu" : sidebarCollapsed ? "Expandir barra lateral" : "Contraer barra lateral"}
              icon={isMobile ? PanelLeftClose : sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
              aria-expanded={isMobile ? mobileSidebarOpen : !sidebarCollapsed}
              aria-controls="primary-sidebar-navigation"
              onClick={() => isMobile ? setMobileSidebarOpen(false) : setSidebarCollapsed((current) => !current)}
            />
          </div>
          <div className={`profile-menu-wrap${profileMenuOpen ? " is-open" : ""}`}>
            <button
              type="button"
              className="profile-box"
              onClick={() => setProfileMenuOpen((current) => !current)}
              aria-expanded={profileMenuOpen}
              aria-haspopup="menu"
              title={sidebarCollapsed ? "Abrir perfil" : undefined}
            >
              <ShieldCheck />
              <div className="sidebar-copy">
                <span>{user?.nombre || user?.email || "Usuario"}</span>
                <small>{role || "rol no reconocido"}</small>
              </div>
            </button>
            {profileMenuOpen ? (
              <div className="profile-dropdown" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  <Settings aria-hidden="true" />
                  <span>Ajustes</span>
                </button>
              </div>
            ) : null}
          </div>
          {role === "administrador" ? (
            <nav id="primary-sidebar-navigation" className="side-nav" aria-label="Gestion administrativa">
              {adminItems.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={adminSection === key ? "active" : ""}
                  onClick={() => {
                    onAdminSectionChange(key);
                    if (isMobile) setMobileSidebarOpen(false);
                  }}
                  title={sidebarCollapsed ? label || key : undefined}
                >
                  <Icon />
                  <span className="sidebar-copy">{label || key}</span>
                </button>
              ))}
            </nav>
          ) : (
            <div className="sidebar-note">
              <Menu />
              <span className="sidebar-copy">
                {role === "lider de equipo"
                  ? "Registra trabajos por trabajador y deja identificado al encargado en cada registro."
                  : role === "otros"
                    ? "Usuario registrado como personal de otras funciones."
                  : "Registra lo realizado y revisa tu historial sin perder el contexto del dia."}
              </span>
            </div>
          )}
        </div>
        <Button className="sidebar-logout" variant="secondary" icon={LogOut} onClick={onLogout} title={sidebarCollapsed ? "Cerrar sesion" : undefined}>
          Cerrar sesion
        </Button>
      </aside>

      {settingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}>
          <section className="settings-dialog">
            <header className="settings-dialog-header">
              <div>
                <span className="settings-kicker"><Palette aria-hidden="true" /> Apariencia</span>
                <h2 id="settings-title">Ajustes</h2>
              </div>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Cerrar ajustes">×</button>
            </header>
            <div className="settings-content">
              <h3>Tema de la web</h3>
              <p>Selecciona los colores que quieres usar en el sistema.</p>
              {themeSaveError ? <Alert type="error">{themeSaveError}</Alert> : null}
              <div className="theme-options" role="radiogroup" aria-label="Tema de la web">
                {APP_THEMES.map((theme) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={appTheme === theme.key}
                    className={`theme-option${appTheme === theme.key ? " is-selected" : ""}`}
                    key={theme.key}
                    onClick={() => {
                      setAppTheme(theme.key);
                      persistTheme(theme.key, customTheme);
                    }}
                  >
                    <span className="theme-swatches" aria-hidden="true">
                      {(theme.key === "custom" ? [customThemeDraft.accent, customThemeDraft.secondary, customThemeDraft.background] : theme.colors)
                        .map((color) => <i key={color} style={{ background: color }} />)}
                    </span>
                    <span>{theme.label}</span>
                    <small>{appTheme === theme.key ? "Activo" : "Seleccionar"}</small>
                  </button>
                ))}
              </div>
              {appTheme !== "custom" ? <ThemePreview isDashboardView={isDashboardView} title={title} section={adminSection} /> : null}
              {appTheme === "custom" ? (
                <div className="custom-theme-editor">
                  <div className="custom-theme-heading">
                    <div>
                      <h3>Personalizar colores</h3>
                      <p>Los cambios se aplican inmediatamente en toda la web.</p>
                    </div>
                    <div className="custom-theme-actions">
                      <button type="button" className="custom-theme-reset" onClick={() => {
                        pendingCustomThemeRef.current = CUSTOM_THEME_DEFAULTS;
                        setCustomThemeDraft(CUSTOM_THEME_DEFAULTS);
                      }}>Restaurar</button>
                      <button type="button" className="custom-theme-apply" onClick={() => {
                        setCustomThemeDraft(pendingCustomThemeRef.current);
                        setCustomTheme(pendingCustomThemeRef.current);
                        persistTheme("custom", pendingCustomThemeRef.current);
                      }}>Aplicar colores</button>
                    </div>
                  </div>
                  <div className="custom-theme-workbench">
                    {[CUSTOM_THEME_FIELDS.slice(0, 5), CUSTOM_THEME_FIELDS.slice(5)].map((fields, columnIndex) => (
                      <div className={`custom-color-column custom-color-column--${columnIndex + 1}`} key={fields[0].key}>
                        {fields.map((field) => (
                          <label className="custom-color-field" key={field.key}>
                            <input
                              type="color"
                              value={customThemeDraft[field.key]}
                              onChange={(event) => previewCustomColor(field.key, event.target.value)}
                              aria-label={field.label}
                            />
                            <span><strong>{field.label}</strong><small>{field.description}</small></span>
                            <code>{customThemeDraft[field.key].toUpperCase()}</code>
                          </label>
                        ))}
                      </div>
                    ))}
                    <ThemePreview
                      isDashboardView={isDashboardView}
                      title={title}
                      section={adminSection}
                      style={customThemeProperties(customThemeDraft)}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {isMobile && mobileSidebarOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Cerrar menu lateral"
          onClick={() => setMobileSidebarOpen(false)}
        />
      ) : null}

      <main className={`workspace${isDashboardView ? " dashboard-workspace" : ""}`}>
        {isDashboardView && isMobile ? (
          <IconButton
            className="dashboard-mobile-menu"
            label="Abrir menu lateral"
            icon={Menu}
            aria-expanded={mobileSidebarOpen}
            aria-controls="primary-sidebar-navigation"
            onClick={() => setMobileSidebarOpen(true)}
          />
        ) : null}
        {!isDashboardView ? <header className="workspace-header">
          <div className="workspace-title-row">
            <IconButton
              className="mobile-sidebar-trigger"
              label="Abrir menu lateral"
              icon={Menu}
              aria-expanded={mobileSidebarOpen}
              aria-controls="primary-sidebar-navigation"
              onClick={() => setMobileSidebarOpen(true)}
            />
            <div>
              <p className="eyebrow">{title}</p>
              <h1>Sistema de Formularios</h1>
            </div>
          </div>
          <div className="header-chip">{role}</div>
        </header> : null}
        {children}
      </main>
    </div>
  );
}
