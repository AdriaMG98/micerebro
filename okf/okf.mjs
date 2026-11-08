#!/usr/bin/env node
// okf — CLI determinista de recuperación/alta/limpieza de memoria curada (OKF).
// Cero dependencias externas: solo módulos internos de Node (fs, path, child_process, os).
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cargarConfig, resolverRaiz, exigirCerebro, fichaBorradorKit } from './okf-config.mjs';
import { guardarDirecto } from './okf-promover.mjs';

// Rutas, fuentes y tipos salen de la config activa (okf-config.mjs:
// preset `micerebro`, o lo que diga okf.config.json en la raíz).

// ── utilidades de texto ─────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','al','a','ante','bajo',
  'cabe','con','contra','desde','durante','en','entre','hacia','hasta','mediante',
  'para','por','segun','según','sin','so','sobre','tras','y','o','u','e','ni',
  'que','qué','como','cómo','cual','cuál','cuales','cuáles','quien','quién',
  'quienes','quiénes','donde','dónde','cuando','cuándo','cuanto','cuánto',
  'es','son','fue','era','sera','será','seran','serán','esta','está','estan',
  'están','hay','muy','mas','más','menos','tambien','también','tampoco','no','si',
  'sí','se','su','sus','le','les','lo','este','esta','estos','estas','ese','esa',
  'esos','esas','aquel','aquella','aquellos','aquellas','nos','mi','mis','tu','tus',
  'porque','pero','sino','aunque','yo','tu','el','ella','ellos','ellas','nosotros',
  'vosotros','ustedes','me','te','nuestro','nuestra','sus','han','ha','he','has',
  'hemos','habia','había','fueron','ser','estar','sido','siendo','hace','hacer',
  'haciendo','vez','ya','solo','sólo','todo','toda','todos','todas','otro','otra',
]);

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalize(s) {
  return stripAccents(String(s || '').toLowerCase());
}

function tokenize(s) {
  const norm = normalize(s);
  const raw = norm.split(/[^a-z0-9]+/).filter(Boolean);
  return raw.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ── frontmatter YAML-lite (sin dependencias) ────────────────────────────────
// Solo entiende lo que OKF necesita: claves de primer nivel `k: v` y un bloque
// anidado de un nivel (`type` dentro de `metadata:`).
function stripQuotes(s) {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: content, hasFrontmatter: false };
  const fmText = m[1];
  const body = content.slice(m[0].length);
  const lines = fmText.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      const key = top[1];
      const value = top[2].trim();
      if (value === '') {
        const nested = {};
        let j = i + 1;
        while (j < lines.length && /^\s+\S/.test(lines[j])) {
          const nm = lines[j].match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
          if (nm) nested[nm[1]] = stripQuotes(nm[2]);
          j++;
        }
        data[key] = nested;
        i = j;
        continue;
      }
      data[key] = stripQuotes(value);
    }
    i++;
  }
  return { data, body, hasFrontmatter: true };
}

function getType(data) {
  if (data.type) return data.type;
  if (data.metadata && data.metadata.type) return data.metadata.type;
  return null;
}

// Ficheros sin frontmatter (típicamente `planes/`) no tienen `description`:
// se deriva del primer párrafo real del cuerpo (sin cabeceras #), para que la
// puntuación tenga señal de contenido y no solo del nombre de fichero.
function pseudoDescription(body) {
  const lines = body.split(/\r?\n/);
  const paragraph = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^>/.test(trimmed)) continue; // citas/"prompt de arranque" boilerplate: no discrimina
    paragraph.push(trimmed);
  }
  return paragraph.join(' ').slice(0, 400);
}

// ── descubrimiento de índices y ficheros ────────────────────────────────────
// `excludeDirs` (opcional) suma exclusiones a las de por defecto (`node_modules`
// y cualquier nombre que empiece por `.`); no rompe llamadas existentes.
function listMdFiles(dir, depth = 4, excludeDirs = null) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const excl = excludeDirs instanceof Set ? excludeDirs : null;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules') continue;
    if (excl && excl.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out = out.concat(listMdFiles(p, depth - 1, excl));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

// Parsea líneas de índice: `- [nombre](fichero.md) — descripción` (formato
// 'guion') o `* [Título](ruta) - descripción` (formato 'estrella',
// el de MiCerebro).
function parseIndexLines(content, formato = 'guion') {
  const out = [];
  const re = formato === 'estrella' ? /^[*-]\s*\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/gm : /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(content))) {
    out.push({ label: m[1].trim(), link: m[2].trim(), desc: m[3].trim() });
  }
  return out;
}

// Construye el catálogo de candidatos (metadatos + contenido) a partir de las
// fuentes de la config (por defecto memoria/, planes/, proyectos/, areas/, recursos/).
// Leer estos ficheros es coste de disco del PROCESO, no tokens del modelo — el
// ahorro de tokens está en que solo el ganador se IMPRIME entero (ver cmdBuscar).
function buildCatalog(root, config) {
  const candidates = [];
  const byName = new Map();
  const seenPaths = new Set();

  function addCandidate(filePath, indexDesc, source) {
    filePath = path.resolve(filePath);
    let seenKey;
    try {
      seenKey = fs.realpathSync(filePath);
    } catch {
      seenKey = path.resolve(filePath);
    }
    if (seenPaths.has(seenKey)) return;
    if (!fs.existsSync(filePath)) return; // línea de índice muerta (la ve `caducados`)
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    const fm = parseFrontmatter(content);
    const name = fm.data[config.campoNombre] || path.basename(filePath, '.md');
    const body0 = fm.hasFrontmatter ? fm.body : content;
    const description = indexDesc || fm.data.description || pseudoDescription(body0);
    const type = getType(fm.data);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {}
    const cand = {
      path: filePath,
      name,
      description,
      type,
      source,
      content,
      body: fm.hasFrontmatter ? fm.body : content,
      actualizado: typeof fm.data.actualizado === 'string' ? fm.data.actualizado : null,
      fechaFrontmatter: typeof fm.data.date === 'string' ? fm.data.date : null,
      size: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
    };
    seenPaths.add(seenKey);
    candidates.push(cand);
    if (!byName.has(name)) byName.set(name, cand);
  }

  // Cada fuente de la config: índice (si lo hay) manda las descripciones; se
  // completa con lo que haya suelto en el directorio y no esté listado.
  const indiceCache = new Map();
  const descripcionesDe = (dir, fuente) => {
    if (indiceCache.has(dir)) return indiceCache.get(dir);
    const mapa = new Map();
    const indice = path.join(dir, fuente.indiceFile);
    if (fs.existsSync(indice)) {
      for (const { link, desc } of parseIndexLines(fs.readFileSync(indice, 'utf8'), fuente.indiceFormato)) {
        const destino = path.resolve(dir, link);
        if (config.confinar && path.relative(config.root, destino).startsWith('..')) continue;
        mapa.set(destino, desc);
      }
    }
    indiceCache.set(dir, mapa);
    return mapa;
  };

  for (const fuente of config.fuentes) {
    const { source } = fuente;
    if (fuente.archivo) {
      if (fs.existsSync(fuente.archivo)) addCandidate(fuente.archivo, null, source);
      continue;
    }
    const dir = fuente.dir;
    if (fuente.indiceFile && !fuente.indicePorCarpeta && fs.existsSync(path.join(dir, fuente.indiceFile))) {
      for (const [file, desc] of descripcionesDe(dir, fuente)) addCandidate(file, desc, source);
    }
    if (fuente.soloIndice) continue;
    if (!fs.existsSync(dir)) continue;
    const excl = fuente.exclude && fuente.exclude.length ? new Set(fuente.exclude) : null;
    const ignorar = new Set((fuente.ignorarFicheros || []).map((n) => n.toLowerCase()));
    for (const f of listMdFiles(dir, fuente.depth, excl)) {
      const base = path.basename(f);
      if (fuente.indiceFile && !fuente.indicePorCarpeta && base === fuente.indiceFile) continue;
      if (ignorar.has(base.toLowerCase())) continue;
      if (fuente.contiene && !f.includes(fuente.contiene)) continue;
      const desc = fuente.indiceFile && fuente.indicePorCarpeta ? descripcionesDe(path.dirname(f), fuente).get(path.resolve(f)) || null : null;
      addCandidate(f, desc, source);
    }
  }

  return { candidates, byName };
}

// ── puntuación ───────────────────────────────────────────────────────────
// `type` pondera (pesos en la config: pesosTipo): una pregunta técnica interesa más en project/reference que
// en feedback/user (decisión de diseño).
// Los ficheros SIN frontmatter (que no llevan `type` propio)
// llevan penalización extra: son bitácoras de trabajo sin curar, no memoria
// deliberadamente indexada — si empatan con algo curado, gana lo curado.
const TYPE_WEIGHT_UNDECLARED = 0.5;

// Tres ajustes de ranking.

// (1) Suavizado de la penalización de tipo/sin-frontmatter: si un candidato sin
// `type` declarado tiene una ventaja léxica BRUTA (sin ponderar) muy clara sobre
// el mejor candidato CURADO (con `type` declarado), la penalización de 0.5× no
// debe bastar para invertir el ranking — pasaba con 9 aciertos
// brutos contra 6 del ganador, y aun así perdía por el peso. El umbral 1.5×
// conserva la intención original (preferir lo curado en empates o ventajas
// pequeñas) sin tumbar victorias claras.
const SUAVIZADO_RATIO = 1.5;

// (2) Penalización aparte y agresiva para `planes/_archivo/` — es un problema
// distinto al de "sin frontmatter": es un desván, no memoria viva. Se aplica SIEMPRE, incluso si el candidato se benefició
// del suavizado anterior (evita que un archivado con mucho ruido léxico gane
// por partida doble, .
const ARCHIVE_DIR_MARKER = `${path.sep}_archivo${path.sep}`;
const ARCHIVE_WEIGHT = 0.12;

// (3) Segunda pasada sobre el CUERPO para desempatar: solo se abre (ya está en
// memoria, ver buildCatalog) el top-N del ranking por descripción, y se suma un
// punto por cada palabra clave de la pregunta que aparezca literalmente en el
// cuerpo — peso menor (2) que el acierto exacto de descripción (3), para que
// desempate sin poder por sí solo tumbar una ventaja de descripción grande.
// Caso típico: la respuesta vivía en el CUERPO del ganador legítimo pero invisible
// porque antes solo se puntuaba `name + description`.
const BODY_PASS_N = 8;
const BODY_HIT_WEIGHT = 2;

function isArchivado(filePath) {
  return filePath.includes(ARCHIVE_DIR_MARKER);
}

// Cualquier segmento `/borradores/` en la ruta marca la nota como
// fuera-del-ranking por defecto.
function isBorrador(filePath) {
  return filePath.includes('/borradores/');
}

function isExcludedByDefault(filePath) {
  return isArchivado(filePath) || isBorrador(filePath);
}

function scoreText(tokens, queryTokens) {
  const set = new Set(tokens);
  let score = 0;
  for (const qt of queryTokens) {
    if (set.has(qt)) {
      score += 3;
      continue;
    }
    for (const t of set) {
      if (t.length >= 4 && qt.length >= 4 && (t.includes(qt) || qt.includes(t))) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

// Puntúa TODO el catálogo contra la pregunta: pasada 1 (descripción, con
// suavizado de tipo + penalización de `_archivo/`) y pasada 2 (cuerpo, solo
// para el top-N de la pasada 1). Devuelve un array plano con el detalle de
// cada componente — el `--debug` lo usa para auditar.
function scoreCandidates(candidates, queryTokens, excludeFn = null, TYPE_WEIGHT = {}) {
  const withBase = candidates.map((c) => ({
    c,
    base: scoreText(tokenize(c.name + ' ' + c.description), queryTokens),
  }));

  // mejor puntuación bruta entre los candidatos CON `type` declarado (memoria
  // curada real): referencia para decidir si un `planes/` sin frontmatter tiene
  // tanta ventaja léxica que no debería perder solo por el peso de tipo.
  let bestCuratedBase = 0;
  for (const { c, base } of withBase) {
    if (TYPE_WEIGHT[c.type] && base > bestCuratedBase) bestCuratedBase = base;
  }

  const withDesc = withBase.map(({ c, base }) => {
    let w = TYPE_WEIGHT[c.type];
    let suavizado = false;
    if (!w) {
      if (base > 0 && base >= bestCuratedBase * SUAVIZADO_RATIO) {
        w = 1;
        suavizado = true;
      } else {
        w = TYPE_WEIGHT_UNDECLARED;
      }
    }
    if (isArchivado(c.path)) w *= ARCHIVE_WEIGHT;
    return { c, base, descScore: base * w, suavizado };
  });

  // Los excluidos por defecto (borradores/_archivo sin --todo) no ocupan
  // plaza en el pool de la pasada de cuerpo: si no, ocho borradores bien
  // puntuados por descripción pueden robarle los bodyHits a una nota viva.
  const byDesc = [...withDesc].sort((a, b) => b.descScore - a.descScore);
  const poolSource = excludeFn ? byDesc.filter((x) => !excludeFn(x.c.path)) : byDesc;
  const pool = new Set(poolSource.slice(0, BODY_PASS_N).map((x) => x.c));

  return withDesc.map((x) => {
    let bodyHits = 0;
    if (pool.has(x.c)) {
      const normBody = normalize(x.c.body);
      for (const qt of queryTokens) {
        if (qt.length >= 3 && normBody.includes(qt)) bodyHits++;
      }
    }
    const score = x.descScore + bodyHits * BODY_HIT_WEIGHT;
    return { c: x.c, base: x.base, descScore: x.descScore, suavizado: x.suavizado, bodyHits, score };
  });
}

// ── secciones ──────────────────────────────────────────────────────────
function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { title: null, lines: [] };
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      sections.push(current);
      current = { title: h[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((s) => s.title || s.lines.join('\n').trim() !== '');
}

function bestSection(cand, queryTokens) {
  const sections = splitSections(cand.body);
  if (sections.length <= 1) {
    return { title: null, text: cand.body.trim() };
  }
  let best = null;
  let bestScore = -1;
  for (const s of sections) {
    const text = s.lines.join('\n').trim();
    const tokens = tokenize((s.title || '') + ' ' + text);
    const sc = scoreText(tokens, queryTokens);
    if (sc > bestScore) {
      bestScore = sc;
      best = { title: s.title, text };
    }
  }
  return best;
}

function findLink(text) {
  const m = text.match(/\[\[([^\]]+)\]\]/);
  return m ? m[1].trim() : null;
}

// ── comando: buscar ────────────────────────────────────────────────────
function cmdBuscar(root, config, query, debug, includeAll) {
  let { candidates } = buildCatalog(root, config);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    console.log('OKF: la pregunta no dejó ninguna palabra clave tras quitar vacías.');
    return;
  }

  // Scoring sobre TODO el catálogo: así el `ARCHIVE_WEIGHT` se aplica igual
  // cuando el usuario usa --todo (comportamiento previo intacto), y además
  // podemos contar cuántos excluidos con acierto había para el aviso.
  const allScored = scoreCandidates(candidates, queryTokens, includeAll ? null : isExcludedByDefault, config.pesosTipo);

  // Por defecto se excluyen del ranking los ficheros en `borradores/` o
  // `_archivo/`. Con --todo se reincorporan y siguen llevando su peso normal
  // (incluido el ARCHIVE_WEIGHT para los de _archivo/).
  const excludedHits = [];
  const ranked = [];
  for (const x of allScored) {
    if (x.score > 0 && isExcludedByDefault(x.c.path) && !includeAll) {
      excludedHits.push(x);
    } else {
      ranked.push(x);
    }
  }

  // Desempate por señal léxica antes que por recencia: score → descScore →
  // bodyHits → mtimeMs → nombre. `bodyHits` solo discrimina dentro del top-N
  // de la pasada 1 (ver scoreCandidates), así que fuera de ahí es 0/0.
  const scored = ranked
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.descScore - a.descScore ||
        b.bodyHits - a.bodyHits ||
        b.c.mtimeMs - a.c.mtimeMs ||
        a.c.name.localeCompare(b.c.name)
    );

  if (debug) {
    console.error(`[debug] palabras clave: ${queryTokens.join(', ')}`);
    for (const x of scored.slice(0, 10)) {
      const marcas = [x.suavizado ? 'suavizado' : null, isArchivado(x.c.path) ? 'archivo' : null]
        .filter(Boolean)
        .join(',');
      console.error(
        `[debug] ${x.score.toFixed(2)}  ${x.c.name}  (${x.c.source}/${x.c.type || '-'})` +
          `  [desc=${x.descScore.toFixed(2)} cuerpo=+${(x.bodyHits * BODY_HIT_WEIGHT).toFixed(2)}(${x.bodyHits})${marcas ? ' ' + marcas : ''}]`
      );
    }
  }

  const totalCandidateBytes = candidates.reduce((sum, c) => sum + c.size, 0);

  if (scored.length === 0) {
    let msg =
      `OKF: 0 aciertos entre ${candidates.length} candidatos (palabras: ${queryTokens.join(', ')}). ` +
      `Nada que abrir — revisa el índice a mano o reformula.`;
    if (excludedHits.length > 0) {
      msg +=
        `\n(${excludedHits.length} resultados en borradores/_archivo excluidos; repite con --todo para verlos)`;
    }
    console.log(msg);
    return;
  }

  const winner = scored[0].c;
  const section = bestSection(winner, queryTokens);
  let readBytes = Buffer.byteLength(section.text, 'utf8');

  const lines = [];
  const linkName = findLink(section.text);
  let linked = null;
  if (linkName) {
    // Resolución por frontmatter `name`, no por ruta.
    const target = candidates.find((c) => normalize(c.name) === normalize(linkName));
    if (target && target.path !== winner.path) {
      const linkedSection = bestSection(target, queryTokens);
      linked = { cand: target, section: linkedSection };
      readBytes += Buffer.byteLength(linkedSection.text, 'utf8');
    }
  }

  const discardedBytes = Math.max(totalCandidateBytes - readBytes, 0);

  // Puestos 2 y 3 (compactos, sin cuerpo): ahorra presupuesto de lectura.
  // Se calcula aquí para que el header pueda mencionarlos solo si los hay.
  const alts = scored.slice(1, 3).filter((x) => x.score > 0);
  let header =
    `OKF: leídos ~${readBytes} caracteres (1 sección${linked ? ' + 1 enlace seguido' : ''} de 1 fichero) ` +
    `de ${scored.length}/${candidates.length} candidatos con acierto · descartados ~${discardedBytes} caracteres sin abrir`;
  if (alts.length > 0) {
    const plural = alts.length > 1 ? 's' : '';
    header += ` · ${alts.length} alternativa${plural} listada${plural}`;
  }

  lines.push(header, '');
  lines.push(`Fichero: ${path.relative(root, winner.path)}  (source: ${winner.source}, type: ${winner.type || 'sin declarar'})`);
  lines.push(`Sección: ${section.title ? '## ' + section.title : '(documento completo, sin secciones ##)'}`);
  lines.push('');
  lines.push(section.text);

  if (linked) {
    lines.push('');
    lines.push(`--- enlace seguido: [[${linkName}]] → ${path.relative(root, linked.cand.path)} ---`);
    lines.push(linked.section.title ? '## ' + linked.section.title : '(documento completo)');
    lines.push('');
    lines.push(linked.section.text);
  } else if (linkName) {
    lines.push('');
    lines.push(`(nota: la sección enlaza [[${linkName}]] pero no se encontró ningún fichero con ese \`name\`)`);
  }

  if (alts.length > 0) {
    lines.push('');
    lines.push('También relevantes (abrir con okf_leer si hace falta):');
    alts.forEach((x, i) => {
      const num = i + 2;
      const relPath = path.relative(root, x.c.path);
      const descFull = String(x.c.description || '').replace(/\s+/g, ' ').trim();
      const desc = descFull.slice(0, 140);
      const tipo = x.c.type || 'sin declarar';
      const sufijo = descFull.length > 140 ? '…' : '';
      lines.push(`  ${num}. ${relPath} (${x.c.source}/${tipo}) — ${desc}${sufijo}`);
    });
  }

  console.log(lines.join('\n'));
}

// ── comando: guardar ────────────────────────────────────────────────────
function slugify(title) {
  let s = stripAccents(String(title).toLowerCase());
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return s || 'nota';
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.okf-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath); // rename es atómico en el mismo filesystem
}

function appendIndexLine(indexPath, line) {
  const content = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '# Índice\n\n';
  const eol = content.split(/\r?\n/);
  let lastBullet = -1;
  for (let i = 0; i < eol.length; i++) {
    if (/^-\s*\[/.test(eol[i])) lastBullet = i;
  }
  let newLines;
  if (lastBullet >= 0) {
    newLines = [...eol.slice(0, lastBullet + 1), line, ...eol.slice(lastBullet + 1)];
  } else {
    // no había bullets todavía: añade el primero al final del fichero.
    while (newLines_end(eol) === '') eol.pop();
    newLines = [...eol, '', line];
  }
  function newLines_end(arr) {
    return arr.length ? arr[arr.length - 1] : null;
  }
  const finalContent = newLines.join('\n').replace(/\n{3,}$/, '\n\n');
  atomicWrite(indexPath, finalContent.endsWith('\n') ? finalContent : finalContent + '\n');
}

function cmdGuardar(root, config, argv) {
  let tipo = argv._[0];
  let titulo = argv._[1];
  // Con tipo por defecto en la config, un solo argumento es el título.
  if (config.tipoDefecto && argv._.length === 1) {
    titulo = argv._[0];
    tipo = config.tipoDefecto;
  }
  if (!tipo || !titulo) {
    throw new Error(`uso: okf guardar ${config.tipoDefecto ? '[tipo] ' : '<tipo> '}"titulo" --body -   (tipo: ${config.tipos.join('|')})`);
  }
  if (!config.tiposSet.has(tipo)) {
    throw new Error(`tipo inválido "${tipo}" — válidos: ${config.tipos.join(', ')}`);
  }
  if (argv.body === undefined) {
    throw new Error('falta --body ( "-" para leer stdin, o un texto literal )');
  }
  let body;
  if (argv.body === '-') {
    body = fs.readFileSync(0, 'utf8');
  } else {
    body = String(argv.body);
  }
  body = body.replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('el body está vacío');

  if (config.guardar.modo === 'directo') {
    // Kit sin revisor: misma validación y misma escritura que la promoción (okf-promover).
    const fichero = guardarDirecto(root, config, { tipo, titulo, cuerpo: body, fecha: new Date().toISOString().slice(0, 10) });
    console.log(`OKF: guardado ${path.relative(root, fichero)} (${fichero})`);
    return;
  }

  if (config.guardar.modo === 'borrador') {
    // Kit: la nota nace borrador con ficha completa; los índices los toca el revisor.
    const dirB = config.borradoresDir;
    let slug = slugify(titulo);
    let n = 2;
    while (fs.existsSync(path.join(dirB, `${slug}.md`))) {
      slug = `${slugify(titulo)}-${n}`;
      n++;
    }
    const fichero = path.join(dirB, `${slug}.md`);
    atomicWrite(fichero, fichaBorradorKit({ tipo, titulo, cuerpo: body, fecha: new Date().toISOString().slice(0, 10) }));
    console.log(`OKF: borrador guardado ${path.relative(root, fichero)}`);
    return;
  }

  const destinos = config.guardar.destinos;
  const destino = argv.destino || config.guardar.defecto;
  if (!Object.hasOwn(destinos, destino)) {
    throw new Error(`--destino inválido — válidos: ${Object.keys(destinos).join(' | ')}`);
  }

  const dir = destinos[destino].dir;
  const indexPath = path.join(dir, destinos[destino].indice);

  // unicidad del name en kebab-case dentro del directorio destino
  let slug = slugify(titulo);
  let n = 2;
  while (fs.existsSync(path.join(dir, `${slug}.md`))) {
    slug = `${slugify(titulo)}-${n}`;
    n++;
  }
  const targetFile = path.join(dir, `${slug}.md`);

  const firstBodyLine = body.split('\n').find((l) => l.trim() !== '') || titulo;
  const description = firstBodyLine.trim().slice(0, 220);

  // description SIEMPRE entrecomillada: un «:» suelto la vuelve YAML inválido
  // y herramientas posteriores pueden saltar la nota entera en silencio.
  const frontmatter = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\ntype: ${tipo}\n---\n\n${body}\n`;
  const indexLine = `- [${slug}](${slug}.md) — ${description}`;

  // Alta atómica: 1) escribir el fichero (tmp+rename, todo o nada);
  // 2) escribir el índice (tmp+rename, todo o nada); si (2) falla tras
  // haber hecho (1), se hace ROLLBACK borrando el fichero recién creado,
  // de forma que nunca queda un fichero sin su línea de índice.
  atomicWrite(targetFile, frontmatter);
  try {
    appendIndexLine(indexPath, indexLine);
  } catch (e) {
    try {
      fs.unlinkSync(targetFile);
    } catch {}
    throw new Error(`fallo al actualizar el índice, se deshizo el fichero creado (rollback): ${e.message}`);
  }

  console.log(`OKF: guardado ${path.relative(root, targetFile)}`);
  console.log(`OKF: índice actualizado ${path.relative(root, indexPath)}`);
}

// ── comando: caducados ──────────────────────────────────────────────────
function findGitRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Fecha de frontmatter (`actualizado` gana a `date`): es la única señal de
// "contenido revisado", a diferencia de git log/mtime que solo dicen "fichero
// tocado" — una mudanza de carpetas (mv masivo, un solo commit) resetea el git
// log de CADA fichero del corpus sin que su contenido haya cambiado de verdad
// (una mudanza de carpetas produce cientos de falsos positivos de un golpe).
function parseIsoDateLite(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function lastGitDate(filePath) {
  const gitRoot = findGitRoot(path.dirname(filePath));
  if (!gitRoot) return null;
  try {
    const rel = path.relative(gitRoot, filePath);
    const out = execFileSync('git', ['-C', gitRoot, 'log', '-1', '--format=%cI', '--', rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? new Date(out) : null;
  } catch {
    return null;
  }
}

// Enmascara código inline (`...`) y bloques vallados (```...```) sustituyendo
// su contenido por espacios, preservando saltos de línea y longitud para no
// desplazar offsets. Evita que sintaxis de código (p.ej. `[[ -eq ]]` de bash,
// o un wikilink de ejemplo en la documentación) se lea como wikilink real.
function maskCode(body) {
  // 1) bloques vallados ```...``` (con o sin lenguaje), no ávidos, multilinea.
  let masked = body.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '));
  // 2) código inline `...` (una sola línea, sin backtick dentro).
  masked = masked.replace(/`[^`\n]*`/g, (span) => span.replace(/[^\n]/g, ' '));
  return masked;
}

function cmdCaducados(root, config) {
  const TTL_DIAS = 30;
  const { candidates, byName } = buildCatalog(root, config);
  const memorias = candidates.filter((c) => config.caducables.includes(c.source));

  const partes = [];
  let viejos = 0;
  let rotos = 0;

  for (const c of memorias) {
    let stat;
    try {
      stat = fs.statSync(c.path);
    } catch {
      // Carrera con el revisor okf: el fichero desapareció entre buildCatalog
      // y este stat (renombrado/borrado por una variante -N de okf_guardar).
      // El stat solo es fallback de mtime (la fecha ya sale de frontmatter/git),
      // así que saltamos este candidato en vez de tumbar el comando entero.
      continue;
    }
    const fmDate = parseIsoDateLite(c.actualizado) || parseIsoDateLite(c.fechaFrontmatter);
    const gitDate = lastGitDate(c.path);
    const lastDate = fmDate || (gitDate && gitDate > new Date(0) ? gitDate : stat.mtime);
    const fuente = fmDate ? 'frontmatter' : gitDate ? 'git' : 'mtime';
    const diasDesde = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
    if (diasDesde > TTL_DIAS) {
      viejos++;
      partes.push(
        `[>${TTL_DIAS} días] ${path.relative(root, c.path)} — última señal (${fuente}): ${lastDate.toISOString().slice(0, 10)} — hace ${diasDesde} días`
      );
    }

    const linkRe = /\[\[([^\]]+)\]\]/g;
    const bodySinCodigo = maskCode(c.body);
    let m;
    while ((m = linkRe.exec(bodySinCodigo))) {
      const target = m[1].trim();
      const found = [...byName.keys()].some((n) => normalize(n) === normalize(target));
      if (!found) {
        rotos++;
        partes.push(`[enlace roto] ${path.relative(root, c.path)} — apunta a [[${target}]], que no existe`);
      }
    }
  }

  console.log(`OKF caducados — política TTL ${TTL_DIAS} días (NO borra, solo lista)\n`);
  if (partes.length === 0) {
    console.log('Nada caducado ni roto: todo el contexto curado + memoria automática está dentro del TTL y sin enlaces muertos.');
  } else {
    console.log(partes.join('\n'));
  }
  console.log(`\nTotal: ${viejos} ficheros >${TTL_DIAS} días, ${rotos} enlaces rotos, de ${memorias.length} revisados.`);
}

// ── comando: curar --candidatos ──────────────────────────────────────────
// Solo lee y solo código (sin LLM): lista notas curadas (no borradores, no archivo/) a revisar.
//   duplicada      títulos o descripciones casi iguales: similitud de Jaccard >= UMBRAL_SIMILITUD
//                  sobre tokens normalizados (minúsculas, sin tildes, sin stopwords, >= 2 letras),
//                  con al menos 2 tokens en cada lado.
//   contradiccion  el mismo par, pero con `actualizado` distinto en ambas: mismo tema, fechas
//                  distintas, así que una de las dos puede estar desfasada.
//   caducada       `actualizado` de hace más de DIAS_CADUCADA días (sin `actualizado`, no se juzga).
//   enlace-roto    enlace Markdown relativo [x](ruta.md) a un fichero que no existe, o wikilink
//                  [[nombre]] sin nota con ese nombre (el código y los bloques vallados no cuentan).
const UMBRAL_SIMILITUD = 0.7;
const DIAS_CADUCADA = 180;

function jaccard(a, b) {
  if (a.size < 2 || b.size < 2) return 0;
  let comun = 0;
  for (const t of a) if (b.has(t)) comun++;
  return comun / (a.size + b.size - comun);
}

function candidatosCurar(root, config) {
  const { candidates, byName } = buildCatalog(root, config);
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const notas = candidates.filter((c) => !isExcludedByDefault(c.path) && !rel(c.path).split('/').includes('archivo'));
  const res = [];

  // (a) duplicadas y (b) contradicciones
  const fm = notas.map((c) => ({ c, titulo: new Set(tokenize(c.name)), desc: new Set(tokenize(c.description)), fecha: parseIsoDateLite(c.actualizado) }));
  for (let i = 0; i < fm.length; i++) {
    for (let j = i + 1; j < fm.length; j++) {
      const a = fm[i];
      const b = fm[j];
      const sT = jaccard(a.titulo, b.titulo);
      const sD = jaccard(a.desc, b.desc);
      const sim = Math.max(sT, sD);
      if (sim < UMBRAL_SIMILITUD) continue;
      const donde = sT >= sD ? 'títulos' : 'descripciones';
      const distintas = a.fecha && b.fecha && a.fecha.getTime() !== b.fecha.getTime();
      res.push({
        tipo: distintas ? 'contradiccion' : 'duplicada',
        notas: [rel(a.c.path), rel(b.c.path)],
        motivo: distintas
          ? `${donde} casi iguales (similitud ${sim.toFixed(2)}) con actualizado distinto (${a.c.actualizado} / ${b.c.actualizado}): posible contradicción o versión desfasada`
          : `${donde} casi iguales (similitud ${sim.toFixed(2)}): posible duplicada`,
      });
    }
  }

  // (c) caducadas y (d) enlaces rotos
  const ahora = Date.now();
  const nombres = new Set([...byName.keys()].map((n) => normalize(n)));
  for (const { c, fecha } of fm) {
    if (fecha) {
      const dias = Math.floor((ahora - fecha.getTime()) / 86400000);
      if (dias > DIAS_CADUCADA) res.push({ tipo: 'caducada', notas: [rel(c.path)], motivo: `actualizado ${c.actualizado}, hace ${dias} días (límite ${DIAS_CADUCADA})` });
    }
    const cuerpo = maskCode(c.body);
    const visto = new Set();
    for (const m of cuerpo.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const destino = m[1].split('#')[0].split('?')[0];
      if (!destino || !/\.md$/i.test(destino) || /^[a-z][a-z0-9+.-]*:/i.test(destino) || destino.startsWith('/')) continue;
      let decodificado = destino;
      try { decodificado = decodeURI(destino); } catch {}
      if (visto.has(decodificado)) continue;
      visto.add(decodificado);
      if (!fs.existsSync(path.resolve(path.dirname(c.path), decodificado))) {
        res.push({ tipo: 'enlace-roto', notas: [rel(c.path)], motivo: `enlace a ${destino}, que no existe` });
      }
    }
    for (const m of cuerpo.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g)) {
      const objetivo = m[1].trim();
      if (visto.has(`[[${objetivo}]]`)) continue;
      visto.add(`[[${objetivo}]]`);
      if (!nombres.has(normalize(objetivo))) res.push({ tipo: 'enlace-roto', notas: [rel(c.path)], motivo: `wikilink [[${objetivo}]] sin nota con ese nombre` });
    }
  }
  return res;
}

function cmdCurar(root, config, argv) {
  if (!argv.candidatos) throw new Error('uso: okf curar --candidatos [--json]   (solo lista; no escribe nada)');
  const lista = candidatosCurar(root, config);
  if (argv.json) {
    console.log(JSON.stringify(lista, null, 2));
    return;
  }
  console.log(`OKF curar — candidatos a revisar (similitud >= ${UMBRAL_SIMILITUD}, caducada > ${DIAS_CADUCADA} días; NO escribe, solo lista)\n`);
  if (!lista.length) {
    console.log('Nada que revisar.');
    return;
  }
  for (const r of lista) console.log(`[${r.tipo}] ${r.notas.join('  <->  ')}\n    ${r.motivo}`);
  const por = (t) => lista.filter((r) => r.tipo === t).length;
  console.log(`\nTotal: ${por('duplicada')} duplicadas, ${por('contradiccion')} contradicciones, ${por('caducada')} caducadas, ${por('enlace-roto')} enlaces rotos.`);
}

// ── arg parsing mínimo ──────────────────────────────────────────────────
const BOOL_FLAGS = new Set(['todo', 'debug', 'dry-run', 'candidatos', 'json']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        // Flags booleanos conocidos: nunca consumen el argumento siguiente
        // (si no, `buscar --todo "pregunta"` se tragaría la pregunta).
        if (BOOL_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
          out[key] = true;
        } else {
          out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function main() {
  const argv = parseArgs(process.argv.slice(2));
  const sub = argv._.shift();
  const info = argv.root ? { root: path.resolve(argv.root), origen: 'flag' } : resolverRaiz();
  const root = info.root;
  let config;
  try {
    config = cargarConfig(root);
  } catch (e) {
    console.error(`OKF error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (!sub || sub === '-h' || sub === '--help') {
    console.log(
      [
        'okf — CLI determinista de memoria curada (OKF)',
        '',
        '  okf buscar "pregunta" [--todo] [--debug]',
        `  okf guardar ${config.tipoDefecto ? '[tipo] ' : ''}<${config.tipos.join('|')}> "titulo" --body -${Object.keys(config.guardar.destinos).length ? ` [--destino ${Object.keys(config.guardar.destinos).join('|')}]` : ''}`,
        '  okf caducados',
        '  okf curar --candidatos [--json]   (duplicadas, contradicciones, caducadas, enlaces rotos; solo lista)',
        '',
        `raíz actual: ${root}  (preset: ${config.preset})  (override: --root <ruta> u OKF_ROOT)`,
      ].join('\n')
    );
    return;
  }

  try {
    if (sub === 'buscar') {
      const query = argv._.join(' ');
      if (!query) throw new Error('uso: okf buscar "pregunta"');
      cmdBuscar(root, config, query, Boolean(argv.debug), Boolean(argv.todo));
    } else if (sub === 'guardar') {
      exigirCerebro(info);
      cmdGuardar(root, config, argv);
    } else if (sub === 'caducados') {
      cmdCaducados(root, config);
    } else if (sub === 'curar') {
      cmdCurar(root, config, argv);
    } else {
      throw new Error(`subcomando desconocido: ${sub}`);
    }
  } catch (e) {
    console.error(`OKF error: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
