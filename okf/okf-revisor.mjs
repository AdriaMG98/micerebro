#!/usr/bin/env node
// okf-revisor — filtro determinista de borradores para la memoria curada OKF.
// Cero dependencias externas: solo módulos internos de Node.
//
// Uso: node okf-revisor.mjs [--dry-run] [--no-commit] [--no-push] [--root <ruta>]
// Raíz: --root > OKF_ROOT > okf.config.json hacia arriba desde el cwd > cwd.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { cargarConfig } from './okf-config.mjs';
import { defaultRoot, atomicWrite, parseFrontmatter, readNotes, sincronizar } from './okf-comun.mjs';

// Rutas, tipos, borradores y carpetas de destino salen de okf-config (cargarConfig).

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// --- Promoción a carpetas ------------------------------------------------------
// Un borrador válido (type/title/description) va a la carpeta de su type; los datados
// (decision, aprendizaje) llevan prefijo AAAA-MM-DD-. Cualquier otro type cae en
// `carpetaDefecto` (memoria/): promover es decidir que algo debe durar, y `memoria/` es
// donde MiCerebro pone «lo que debe durar»; repartirlo por proyectos/areas/recursos exigiría
// adivinar subcarpetas que el kit organiza a mano. Nunca pisa un fichero: sufijo -2, -3…

function slugKit(texto, respaldo) {
  const slug = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || respaldo;
}

function validateKit(draft, cfg) {
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

function destinoKit(root, draft, cfg, hoy) {
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

function promoverKit(root, draft, cfg, hoy) {
  const destino = destinoKit(root, draft, cfg, hoy);
  const titulo = draft.data[cfg.campoNombre];
  atomicWrite(destino, fichaEstable(draft.content));
  anotarIndice(path.dirname(destino), destino, titulo, draft.data.description);
  const rel = path.relative(root, destino).split(path.sep).join('/');
  anotarLog(path.join(root, cfg.revisor.log), hoy, `* **Creación**: \`${rel}\` — ${unaLinea(draft.data.description)}`);
  fs.unlinkSync(draft.file);
  return { ...draft, file: destino };
}

// --- Sincronización ----------------------------------------------------------
// Lo promovido se commitea en el repo de la raíz, limitado a `revisor.rutasSincronizadas`
// (nunca arrastra trabajo ajeno suelto). El push solo ocurre si hay remoto y upstream.
function parseArgs(argv) {
  const out = { flags: new Set(), root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
    else out.flags.add(a);
  }
  return out;
}

const apagado = (v) => /^(0|false|no|off)$/i.test(String(v || '').trim());

async function main() {
  const { flags: args, root: rootArg } = parseArgs(process.argv.slice(2));
  if (args.has('-h') || args.has('--help')) {
    console.log('Uso: node okf-revisor.mjs [--dry-run] [--no-commit] [--no-push] [--root <ruta>]\n  OKF_REVISOR_COMMIT=0 equivale a --no-commit; OKF_REVISOR_PUSH=0 a --no-push.');
    return;
  }
  const dryRun = args.has('--dry-run');
  const commit = !args.has('--no-commit') && !apagado(process.env.OKF_REVISOR_COMMIT);
  const push = !args.has('--no-push') && !apagado(process.env.OKF_REVISOR_PUSH);
  const root = path.resolve(rootArg || defaultRoot());
  const cfg = cargarConfig(root);
  const borradores = cfg.borradoresDir;
  const hoy = todayUtc().toISOString().slice(0, 10);
  // `_rechazados/` es archivo: el revisor no lo lee.
  const enRechazados = (note) => path.relative(borradores, note.file).split(path.sep)[0] === '_rechazados';
  const esIndice = (note) => ['index.md', 'log.md'].includes(path.basename(note.file).toLowerCase());
  const drafts = readNotes(borradores).filter((note) => !enRechazados(note) && !esIndice(note));
  let promoted = 0;
  let doubtful = 0;

  for (const draft of drafts) {
    const rel = path.relative(root, draft.file).split(path.sep).join('/');
    let failures;
    try {
      failures = validateKit(draft, cfg);
    } catch (error) {
      // Un borrador raro tampoco tumba la pasada: queda dudoso y se sigue.
      failures = [`Validación fallida — ${error.message}`];
    }
    if (failures.length) {
      doubtful++;
      console.log(`DUDOSO: ${rel} — ${failures.join('; ')}`);
      continue;
    }
    if (dryRun) {
      promoted++;
      console.log(`PROMOCIONARÍA: ${rel} → ${path.relative(root, destinoKit(root, draft, cfg, hoy)).split(path.sep).join('/')}`);
      continue;
    }
    try {
      const nota = promoverKit(root, draft, cfg, hoy);
      promoted++;
      console.log(`PROMOCIONADO: ${rel} → ${path.relative(root, nota.file).split(path.sep).join('/')}`);
    } catch (error) {
      doubtful++;
      console.log(`DUDOSO: ${rel} — Promoción fallida — ${error.message}`);
    }
  }
  const resumen = `${promoted} promocionados, ${doubtful} dudosos`;
  console.log(`Resumen: ${drafts.length} borradores revisados, ${resumen}.`);
  if (dryRun) console.log('Sync: omitido (--dry-run).');
  else {
    // Solo lo que existe: `git add` rechaza una ruta sin coincidencias.
    const rutas = cfg.revisor.rutasSincronizadas.filter((r) => fs.existsSync(path.join(root, r)));
    sincronizar(root, resumen, { rutas, firma: 'okf-revisor automático', commit, push });
  }
}

main().catch((error) => {
  console.error(`OKF revisor error: ${error.message}`);
  process.exitCode = 1;
});
