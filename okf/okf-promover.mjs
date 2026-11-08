// okf-promover — lógica compartida de promoción de notas del kit (preset micerebro):
// validar la ficha, decidir su carpeta, escribirla y anotar index.md y log.md.
// La usan el revisor (borrador → nota) y el guardado directo (okf guardar, okf_guardar, okf-migrar).
// Cero dependencias externas: solo módulos internos de Node.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fichaBorradorKit } from './okf-config.mjs';
import { atomicWrite, parseFrontmatter } from './okf-comun.mjs';

export function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

// --- Promoción a carpetas ------------------------------------------------------
// Un borrador válido (type/title/description) va a la carpeta de su type; los datados
// (decision, aprendizaje) llevan prefijo AAAA-MM-DD-. Cualquier otro type cae en
// `carpetaDefecto` (memoria/): promover es decidir que algo debe durar, y `memoria/` es
// donde MiCerebro pone «lo que debe durar»; repartirlo por proyectos/areas/recursos exigiría
// adivinar subcarpetas que el kit organiza a mano. Nunca pisa un fichero: sufijo -2, -3…

export function slugKit(texto, respaldo) {
  const slug = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || respaldo;
}

export function validateKit(draft, cfg) {
  const { data, hasFrontmatter } = draft;
  const campo = cfg.campoNombre;
  const details = [];
  if (!hasFrontmatter) details.push('sin frontmatter');
  if (!data[campo]) details.push(`falta ${campo}`);
  if (!data.description) details.push('falta description');
  if (!data.type) details.push('falta type');
  else if (!cfg.tiposSet.has(data.type)) details.push(`type inválido: ${data.type}`);
  if (data.actualizado && !parseIsoDate(data.actualizado)) details.push(`actualizado inválido: ${data.actualizado}`);
  return details.length ? [`R1 — ${details.join(', ')}`] : [];
}

export function destinoKit(root, draft, cfg, hoy) {
  const rev = cfg.revisor;
  const carpeta = (rev.destinos || {})[draft.data.type] || rev.carpetaDefecto;
  const dir = path.join(root, carpeta);
  const slug = slugKit(draft.data[cfg.campoNombre], slugKit(path.basename(draft.file, '.md'), 'nota'));
  const base = (rev.datados || []).includes(draft.data.type) ? `${hoy}-${slug}` : slug;
  let file = path.join(dir, `${base}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.md`);
  return file;
}

// Pone `status: stable` en la ficha (sustituye la línea o la añade antes del cierre).
function fichaEstable(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return content;
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  const lineas = m[1].split(/\r?\n/);
  const i = lineas.findIndex((l) => /^status:/.test(l));
  if (i >= 0) lineas[i] = 'status: stable'; else lineas.push('status: stable');
  return `---${nl}${lineas.join(nl)}${nl}---${content.slice(m[0].length)}`;
}

const unaLinea = (v) => String(v).replace(/\s*\r?\n\s*/g, ' ').trim();

// Añade `* [Título](fichero) - descripción` al index.md de la carpeta; lo crea sin ficha si falta.
function anotarIndice(dir, file, titulo, descripcion) {
  const indexPath = path.join(dir, 'index.md');
  const linea = `* [${unaLinea(titulo)}](${path.basename(file)}) - ${unaLinea(descripcion)}`;
  if (!fs.existsSync(indexPath)) {
    const nombre = path.basename(dir);
    atomicWrite(indexPath, `# ${nombre.charAt(0).toUpperCase()}${nombre.slice(1)}\n\n${linea}\n`);
    return;
  }
  const lineas = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/);
  // El marcador «(Vacío por ahora…)» de las plantillas se va con la primera entrada.
  const sinVacio = lineas.filter((l) => !/^\(Vacío por ahora/.test(l.trim()));
  const ultima = sinVacio.reduce((last, l, i) => (/^[*-]\s*\[/.test(l) ? i : last), -1);
  if (ultima >= 0) sinVacio.splice(ultima + 1, 0, linea);
  else {
    while (sinVacio.length && sinVacio.at(-1).trim() === '') sinVacio.pop();
    sinVacio.push('', linea);
  }
  atomicWrite(indexPath, `${sinVacio.join('\n').replace(/\n*$/, '\n')}`);
}

// Entrada `* **Creación**: …` bajo `## hoy` en el log de la raíz: la cabecera de fecha, si no está,
// va arriba (antes del primer `## `, o sea tras el título); la entrada, al final de la sección de hoy.
function anotarLog(logPath, hoy, entrada) {
  if (!fs.existsSync(logPath)) {
    atomicWrite(logPath, `# Log\n\n## ${hoy}\n\n${entrada}\n`);
    return;
  }
  const lineas = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  while (lineas.length && lineas.at(-1).trim() === '') lineas.pop();
  const cabecera = lineas.findIndex((l) => l.trim() === `## ${hoy}`);
  if (cabecera >= 0) {
    let fin = lineas.findIndex((l, i) => i > cabecera && /^##\s/.test(l));
    if (fin < 0) fin = lineas.length;
    while (fin > cabecera + 1 && lineas[fin - 1].trim() === '') fin--;
    lineas.splice(fin, 0, entrada);
  } else {
    let primera = lineas.findIndex((l) => /^##\s/.test(l));
    if (primera < 0) primera = lineas.length;
    const bloque = ['## ' + hoy, '', entrada, ...(primera < lineas.length ? [''] : [])];
    if (primera > 0 && lineas[primera - 1].trim() !== '') bloque.unshift('');
    lineas.splice(primera, 0, ...bloque);
  }
  atomicWrite(logPath, `${lineas.join('\n')}\n`);
}

// Escribe la nota en su destino (ficha estable) y la anota en el index.md de su carpeta y en el log.
// Es el camino común del revisor (promoverKit) y del guardado directo. No toca el borrador.
// `destinoFijo` (opcional): ruta ya decidida por quien planificó (okf-migrar); si no, la elige destinoKit.
export function escribirNotaKit(root, draft, cfg, hoy, destinoFijo = null) {
  const destino = destinoFijo || destinoKit(root, draft, cfg, hoy);
  if (destinoFijo && fs.existsSync(destino)) throw new Error(`el destino ya existe, no se pisa: ${destino}`);
  const titulo = draft.data[cfg.campoNombre];
  atomicWrite(destino, fichaEstable(draft.content));
  anotarIndice(path.dirname(destino), destino, titulo, draft.data.description);
  const rel = path.relative(root, destino).split(path.sep).join('/');
  anotarLog(path.join(root, cfg.revisor.log), hoy, `* **Creación**: \`${rel}\` — ${unaLinea(draft.data.description)}`);
  return { ...draft, file: destino };
}

export function promoverKit(root, draft, cfg, hoy) {
  const nota = escribirNotaKit(root, draft, cfg, hoy);
  fs.unlinkSync(draft.file);
  return nota;
}

// Carpeta y nombre base (sin extensión) que tendría una nota del kit; sin mirar colisiones.
export function rutaBaseKit(root, tipo, titulo, cfg, hoy) {
  const rev = cfg.revisor;
  const dir = path.join(root, (rev.destinos || {})[tipo] || rev.carpetaDefecto);
  const slug = slugKit(titulo, 'nota');
  return { dir, base: (rev.datados || []).includes(tipo) ? `${hoy}-${slug}` : slug };
}

// Guardado directo (guardar.modo "directo"): construye la ficha, la valida con validateKit y,
// solo si valida, la escribe como la promovería el revisor. Si ya hay una nota con ese nombre,
// destinoKit añade -2, -3… (nunca pisa). Lanza Error sin escribir nada si la ficha no valida.
export function guardarDirecto(root, cfg, { tipo, titulo, cuerpo, fecha }) {
  const content = fichaBorradorKit({ tipo, titulo: String(titulo).trim(), cuerpo, fecha });
  const fm = parseFrontmatter(content);
  const draft = { file: path.join(root, 'nota.md'), content, body: fm.body, data: fm.data, hasFrontmatter: fm.hasFrontmatter };
  const fallos = validateKit(draft, cfg);
  if (fallos.length) throw new Error(`ficha inválida, no se ha guardado nada: ${fallos.join('; ')}`);
  return escribirNotaKit(root, draft, cfg, fecha).file;
}
