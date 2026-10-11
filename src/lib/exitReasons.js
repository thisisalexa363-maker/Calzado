export const EXIT_REASONS = [
  "Mejor oferta",
  "Cambio de area",
  "Ausentismo",
  "Temas personales",
  "Apoyo vacacional",
  "Deserción",
  "Salud",
  "Temas de estudio",
  "Mejor oportunidad",
  "Bajo desempeño",
  "Faltas reincidentes.",
  "Otros"
];

export function normalizeExitReason(value) {
  const text = String(value || "").trim().toLocaleLowerCase("es");
  const reason = text.replace(/\.+$/, "");
  if (reason === "mejor oportunidad laboral") return "Mejor oportunidad";
  if (["estudios", "temas de estudios", "temas de estudio"].includes(reason)) return "Temas de estudio";
  if (["personal", "temas personales"].includes(reason)) return "Temas personales";
  return text ? text.charAt(0).toLocaleUpperCase("es") + text.slice(1) : "";
}
