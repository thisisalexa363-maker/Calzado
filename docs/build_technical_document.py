from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "Documento-Tecnico-Construccion-Sistema-Formularios.docx"

NAVY = "17365D"
BLUE = "2F75B5"
PALE_BLUE = "EAF2F8"
PALE_GRAY = "F3F5F7"
MID_GRAY = "D9D9D9"
TEXT = RGBColor(31, 41, 55)


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_border(cell, color=MID_GRAY, size="6"):
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = qn(f"w:{edge}")
        element = borders.find(tag)
        if element is None:
            element = OxmlElement(f"w:{edge}")
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:color"), color)


def set_cell_margins(cell, top=110, start=130, bottom=110, end=130):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement("w:cantSplit")
    tr_pr.append(cant_split)


def remove_paragraph_borders(paragraph):
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is not None:
        p_pr.remove(p_bdr)


def set_keep_with_next(paragraph, value=True):
    paragraph.paragraph_format.keep_with_next = value


def add_page_number(paragraph):
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("Página ")
    run.font.size = Pt(8)
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = " PAGE "
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char1)
    run._r.append(instr_text)
    run._r.append(fld_char2)


def add_table(doc, headers, rows, widths=None):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    header = table.rows[0]
    set_repeat_table_header(header)
    prevent_row_split(header)
    for idx, text in enumerate(headers):
        cell = header.cells[idx]
        cell.text = text
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        set_cell_shading(cell, NAVY)
        set_cell_border(cell)
        set_cell_margins(cell)
        if widths:
            cell.width = widths[idx]
        for paragraph in cell.paragraphs:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.space_after = Pt(0)
            for run in paragraph.runs:
                run.font.bold = True
                run.font.color.rgb = RGBColor(255, 255, 255)
                run.font.size = Pt(9)
    for row_index, row_values in enumerate(rows):
        new_row = table.add_row()
        prevent_row_split(new_row)
        cells = new_row.cells
        for idx, value in enumerate(row_values):
            cell = cells[idx]
            cell.text = str(value)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_border(cell)
            set_cell_margins(cell)
            set_cell_shading(cell, "FFFFFF" if row_index % 2 == 0 else PALE_BLUE)
            if widths:
                cell.width = widths[idx]
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = Pt(0)
                paragraph.paragraph_format.line_spacing = 1.05
                for run in paragraph.runs:
                    run.font.size = Pt(8.7)
                    run.font.color.rgb = TEXT
    doc.add_paragraph().paragraph_format.space_after = Pt(1)
    return table


def add_bullets(doc, items, level=0):
    for item in items:
        p = doc.add_paragraph(style="List Bullet" if level == 0 else "List Bullet 2")
        p.add_run(item)
        p.paragraph_format.space_after = Pt(3)


def add_numbered(doc, items):
    for index, item in enumerate(items, start=1):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.65)
        p.paragraph_format.first_line_indent = Cm(-0.45)
        number = p.add_run(f"{index}.  ")
        number.font.bold = True
        p.add_run(item)
        p.paragraph_format.space_after = Pt(2)


def add_heading(doc, text, level=1):
    p = doc.add_heading(text, level=level)
    p.paragraph_format.keep_with_next = True
    return p


doc = Document()
section = doc.sections[0]
section.top_margin = Cm(2.1)
section.bottom_margin = Cm(1.8)
section.left_margin = Cm(2.2)
section.right_margin = Cm(2.2)

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Aptos"
normal.font.size = Pt(10)
normal.font.color.rgb = TEXT
normal.paragraph_format.space_after = Pt(6)
normal.paragraph_format.line_spacing = 1.12

styles["Title"].font.name = "Aptos Display"
styles["Title"].font.size = Pt(27)
styles["Title"].font.bold = True
styles["Title"].font.color.rgb = RGBColor(0, 0, 0)
styles["Title"].paragraph_format.space_after = Pt(13)
title_style_ppr = styles["Title"]._element.get_or_add_pPr()
title_style_border = title_style_ppr.find(qn("w:pBdr"))
if title_style_border is not None:
    title_style_ppr.remove(title_style_border)

for name, size in (("Heading 1", 16), ("Heading 2", 12.5), ("Heading 3", 10.5)):
    style = styles[name]
    style.font.name = "Aptos Display"
    style.font.size = Pt(size)
    style.font.bold = True
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.paragraph_format.space_before = Pt(12 if name == "Heading 1" else 8)
    style.paragraph_format.space_after = Pt(5)
    style.paragraph_format.keep_with_next = True

for list_style in ("List Bullet", "List Bullet 2", "List Number"):
    styles[list_style].font.name = "Aptos"
    styles[list_style].font.size = Pt(10)

# Portada
doc.add_paragraph().paragraph_format.space_after = Pt(54)
p = doc.add_paragraph("DOCUMENTACIÓN TÉCNICA", style=None)
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.runs[0]
r.font.name = "Aptos"
r.font.size = Pt(11)
r.font.bold = True
r.font.color.rgb = RGBColor(47, 117, 181)
r.font.letter_spacing = Pt(1.3)

title = doc.add_paragraph("Construcción y arquitectura del Sistema de Formularios", style="Title")
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
remove_paragraph_borders(title)

subtitle = doc.add_paragraph("Documento técnico de diseño implementación operación y mantenimiento")
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
subtitle.paragraph_format.space_after = Pt(28)
for run in subtitle.runs:
    run.font.size = Pt(13)
    run.font.color.rgb = RGBColor(75, 85, 99)

meta = add_table(doc, ["Dato", "Descripción"], [
    ["Sistema", "Formulario web de gestión operativa"],
    ["Versión revisada", "2.0.0"],
    ["Arquitectura principal", "React y Vite con API Node y base de datos Supabase"],
    ["Despliegue previsto", "Netlify Static Hosting y Netlify Functions"],
    ["Fecha de documentación", "20 de septiembre de 2026"],
], widths=[Cm(4.1), Cm(11.2)])

doc.add_paragraph().paragraph_format.space_after = Pt(34)
p = doc.add_paragraph("Propósito del documento")
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.runs[0].font.bold = True
p.runs[0].font.size = Pt(11)
intro = doc.add_paragraph(
    "Este documento describe cómo está construida la aplicación, qué tecnologías utiliza, cómo se organizan sus componentes, "
    "cómo circulan los datos y qué criterios deben seguirse para instalarla, desplegarla y mantenerla. Está dirigido a personal "
    "técnico, responsables de soporte y futuros desarrolladores del sistema."
)
intro.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

doc.add_page_break()

# Índice manual
add_heading(doc, "Contenido", 1)
toc_items = [
    "1 Resumen ejecutivo",
    "2 Alcance funcional",
    "3 Tecnologías utilizadas",
    "4 Arquitectura general",
    "5 Estructura del proyecto",
    "6 Construcción del frontend",
    "7 Construcción del backend y la API",
    "8 Base de datos y persistencia",
    "9 Autenticación autorización y sesiones",
    "10 Módulos funcionales y roles",
    "11 Interfaz temas y diseño adaptable",
    "12 Reportes notificaciones e importación de datos",
    "13 Ejecución pruebas y despliegue",
    "14 Mantenimiento seguridad y recomendaciones",
    "15 Referencia técnica rápida",
]
for item in toc_items:
    p = doc.add_paragraph(item)
    p.paragraph_format.left_indent = Cm(0.4)
    p.paragraph_format.space_after = Pt(3)

add_heading(doc, "1 Resumen ejecutivo", 1)
doc.add_paragraph(
    "El Sistema de Formularios es una aplicación web de gestión operativa para una operación de calzado. Centraliza usuarios, "
    "tareas, puntajes, asistencia, capacitaciones, tiendas, marcas, lotes, guías, incidencias, amonestaciones y registros de trabajo. "
    "La interfaz cambia según el rol autenticado y ofrece paneles separados para administración, operantes y líderes de equipo."
)
doc.add_paragraph(
    "La implementación principal usa React 19 para la interfaz, Vite 6 para desarrollo y empaquetado, Node.js para la API, Supabase "
    "como base de datos y Netlify para publicar el frontend y ejecutar funciones de servidor. La separación entre presentación, acceso "
    "a datos y lógica de negocio permite ampliar módulos sin rehacer el sistema completo."
)
doc.add_paragraph(
    "El repositorio contiene además archivos Python y Streamlit que corresponden a una implementación anterior o auxiliar. Estos "
    "archivos no forman parte del flujo principal definido por package.json y netlify.toml, pero pueden conservarse como referencia "
    "hasta que el equipo decida archivarlos o eliminarlos."
)

add_heading(doc, "2 Alcance funcional", 1)
doc.add_paragraph("La aplicación cubre los siguientes procesos principales:")
add_bullets(doc, [
    "Inicio de sesión y selección automática de la experiencia según el rol del usuario.",
    "Administración de usuarios, estado activo, datos laborales y asignaciones.",
    "Configuración de tareas, campos, reglas de puntaje, rangos y penalizaciones.",
    "Registro y consulta de asistencia con estados operativos y auditoría de cambios.",
    "Gestión de capacitaciones, encargados y avance por trabajador.",
    "Registro de producción y actividades por operante o líder de equipo.",
    "Gestión de tiendas, marcas, lotes, guías, errores e incidencias.",
    "Creación y consulta de amonestaciones y registros operativos.",
    "Dashboard integral de producción, personal, calidad y costos.",
    "Programación y envío de reportes automáticos por correo electrónico.",
    "Importación y exportación de información mediante archivos Excel.",
])

add_heading(doc, "3 Tecnologías utilizadas", 1)
add_table(doc, ["Capa", "Tecnología", "Uso en el sistema"], [
    ["Interfaz", "React 19 y React DOM", "Componentes, estado, navegación por rol y renderizado de paneles."],
    ["Construcción", "Vite 6", "Servidor de desarrollo, sustitución de variables y generación de la carpeta dist."],
    ["Diseño", "CSS propio y Lucide React", "Sistema visual, temas, diseño adaptable e iconografía."],
    ["Acceso a datos", "Supabase JS 2.50", "Consultas directas permitidas y conexión con PostgreSQL administrado."],
    ["Servidor", "Node.js HTTP", "API REST, validaciones, sesiones firmadas y operaciones privilegiadas."],
    ["Alojamiento", "Netlify", "Publicación estática, redirecciones SPA y ejecución de funciones serverless."],
    ["Archivos", "ExcelJS y JSZip", "Lectura, generación, importación y exportación de libros Excel."],
    ["Correo", "Nodemailer", "Envío de reportes automáticos mediante una cuenta configurada."],
    ["Base de datos", "Supabase PostgreSQL", "Persistencia, funciones SQL, restricciones, triggers y migraciones."],
    ["Pruebas", "Node test runner", "Pruebas de reportes, operaciones y métricas del dashboard."],
], widths=[Cm(2.8), Cm(3.7), Cm(9.0)])

add_heading(doc, "4 Arquitectura general", 1)
doc.add_paragraph(
    "La solución sigue una arquitectura web de tres capas. El navegador ejecuta la aplicación React; el módulo repository.js "
    "decide si una operación se resuelve mediante la API o mediante una consulta permitida a Supabase; y la API Node concentra "
    "las operaciones privilegiadas, la validación de sesión y los procesos de reportes."
)

# Diagrama de arquitectura en tabla
arch = doc.add_table(rows=1, cols=7)
arch.alignment = WD_TABLE_ALIGNMENT.CENTER
labels = ["Usuario", "→", "React\nVite", "→", "API Node\nNetlify Functions", "→", "Supabase\nPostgreSQL"]
fills = [PALE_BLUE, "FFFFFF", PALE_BLUE, "FFFFFF", PALE_BLUE, "FFFFFF", PALE_BLUE]
for idx, label in enumerate(labels):
    cell = arch.rows[0].cells[idx]
    cell.text = label
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    set_cell_shading(cell, fills[idx])
    set_cell_border(cell, "D0D7DE")
    set_cell_margins(cell, 160, 80, 160, 80)
    for p in cell.paragraphs:
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(0)
        for run in p.runs:
            run.font.bold = idx % 2 == 0
            run.font.size = Pt(8.5 if idx % 2 == 0 else 11)
doc.add_paragraph()

add_heading(doc, "4.1 Flujo principal de una solicitud", 2)
add_numbered(doc, [
    "El usuario abre la aplicación y Vite entrega los recursos compilados del frontend.",
    "React recupera la sesión local y, si no existe, presenta el componente de inicio de sesión.",
    "El inicio de sesión envía las credenciales a /api/login.",
    "La API consulta la tabla usuarios, comprueba que la cuenta esté activa y emite un token firmado con vencimiento.",
    "El frontend conserva el usuario y el token para solicitudes posteriores.",
    "Las pantallas llaman funciones de repository.js, que normalizan respuestas y errores.",
    "La API valida rol y sesión antes de ejecutar operaciones sensibles sobre Supabase.",
    "React actualiza el estado y vuelve a renderizar únicamente los componentes afectados.",
])

add_heading(doc, "5 Estructura del proyecto", 1)
add_table(doc, ["Ruta", "Responsabilidad"], [
    ["src/components", "Pantallas, paneles por rol, layout, login y componentes reutilizables."],
    ["src/lib", "Acceso a datos, fechas, métricas, puntajes, operaciones, CSV y estado de sesión."],
    ["src/styles.css", "Diseño general, componentes, adaptación móvil y temas globales."],
    ["src/footwear-dashboard.css", "Estilos especializados del dashboard de calzado."],
    ["server.mjs", "Servidor HTTP y enrutador principal de la API."],
    ["services", "Construcción y envío de reportes de asistencia y actividad."],
    ["netlify/functions", "Adaptador serverless que reutiliza el manejador definido en server.mjs."],
    ["sql", "Migraciones incrementales de la base de datos, numeradas en orden."],
    ["scripts", "Migraciones, carga de datos, exportaciones y pruebas de humo."],
    ["tests", "Pruebas automatizadas de lógica de negocio y reportes."],
    ["public", "Recursos públicos servidos sin transformación."],
    ["docs", "Manuales y documentación técnica del sistema."],
    ["dist", "Resultado generado por npm run build; no se edita manualmente."],
], widths=[Cm(4.2), Cm(11.3)])

add_heading(doc, "5.1 Archivos de entrada", 2)
add_bullets(doc, [
    "src/main.jsx inicializa React y carga la hoja de estilos global.",
    "src/App.jsx administra la sesión visible, normaliza el rol y selecciona el dashboard correspondiente.",
    "src/components/Layout.jsx implementa navegación, menú lateral, ajustes y temas.",
    "src/lib/repository.js concentra el contrato de datos consumido por los componentes.",
    "server.mjs implementa el backend local y exporta el manejador reutilizado en Netlify.",
])

add_heading(doc, "6 Construcción del frontend", 1)
doc.add_paragraph(
    "El frontend está construido con componentes funcionales de React. La aplicación no utiliza un router externo; la navegación "
    "administrativa se resuelve mediante el estado adminSection y renderizado condicional. Este enfoque reduce dependencias y es "
    "adecuado para una aplicación de una sola página con un menú controlado."
)
add_heading(doc, "6.1 Componentes principales", 2)
add_table(doc, ["Componente", "Función"], [
    ["Login", "Valida configuración, captura credenciales, muestra mensajes y entrega el usuario autenticado."],
    ["Layout", "Contiene barra lateral, cabecera, perfil, navegación, ajustes y selector de apariencia."],
    ["AdminDashboard", "Agrupa los módulos de administración y selecciona el panel según la sección activa."],
    ["FootwearDashboard", "Presenta métricas, gráficos y filtros globales de la operación de calzado."],
    ["WorkerDashboard", "Permite al operante registrar actividad, consultar historial y visualizar avance."],
    ["GroupLeaderDashboard", "Gestiona producción y actividades de líderes de equipo u otros roles operativos."],
    ["GuideDistribution", "Apoya la distribución y detalle de guías dentro del flujo operativo."],
    ["ui.jsx", "Define botones, paneles, campos, alertas, tablas, pestañas y controles reutilizables."],
], widths=[Cm(4.2), Cm(11.3)])

add_heading(doc, "6.2 Estado y persistencia en el navegador", 2)
doc.add_paragraph(
    "La identidad visible se conserva en localStorage con la clave formulario_usuario_v2. Los filtros y estados temporales de las "
    "pantallas utilizan sessionStorage mediante utilidades de sessionState.js. Al cerrar sesión se eliminan el token de API, el usuario "
    "local y los estados temporales asociados a la sesión."
)

add_heading(doc, "7 Construcción del backend y la API", 1)
doc.add_paragraph(
    "server.mjs implementa un servidor HTTP sin un framework adicional. Incluye lectura de variables de entorno, análisis de cuerpos "
    "JSON, respuestas CORS, validación de sesión, normalización de roles, reglas de negocio y enrutamiento por método y ruta. En modo "
    "local también puede servir la aplicación compilada; en Netlify se reutiliza su función handleRequest mediante un adaptador."
)
add_heading(doc, "7.1 Familias de endpoints", 2)
add_table(doc, ["Familia", "Operaciones representativas"], [
    ["Autenticación", "POST /api/login"],
    ["Usuarios", "GET y POST /api/users; PATCH y DELETE /api/users/:id"],
    ["Tareas y puntajes", "GET y POST /api/tasks; rangos y reglas de puntuación"],
    ["Catálogos", "Marcas, tiendas, lotes, guías y elementos de guía"],
    ["Asistencia", "Consulta, marcación, historial y configuraciones de reporte"],
    ["Actividad", "Registros de operantes, edición, eliminación y cumplimiento"],
    ["Líder de equipo", "Contexto, inicio, actualización, cancelación e historial"],
    ["Incidencias", "Contexto de catálogos y creación o mantenimiento de errores"],
    ["Notificaciones", "Configuraciones, vista previa, envío inmediato e historial"],
], widths=[Cm(4.0), Cm(11.5)])

add_heading(doc, "7.2 Validaciones del servidor", 2)
add_bullets(doc, [
    "Tamaño máximo del cuerpo de solicitud y análisis seguro de JSON.",
    "Comprobación de token antes de operaciones protegidas.",
    "Restricción específica de operaciones administrativas.",
    "Normalización de roles y valores de dominio antes de guardar.",
    "Conversión y validación de identificadores, cantidades, fechas y estados.",
    "Mensajes de error consistentes para consumo del frontend.",
])

add_heading(doc, "8 Base de datos y persistencia", 1)
doc.add_paragraph(
    "Supabase proporciona una base PostgreSQL administrada. setup.sql contiene una base inicial y la carpeta sql mantiene migraciones "
    "incrementales. Las migraciones están numeradas y deben aplicarse en orden para conservar la evolución de tablas, restricciones, "
    "funciones, triggers y políticas."
)
add_heading(doc, "8.1 Entidades principales", 2)
add_table(doc, ["Dominio", "Entidades representativas"], [
    ["Identidad", "usuarios y movimientos de personal"],
    ["Trabajo", "tarea, registros_tareas, registro_actividades y registros de líder"],
    ["Puntaje", "reglas_puntaje, rangos_puntaje y penalizaciones"],
    ["Asistencia", "asistencias, dato_asistencia e historial de cambios"],
    ["Capacitación", "capacitaciones, usuario_capacitaciones y encargados"],
    ["Operación", "tiendas, marcas, lotes, guias y guias_items"],
    ["Calidad", "incidentes, tareas de error y amonestaciones"],
    ["Automatización", "configuraciones e historiales de reportes de asistencia y actividad"],
], widths=[Cm(3.8), Cm(11.7)])

add_heading(doc, "8.2 Estrategia de cambios", 2)
doc.add_paragraph(
    "Cada cambio estructural debe incorporarse como una nueva migración, sin modificar migraciones ya ejecutadas en producción. El "
    "nombre debe conservar un prefijo numérico y una descripción clara. Antes del despliegue se recomienda probar la migración en un "
    "proyecto de Supabase de ensayo, comprobar los datos existentes y registrar un procedimiento de reversión."
)

add_heading(doc, "9 Autenticación autorización y sesiones", 1)
doc.add_paragraph(
    "El login actual consulta la tabla usuarios mediante la API. Cuando las credenciales son válidas y la cuenta está activa, el "
    "servidor genera un token compuesto por un payload codificado y una firma HMAC SHA 256. El payload incluye identificador, rol y "
    "vencimiento de ocho horas. La API compara firmas con timingSafeEqual y rechaza sesiones vencidas o manipuladas."
)
add_table(doc, ["Control", "Implementación"], [
    ["Sesión", "Token Bearer firmado con API_SESSION_SECRET o clave privada equivalente."],
    ["Caducidad", "Ocho horas desde la emisión del token."],
    ["Autorización", "Validación por roles antes de operaciones administrativas u operativas."],
    ["Cuenta inactiva", "El servidor bloquea el acceso y devuelve un código de cuenta bloqueada."],
    ["Cierre de sesión", "El frontend limpia token, usuario y estados almacenados en el navegador."],
    ["Secretos", "Las claves privadas permanecen en variables de entorno del servidor y no se incluyen en el frontend."],
], widths=[Cm(3.8), Cm(11.7)])
doc.add_paragraph(
    "Observación de seguridad: el código revisado compara password_hash con el valor recibido. Para una evolución futura se recomienda "
    "migrar las contraseñas a un algoritmo lento con sal y verificación en servidor, como Argon2id o bcrypt, evitando cualquier "
    "almacenamiento reversible o comparación directa."
)

add_heading(doc, "10 Módulos funcionales y roles", 1)
add_table(doc, ["Rol", "Experiencia principal", "Responsabilidades"], [
    ["Administrador", "AdminDashboard y FootwearDashboard", "Configura catálogos, usuarios, reglas, asistencia, reportes y consulta indicadores."],
    ["Operante", "WorkerDashboard", "Registra tareas y cantidades, consulta su progreso e historial."],
    ["Líder de equipo", "GroupLeaderDashboard", "Registra producción, controla actividades y consulta información de su grupo."],
    ["Otros", "GroupLeaderDashboard", "Usa el flujo operativo compatible con líderes según la normalización de roles."],
], widths=[Cm(3.2), Cm(4.8), Cm(7.5)])

add_heading(doc, "10.1 Secciones administrativas", 2)
add_bullets(doc, [
    "Dashboard calzado con período global y métricas de producción, asistencia, personal y calidad.",
    "Usuarios y movimientos de personal.",
    "Capacitaciones, responsables y avance.",
    "Tareas, campos, puntajes, rangos y penalizaciones.",
    "Asistencia diaria, historial y auditoría.",
    "Notificaciones de asistencia y registros de actividades.",
    "Tiendas, marcas, lotes y guías.",
    "Errores, registros operativos y amonestaciones.",
])

add_heading(doc, "11 Interfaz temas y diseño adaptable", 1)
doc.add_paragraph(
    "La interfaz utiliza una hoja CSS global y un archivo especializado para el dashboard. El diseño se apoya en variables CSS para "
    "colores de fondo, superficies, campos, texto, bordes y acentos. Esta capa permite que los componentes compartan reglas visuales "
    "sin duplicar estilos en cada archivo JSX."
)
add_heading(doc, "11.1 Sistema de temas", 2)
doc.add_paragraph(
    "El menú de ajustes ofrece los temas Predeterminado, Morado, Rosado, Dorado y negro, Verde y Personalizado. El editor personalizado "
    "permite definir fondo general, barra lateral, paneles, campos, color principal, color secundario, texto principal, texto secundario, "
    "bordes y texto de botones. Una vista previa aislada muestra el resultado sin cambiar el color de la ventana de ajustes."
)
add_heading(doc, "11.2 Diseño adaptable", 2)
add_bullets(doc, [
    "Menú lateral contraíble en escritorio y navegación móvil controlada.",
    "Tablas convertibles o desplazables para conservar la información en pantallas estrechas.",
    "Cuadrículas que reducen columnas mediante media queries.",
    "Controles con áreas táctiles amplias y formularios de una columna en móvil.",
    "Dashboard con estilos especializados y panel de período global adaptable.",
])

add_heading(doc, "12 Reportes notificaciones e importación de datos", 1)
add_heading(doc, "12.1 Reportes automáticos", 2)
doc.add_paragraph(
    "Los servicios attendance_report.mjs y activity_report.mjs leen configuraciones, seleccionan trabajadores, construyen resultados y "
    "envían correos mediante Nodemailer. La función programada de Netlify revisa cada minuto las programaciones considerando la zona "
    "horaria America Lima. El historial evita duplicados y conserva evidencia de los envíos."
)
add_heading(doc, "12.2 Archivos Excel", 2)
doc.add_paragraph(
    "ExcelJS y JSZip se usan para procesar libros en el navegador y generar exportaciones. El módulo de guías analiza archivos, separa "
    "cabeceras e ítems, filtra por período y envía lotes de datos a la API. Los paneles administrativos también generan archivos de "
    "usuarios, asistencia, actividades, amonestaciones y capacitaciones."
)

add_heading(doc, "13 Ejecución pruebas y despliegue", 1)
add_heading(doc, "13.1 Requisitos", 2)
add_bullets(doc, [
    "Node.js compatible con Vite 6 y npm.",
    "Proyecto Supabase con las migraciones requeridas.",
    "Variables de entorno públicas para el frontend y privadas para la API.",
    "Cuenta de correo con contraseña de aplicación cuando se habiliten notificaciones.",
])

add_heading(doc, "13.2 Comandos principales", 2)
add_table(doc, ["Comando", "Propósito"], [
    ["npm ci", "Instala exactamente las dependencias definidas en package-lock.json."],
    ["npm run dev", "Inicia el flujo local definido en scripts/dev.mjs."],
    ["npm run api", "Ejecuta únicamente la API local en Node."],
    ["npm run build", "Genera la versión optimizada en dist."],
    ["npm run preview", "Sirve localmente la compilación de producción."],
    ["npm run test:attendance-report", "Ejecuta pruebas de reportes, operaciones y métricas."],
    ["npm run test:dashboard", "Ejecuta pruebas específicas de métricas del dashboard."],
], widths=[Cm(5.0), Cm(10.5)])

add_heading(doc, "13.3 Variables de entorno", 2)
add_table(doc, ["Variable", "Alcance", "Descripción"], [
    ["VITE_SUPABASE_URL", "Frontend", "URL pública del proyecto Supabase."],
    ["VITE_SUPABASE_PUBLISHABLE_KEY", "Frontend", "Clave publicable utilizada por el cliente web."],
    ["SUPABASE_URL", "Servidor", "URL de Supabase utilizada por la API."],
    ["SUPABASE_SECRET_KEY", "Servidor", "Clave privada para operaciones privilegiadas."],
    ["API_SESSION_SECRET", "Servidor", "Secreto largo y aleatorio para firmar sesiones."],
    ["GMAIL_USER", "Servidor", "Cuenta remitente de los reportes."],
    ["GMAIL_APP_PASSWORD", "Servidor", "Contraseña de aplicación; nunca se envía al navegador."],
    ["API_PORT", "Local", "Puerto opcional de la API; el valor predeterminado es 5180."],
], widths=[Cm(5.1), Cm(2.5), Cm(7.9)])

add_heading(doc, "13.4 Despliegue en Netlify", 2)
add_numbered(doc, [
    "Configurar las variables de entorno en Netlify sin incluir secretos en el repositorio.",
    "Aplicar y verificar las migraciones SQL requeridas en Supabase.",
    "Ejecutar las pruebas automatizadas y npm run build.",
    "Publicar el repositorio completo para incluir netlify/functions.",
    "Netlify ejecuta npm run build y publica dist.",
    "La redirección /api/* envía solicitudes a la función api y /* devuelve index.html para la SPA.",
    "Validar login, roles, operaciones críticas y envío de reportes en el entorno publicado.",
])

add_heading(doc, "14 Mantenimiento seguridad y recomendaciones", 1)
add_table(doc, ["Área", "Práctica recomendada"], [
    ["Código", "Mantener componentes pequeños y ampliar repository.js como contrato único de datos."],
    ["Base de datos", "Crear migraciones nuevas, probarlas fuera de producción y respaldar antes de cambios destructivos."],
    ["Seguridad", "Rotar secretos, restringir claves privadas, migrar contraseñas a Argon2id o bcrypt y revisar CORS."],
    ["Sesiones", "Conservar expiración corta, invalidación clara y mensajes de sesión caducada."],
    ["Pruebas", "Agregar pruebas por cada regla de puntaje, cálculo, reporte y corrección de errores."],
    ["Rendimiento", "Dividir paquetes grandes con importaciones dinámicas y cargar paneles solo cuando se utilizan."],
    ["Observabilidad", "Registrar errores de API, fallos de correos y duración de operaciones críticas sin exponer datos sensibles."],
    ["Documentación", "Actualizar este documento junto con cambios de arquitectura, variables, roles o despliegue."],
    ["Legado", "Separar o archivar la aplicación Python cuando se confirme que ya no interviene en producción."],
], widths=[Cm(3.2), Cm(12.3)])

add_heading(doc, "14.1 Riesgos técnicos identificados", 2)
add_bullets(doc, [
    "server.mjs y AdminDashboard.jsx concentran gran cantidad de lógica; conviene dividirlos por dominio.",
    "La compilación produce paquetes JavaScript grandes, especialmente por las bibliotecas de Excel.",
    "La autenticación personalizada requiere controles rigurosos y una futura migración de contraseñas.",
    "El número de migraciones exige disciplina para conocer qué scripts ya fueron aplicados en cada ambiente.",
    "La coexistencia de React y archivos Python puede generar confusión si no se documenta su estado operativo.",
])

add_heading(doc, "15 Referencia técnica rápida", 1)
add_heading(doc, "15.1 Secuencia para incorporar una nueva función", 2)
add_numbered(doc, [
    "Definir el proceso, los roles autorizados y los datos requeridos.",
    "Crear una migración SQL si cambia el modelo de datos.",
    "Agregar o ampliar el endpoint correspondiente en la API.",
    "Incorporar la función de acceso en src/lib/repository.js.",
    "Construir el componente React reutilizando los controles de ui.jsx.",
    "Añadir estilos mediante variables del tema y reglas adaptables.",
    "Crear pruebas para la lógica y realizar una prueba manual por rol.",
    "Compilar, revisar el despliegue y actualizar la documentación.",
])

add_heading(doc, "15.2 Criterio de finalización técnica", 2)
add_bullets(doc, [
    "La funcionalidad trabaja con los roles previstos y rechaza los no autorizados.",
    "Los datos se validan tanto en la interfaz como en el servidor.",
    "No se exponen secretos, contraseñas ni claves privadas en el navegador.",
    "El diseño se mantiene legible en escritorio y celular para todos los temas.",
    "Las pruebas automatizadas y la compilación de producción finalizan correctamente.",
    "La migración, variables y procedimiento de despliegue quedan documentados.",
])

closing = doc.add_paragraph(
    "Conclusión. La aplicación presenta una base funcional amplia y una separación clara entre interfaz, acceso a datos, API y base "
    "de datos. Su evolución debe concentrarse en reforzar la autenticación, modularizar los archivos de mayor tamaño, ampliar las "
    "pruebas y mantener controlada la secuencia de migraciones."
)
closing.paragraph_format.keep_together = False
closing.paragraph_format.space_before = Pt(9)
closing.runs[0].font.bold = True

# Encabezado y pie
for sec in doc.sections:
    header = sec.header
    hp = header.paragraphs[0]
    hp.text = "Sistema de Formularios   Documentación técnica"
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in hp.runs:
        run.font.name = "Aptos"
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor(100, 116, 139)
    footer = sec.footer
    fp = footer.paragraphs[0]
    add_page_number(fp)

# Evita encabezado en la portada y conserva el pie discreto.
doc.sections[0].different_first_page_header_footer = True

# Propiedades básicas
doc.core_properties.title = "Construcción y arquitectura del Sistema de Formularios"
doc.core_properties.subject = "Documentación técnica de la aplicación web"
doc.core_properties.author = "Equipo del Sistema de Formularios"
doc.core_properties.keywords = "React, Vite, Node, Supabase, Netlify, arquitectura, formularios"

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(OUTPUT)
print(OUTPUT)
