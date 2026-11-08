#!/usr/bin/env node
// okf-migrar — trae memoria de otros sitios a un cerebro MiCerebro, siempre por COPIA.
// Cero dependencias externas: solo módulos internos de Node.
//
// Uso: node okf-migrar.mjs --origen <ruta> [--tipo libreta|carpeta|planes|auto] [--root <ruta>]
//                          --dry-run | --aplicar [--sin-adjuntos] [--hoy AAAA-MM-DD]
// Raíz: --root > OKF_ROOT > okf.config.json hacia arriba desde el cwd > cwd.
//
// Tres orígenes:
//   libreta  MEMORY.md / USER.md de Hermes (entradas separadas por `§`): cada entrada es un
//            nota (USER.md → persona, MEMORY.md → nota): en guardar.modo «directo» (defecto) ya promovida
//            en su carpeta con index.md y log.md; en «borrador», en memoria/borradores/ para el revisor.
//   carpeta  Markdown / bóveda Obsidian: cada .md pasa a nota con ficha del kit. proyecto, area,
//            recurso y plan van directos a proyectos/, areas/, recursos/, planes/; todo lo demás
//            (nota, decision, aprendizaje, persona…) se promueve directo (modo «directo») o cae en
//            borradores/ para que el revisor lo coloque (modo «borrador»). Los adjuntos (no .md) se copian a recursos/adjuntos/<carpeta>/.
//   planes   .md de planes: todos a planes/ con type plan.
//
// Garantías: el origen no se toca (solo se lee); nunca se pisa un destino (sufijo -2, -3…);
// todo destino queda dentro de la raíz (sin `..`, sin seguir enlaces simbólicos);
// --dry-run no escribe nada. Al aplicar deja registro/AAAA-MM-DD-migrar-<nombre>.md con sha256.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolverRaiz, exigirCerebro, cargarConfig, fichaBorradorKit } from './okf-config.mjs';
import { parseFrontmatter } from './okf-comun.mjs';
import { rutaBaseKit, validateKit, escribirNotaKit } from './okf-promover.mjs';

// Mapa de tipos de otros mundos (user|feedback|project|reference, notas genéricas) → tipos del kit.
export const MAPA_TIPOS = {
  user: 'persona', feedback: 'aprendizaje', project: 'proyecto', reference: 'recurso',
  note: 'nota', notes: 'nota', daily: 'nota', decision: 'decision', area: 'area',
};
// Tipos que van directos a su carpeta (no necesitan el revisor para colocarse).
const CARPETA_DIRECTA = { proyecto: 'proyectos', area: 'areas', recurso: 'recursos', plan: 'planes' };
const OCULTOS_IGNORADOS = 'ficheros y carpetas que empiezan por «.» (.obsidian, .git, .trash…) y node_modules';

export function slug(texto, respaldo = 'nota') {
  const s = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || respaldo;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');
const iso = (d) => d.toISOString().slice(0, 10);
const esFecha = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function dentro(base, destino) {
  const rel = path.relative(base, destino);
  return rel === '' || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

// ── recorrido del origen ─────────────────────────────────────────────────────
// Devuelve ficheros ({abs, rel}) e ignorados ({rel, motivo}). Nunca sigue enlaces simbólicos.
function recorrer(origenDir, rootReal) {
  const ficheros = [];
  const ignorados = [];
  const visitar = (dir, relDir) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { ignorados.push({ rel: relDir || '.', motivo: `ilegible: ${e.code || e.message}` }); return; }
    entradas.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entradas) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { ignorados.push({ rel, motivo: 'enlace simbólico (no se sigue)' }); continue; }
      if (e.name.startsWith('.') || e.name === 'node_modules') { ignorados.push({ rel, motivo: 'oculto/sistema' }); continue; }
      if (e.isDirectory()) {
        if (fs.realpathSync(abs) === rootReal) { ignorados.push({ rel, motivo: 'es la raíz del cerebro' }); continue; }
        visitar(abs, rel);
      } else if (e.isFile()) ficheros.push({ abs, rel });
      else ignorados.push({ rel, motivo: 'no es un fichero normal' });
    }
  };
  visitar(origenDir, '');
  return { ficheros, ignorados };
}

// ── libreta Hermes ───────────────────────────────────────────────────────────
export function partirLibreta(texto) {
  const t = texto.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  let partes = t.split(/^[ \t]*§[ \t]*$/m);
  if (partes.length === 1 && t.includes('§')) partes = t.split('§');
  return partes.map((p) => p.trim()).filter(Boolean);
}

function tituloDeEntrada(texto) {
  const linea = texto.split('\n').find((l) => l.trim()) || 'nota';
  let t = linea.trim().replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
  if (t.length > 70) t = t.slice(0, 70).replace(/\s+\S*$/, '') + '…';
  return t;
}

// ── frontmatter y enlaces ────────────────────────────────────────────────────
// Bloques de clave de primer nivel con sus líneas hijas, para conservar lo que no mapeamos.
function bloquesFrontmatter(texto) {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const bloques = [];
  if (!m) return bloques;
  for (const linea of m[1].split(/\r?\n/)) {
    const k = linea.match(/^([A-Za-z_][\w-]*):/);
    if (k) bloques.push({ clave: k[1], lineas: [linea] });
    else if (bloques.length && /^\s+\S/.test(linea)) bloques.at(-1).lineas.push(linea);
  }
  return bloques;
}

// Aplica `fn` solo fuera de código (bloques ``` / ~~~ y `en línea`).
function fueraDeCodigo(texto, fn) {
  const partes = texto.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m);
  return partes.map((p, i) => (i % 2 === 1 ? p : p.split(/(`[^`\n]*`)/).map((q, j) => (j % 2 === 1 ? q : fn(q))).join(''))).join('');
}

function reescribirEnlaces(cuerpo, ctx) {
  const { destino, buscarNota, buscarAdjunto } = ctx;
  const rel = (objetivo) => posix(path.relative(path.dirname(destino), objetivo)) || path.basename(objetivo);
  return fueraDeCodigo(cuerpo, (txt) => {
    // [[destino]], [[destino|alias]], [[destino#sección]], ![[adjunto.png]]
    txt = txt.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (_, bang, interior) => {
      const [objetivoCrudo, ...resto] = interior.split('|');
      const alias = resto.join('|').trim();
      const sinAncla = objetivoCrudo.split('#')[0].split('^')[0].trim();
      const visible = alias || objetivoCrudo.replace(/[#^]/g, ' › ').split('/').pop().trim() || sinAncla;
      if (!sinAncla) return visible;
      const adj = buscarAdjunto(sinAncla);
      if (adj) return `${bang}[${visible}](${rel(adj)})`;
      const nota = buscarNota(sinAncla);
      if (nota) return `[${visible}](${rel(nota)})`;
      return visible;
    });
    // [texto](otra-nota.md) relativos al origen: se apuntan al destino si lo conocemos
    txt = txt.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g, (todo, bang, texto, href) => {
      if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return todo;
      const [ruta, ancla] = href.split('#');
      let limpia;
      try { limpia = decodeURI(ruta); } catch { limpia = ruta; }
      const obj = ctx.buscarRelativo(limpia);
      return obj ? `${bang}[${texto}](${rel(obj)}${ancla ? '#' + ancla : ''})` : todo;
    });
    return txt;
  });
}

// Una línea de texto plano para la description: sin sintaxis de enlaces, imágenes, wikilinks ni Markdown.
export function limpiarDescripcion(texto, max = 200) {
  let t = String(texto)
    .replace(/!?\[\[([^\]\n]+?)\]\]/g, (_, i) => i.split('|').pop().split('#')[0].split('/').pop())
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/^\s*(?:[#>]+|[-*+]\s+(?:\[[ x~?]\]\s+)?|\d+\.\s+)/, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

// ── plan de migración (sin escribir nada) ────────────────────────────────────
// Cada elemento: { origen (texto), origenAbs|null, tipo, destino (ruta absoluta), accion, contenido|null, nota }
export function planificar({ origen, tipo, root, hoy, adjuntos = true }) {
  const rootReal = fs.realpathSync(root);
  const cfg = cargarConfig(root);
  const tiposKit = cfg.tiposSet;
  const tipoDefecto = cfg.tipoDefecto || cfg.tipos[0];
  const origenAbs = path.resolve(origen);
  if (!fs.existsSync(origenAbs)) throw new Error(`el origen no existe: ${origen}`);
  const origenReal = fs.realpathSync(origenAbs);
  if (dentro(rootReal, origenReal) || dentro(origenReal, rootReal)) {
    throw new Error(`el origen (${origenReal}) no puede ser la raíz del cerebro (${rootReal}), contenerla ni estar dentro de ella: migrar es copiar de fuera hacia dentro`);
  }
  const stat = fs.statSync(origenReal);
  const nombreOrigen = path.basename(origenReal);

  // Tipo de migración
  let modo = tipo;
  if (!['libreta', 'carpeta', 'planes', 'auto'].includes(modo)) throw new Error(`--tipo debe ser libreta, carpeta, planes o auto (era «${tipo}»)`);
  const esLibretaFichero = (f) => /^(memory|user)\.md$/i.test(path.basename(f));
  if (modo === 'auto') {
    if (stat.isFile()) modo = esLibretaFichero(origenReal) || fs.readFileSync(origenReal, 'utf8').includes('§') ? 'libreta' : 'carpeta';
    else {
      const md = fs.readdirSync(origenReal, { withFileTypes: true }).filter((e) => e.isFile() && /\.md$/i.test(e.name));
      modo = md.length > 0 && md.every((e) => esLibretaFichero(e.name)) && !fs.readdirSync(origenReal, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.')) ? 'libreta' : 'carpeta';
    }
  }

  const items = [];
  const ignorados = [];
  let conflictos = 0;
  const usados = new Set(); // destinos ya reservados en este plan (minúsculas)
  const libre = (abs) => {
    const k = abs.toLowerCase();
    return !usados.has(k) && !fs.existsSync(abs) && !isLink(abs);
  };
  const reservar = (dir, base, ext) => {
    let n = 1;
    let abs;
    do {
      abs = path.join(dir, `${base}${n === 1 ? '' : '-' + n}${ext}`);
      n++;
    } while (!libre(abs));
    if (n > 2) conflictos++;
    usados.add(abs.toLowerCase());
    return abs;
  };
  const dirTipo = (t) => path.join(root, CARPETA_DIRECTA[t]);
  // Notas sin carpeta propia: en modo directo van ya a su carpeta de `revisor` (index.md y log.md
  // incluidos, como las promovería el revisor); en modo borrador, a borradores/ para el revisor.
  const modoDirecto = cfg.guardar.modo === 'directo';
  const destinoNota = (tipo, titulo, respaldo) => {
    if (!modoDirecto) return { abs: reservar(cfg.borradoresDir, respaldo, '.md'), promover: false };
    const { dir, base } = rutaBaseKit(root, tipo, titulo, cfg, hoy);
    return { abs: reservar(dir, base, '.md'), promover: true };
  };

  if (modo === 'libreta') {
    const ficheros = stat.isFile() ? [origenReal] : fs.readdirSync(origenReal, { withFileTypes: true })
      .filter((e) => e.isFile() && esLibretaFichero(e.name)).map((e) => path.join(origenReal, e.name));
    if (!ficheros.length) throw new Error('no hay MEMORY.md ni USER.md en el origen');
    for (const f of ficheros) {
      const raw = fs.readFileSync(f);
      const entradas = partirLibreta(raw.toString('utf8'));
      const tipoE = /^user\.md$/i.test(path.basename(f)) && tiposKit.has('persona') ? 'persona' : tipoDefecto;
      const hash = sha256(raw);
      entradas.forEach((cuerpo, i) => {
        const titulo = tituloDeEntrada(cuerpo);
        const { abs, promover } = destinoNota(tipoE, titulo, slug(titulo, `entrada-${i + 1}`));
        items.push({ origen: `${path.basename(f)} §${i + 1}`, origenAbs: f, sha: hash, tipo: tipoE, destino: abs, accion: promover ? 'directo' : 'borrador', promover, contenido: fichaBorradorKit({ tipo: tipoE, titulo, cuerpo, fecha: hoy }) });
      });
    }
    return { modo, items, ignorados, cfg, nombreOrigen, rootReal, conflictos };
  }

  // carpeta | planes
  let ficheros;
  let baseDir;
  if (stat.isFile()) {
    baseDir = path.dirname(origenReal);
    ficheros = [{ abs: origenReal, rel: path.basename(origenReal) }];
  } else {
    baseDir = origenReal;
    const r = recorrer(origenReal, rootReal);
    ficheros = r.ficheros;
    ignorados.push(...r.ignorados);
  }
  const mds = ficheros.filter((f) => /\.md$/i.test(f.rel));
  const otros = ficheros.filter((f) => !/\.md$/i.test(f.rel));

  // 1.ª pasada: leer, decidir tipo y destino de cada .md
  const notas = [];
  for (const f of mds) {
    const raw = fs.readFileSync(f.abs);
    const texto = raw.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const fm = parseFrontmatter(texto);
    const d = fm.data;
    const crudo = typeof d.type === 'string' ? d.type.trim().toLowerCase() : '';
    let tipoN = modo === 'planes' ? 'plan' : (MAPA_TIPOS[crudo] || (tiposKit.has(crudo) ? crudo : tipoDefecto));
    if (!tiposKit.has(tipoN)) tipoN = tipoDefecto;
    const h1 = (fm.body.match(/^#\s+(.+)$/m) || [])[1];
    const base = path.basename(f.rel, path.extname(f.rel));
    const titulo = String(d.title || d.name || h1 || base.replace(/[-_]+/g, ' ')).trim();
    const directo = CARPETA_DIRECTA[tipoN] && cfg.tiposSet.has(tipoN);
    let abs;
    let promover = false;
    if (directo) abs = reservar(dirTipo(tipoN), slug(base, slug(titulo)), '.md');
    else ({ abs, promover } = destinoNota(tipoN, titulo, slug(base, slug(titulo))));
    notas.push({ f, raw, fm, d, crudo, tipoN, titulo, base, directo, promover, abs, texto, bloques: bloquesFrontmatter(texto), mtime: fs.statSync(f.abs).mtime });
  }
  // adjuntos
  const adj = [];
  if (adjuntos) {
    const dirAdj = path.join(root, 'recursos', 'adjuntos', slug(nombreOrigen, 'migracion'));
    for (const f of otros) {
      const ext = path.extname(f.rel).toLowerCase().replace(/[^.a-z0-9]/g, '');
      const abs = reservar(dirAdj, slug(path.basename(f.rel, path.extname(f.rel)), 'adjunto'), ext);
      adj.push({ f, abs });
    }
  } else for (const f of otros) ignorados.push({ rel: f.rel, motivo: 'adjunto (--sin-adjuntos)' });

  // índices de resolución de enlaces
  const porRuta = new Map();
  const porNombre = new Map();
  const adjPorNombre = new Map();
  for (const n of notas) {
    const sinExt = n.f.rel.replace(/\.md$/i, '').toLowerCase();
    porRuta.set(sinExt, n.abs);
    const b = path.basename(sinExt);
    if (!porNombre.has(b)) porNombre.set(b, n.abs);
  }
  for (const a of adj) {
    const b = path.basename(a.f.rel).toLowerCase();
    if (!adjPorNombre.has(b)) adjPorNombre.set(b, a.abs);
  }
  const relPorAbs = new Map([...notas.map((n) => [path.resolve(baseDir, n.f.rel), n.abs]), ...adj.map((a) => [path.resolve(baseDir, a.f.rel), a.abs])]);
  const resolver = (n) => ({
    destino: n.abs,
    buscarNota: (t) => { const k = t.toLowerCase().replace(/\.md$/i, ''); return porRuta.get(k) || porNombre.get(path.basename(k)) || null; },
    buscarAdjunto: (t) => adjPorNombre.get(path.basename(t).toLowerCase()) || null,
    buscarRelativo: (r) => relPorAbs.get(path.resolve(path.dirname(path.resolve(baseDir, n.f.rel)), r)) || null,
  });

  // 2.ª pasada: contenido final
  for (const n of notas) {
    const { d } = n;
    const manejadas = new Set(['type', 'title', 'name', 'description', 'status', 'actualizado']);
    const cuerpo = reescribirEnlaces(n.fm.body, resolver(n)).replace(/^\n+/, '').trimEnd();
    const primera = cuerpo.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => limpiarDescripcion(l)).find((l) => l && !/^-{3,}$/.test(l)) || limpiarDescripcion(n.titulo) || 'Nota migrada';
    const description = String(d.description || primera).trim();
    const fecha = [d.actualizado, d.updated, String(d.date || '').slice(0, 10)].find(esFecha) || iso(n.mtime);
    const status = n.directo ? (d.status || 'draft') : 'draft'; // una nota promovida pasa a stable al escribirse
    const extras = n.bloques.filter((b) => !manejadas.has(b.clave) && !['tipo_original', 'origen'].includes(b.clave)).flatMap((b) => b.lineas);
    const cambioTipo = n.crudo && n.crudo !== n.tipoN;
    const cab = [
      '---', `type: ${n.tipoN}`, `title: ${JSON.stringify(n.titulo)}`, `description: ${JSON.stringify(description)}`,
      `status: ${status}`, `actualizado: ${fecha}`,
      ...(cambioTipo ? [`tipo_original: ${JSON.stringify(n.crudo)}`] : []),
      `origen: ${JSON.stringify(n.f.rel)}`, ...extras, '---', '',
    ].join('\n');
    const nota = cambioTipo ? (MAPA_TIPOS[n.crudo] ? `type ${n.crudo} → ${n.tipoN}` : `type ${n.crudo} desconocido → ${n.tipoN}`) : '';
    items.push({
      origen: n.f.rel, origenAbs: n.f.abs, sha: sha256(n.raw), tipo: n.tipoN, destino: n.abs,
      accion: n.directo || n.promover ? 'directo' : 'borrador', promover: n.promover, contenido: `${cab}\n${cuerpo}\n`, nota,
    });
  }
  for (const a of adj) {
    items.push({ origen: a.f.rel, origenAbs: a.f.abs, sha: sha256(fs.readFileSync(a.f.abs)), tipo: 'adjunto', destino: a.abs, accion: 'adjunto', contenido: null, nota: '' });
  }
  return { modo, items, ignorados, cfg, nombreOrigen, rootReal, conflictos };
}

function isLink(abs) {
  try { fs.lstatSync(abs); return true; } catch { return false; }
}

// ── escritura (solo con --aplicar) ───────────────────────────────────────────
// Antepone al destino el chequeo de confinamiento: el ancestro existente más cercano debe
// resolver (realpath) dentro de la raíz, así un directorio-enlace no saca la escritura fuera.
function asegurarDentro(rootReal, abs) {
  let d = path.dirname(abs);
  while (!isLink(d)) d = path.dirname(d);
  const real = fs.realpathSync(d);
  if (!dentro(rootReal, real)) throw new Error(`destino fuera de la raíz: ${abs}`);
}

export function aplicar(plan, root, hoy) {
  const rootReal = plan.rootReal;
  const hechos = [];
  // Lo que se promueve se valida entero antes de escribir nada.
  const cfg = plan.cfg;
  for (const it of plan.items.filter((x) => x.promover)) {
    const fm = parseFrontmatter(it.contenido);
    const fallos = validateKit({ data: fm.data, hasFrontmatter: fm.hasFrontmatter }, cfg);
    if (fallos.length) throw new Error(`ficha inválida en ${it.origen}, no se ha escrito nada: ${fallos.join('; ')}`);
  }
  for (const it of plan.items) {
    if (it.promover) {
      if (!dentro(path.resolve(root), it.destino)) throw new Error(`destino fuera de la raíz: ${it.destino}`);
      asegurarDentro(rootReal, it.destino);
      const fm = parseFrontmatter(it.contenido);
      escribirNotaKit(root, { file: it.destino, content: it.contenido, body: fm.body, data: fm.data, hasFrontmatter: true }, cfg, hoy, it.destino);
      hechos.push(it);
      continue;
    }
    if (!dentro(path.resolve(root), it.destino)) throw new Error(`destino fuera de la raíz: ${it.destino}`);
    asegurarDentro(rootReal, it.destino);
    fs.mkdirSync(path.dirname(it.destino), { recursive: true });
    asegurarDentro(rootReal, it.destino);
    if (it.contenido === null) fs.copyFileSync(it.origenAbs, it.destino, fs.constants.COPYFILE_EXCL);
    else fs.writeFileSync(it.destino, it.contenido, { encoding: 'utf8', flag: 'wx' });
    hechos.push(it);
  }
  // registro
  const dirReg = path.join(root, 'registro');
  asegurarDentro(rootReal, path.join(dirReg, 'x'));
  fs.mkdirSync(dirReg, { recursive: true });
  asegurarDentro(rootReal, path.join(dirReg, 'x'));
  const nombre = `${hoy}-migrar-${slug(plan.nombreOrigen, 'origen')}`;
  let n = 1;
  let fichero;
  do { fichero = path.join(dirReg, `${nombre}${n === 1 ? '' : '-' + n}.md`); n++; } while (isLink(fichero));
  const celda = (t) => String(t).replace(/\|/g, '\\|');
  const filas = hechos.map((it) => `| ${celda(it.origenAbs ? posix(it.origenAbs) + (it.origen.includes(' §') ? ' ' + it.origen.split(' ').pop() : '') : it.origen)} | ${celda(posix(path.relative(root, it.destino)))} | ${it.tipo} | ${it.sha} | ${it.accion === 'adjunto' ? 'adjunto' : it.accion} |`);
  const texto = [
    '---', 'type: registro', `title: ${JSON.stringify(`Migración ${hoy}: ${plan.nombreOrigen}`)}`,
    `description: ${JSON.stringify(`Copia de «${plan.nombreOrigen}» (${plan.modo}) al cerebro: ${hechos.length} ficheros, origen intacto.`)}`,
    'status: draft', `actualizado: ${hoy}`, '---', '', `# Migración ${hoy}: ${plan.nombreOrigen}`, '',
    `Modo: \`${plan.modo}\`. Es una COPIA: el origen no se ha modificado ni borrado. El sha256 es el del fichero origen.`, '',
    'Estados: `borrador` (en memoria/borradores/, lo promueve el revisor), `directo` (ya en su carpeta), `adjunto` (copia literal en recursos/adjuntos/).', '',
    '| Origen | Destino (relativo al cerebro) | Tipo | sha256 | Estado |', '|---|---|---|---|---|', ...filas,
    ...(plan.ignorados.length ? ['', `Ignorados (${plan.ignorados.length}):`, '', ...plan.ignorados.map((i) => `* ${i.rel} — ${i.motivo}`)] : []), '',
  ].join('\n');
  fs.writeFileSync(fichero, texto, { encoding: 'utf8', flag: 'wx' });
  return { registro: fichero, hechos };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { flags: new Set(), valores: {} };
  const conValor = new Set(['--origen', '--tipo', '--root', '--hoy']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(0, eq) : a;
    if (conValor.has(k)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} necesita un valor`);
      out.valores[k.slice(2)] = v;
    } else if (['--dry-run', '--aplicar', '--sin-adjuntos', '-h', '--help'].includes(a)) out.flags.add(a);
    else throw new Error(`opción desconocida: ${a}`);
  }
  return out;
}

const USO = `Uso: node okf-migrar.mjs --origen <ruta> [--tipo libreta|carpeta|planes|auto] [--root <ruta>] --dry-run | --aplicar
  --dry-run        inventario (qué → dónde, tipo, avisos) sin escribir nada
  --aplicar        COPIA al cerebro (nunca borra ni toca el origen, nunca pisa un destino) y deja registro/
  --sin-adjuntos   no copia lo que no sea .md
  --hoy AAAA-MM-DD fecha a usar (por defecto, hoy)
Traduce memoria de otros sitios al formato MiCerebro: libreta Hermes (§), carpeta Markdown/Obsidian, planes.`;

function imprimirInventario(plan, root) {
  console.log(`Migración (${plan.modo}) de «${plan.nombreOrigen}» → ${root}`);
  console.log(`Ficheros a copiar: ${plan.items.length}  ·  ignorados: ${plan.ignorados.length}\n`);
  for (const it of plan.items) {
    console.log(`${it.accion.padEnd(8)} ${it.tipo.padEnd(10)} ${it.origen}  →  ${posix(path.relative(root, it.destino))}${it.nota ? `   (${it.nota})` : ''}`);
  }
  if (plan.conflictos) console.log(`\nConflictos de nombre resueltos con sufijo -2, -3…: ${plan.conflictos}`);
  if (plan.ignorados.length) {
    console.log(`\nIgnorados (${OCULTOS_IGNORADOS}, enlaces simbólicos):`);
    for (const i of plan.ignorados) console.log(`  - ${i.rel} — ${i.motivo}`);
  }
}

function main() {
  const { flags, valores } = parseArgs(process.argv.slice(2));
  if (flags.has('-h') || flags.has('--help')) { console.log(USO); return; }
  if (!valores.origen) throw new Error('falta --origen <ruta>');
  const dry = flags.has('--dry-run');
  const ap = flags.has('--aplicar');
  if (dry === ap) throw new Error('elige exactamente una acción: --dry-run (inventario) o --aplicar');
  const info = valores.root ? { root: path.resolve(valores.root), origen: 'flag' } : resolverRaiz();
  const root = info.root;
  if (ap) exigirCerebro(info);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`la raíz no existe: ${root}`);
  const hoy = valores.hoy || iso(new Date());
  if (!esFecha(hoy)) throw new Error('--hoy debe ser AAAA-MM-DD');
  const plan = planificar({ origen: valores.origen, tipo: valores.tipo || 'auto', root, hoy, adjuntos: !flags.has('--sin-adjuntos') });
  imprimirInventario(plan, root);
  if (dry) { console.log('\n--dry-run: no se ha escrito nada. Repite con --aplicar para copiar.'); return; }
  const r = aplicar(plan, root, hoy);
  const por = (a) => r.hechos.filter((h) => h.accion === a).length;
  console.log(`\nHecho: ${r.hechos.length} copiados (${por('borrador')} borradores, ${por('directo')} directos, ${por('adjunto')} adjuntos). Origen intacto.`);
  console.log(`Registro: ${posix(path.relative(root, r.registro))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`OKF migrar error: ${error.message}`);
    process.exitCode = 1;
  }
}
