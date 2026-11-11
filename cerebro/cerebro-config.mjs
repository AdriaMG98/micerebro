// cerebro-config — rutas, fuentes y tipos de MiCerebro, configurables por raíz.
// Cero dependencias. Un preset (`micerebro`, la estructura del kit) y un
// `cerebro.config.json` opcional en la raíz que elige preset y sobrescribe campos:
//
//   { "preset": "micerebro", "tipos": ["nota", "decision"], "tipoDefecto": "nota" }
//
// Cualquier campo del preset se puede sustituir (fuentes, tipos, rutas del revisor…):
// así una estructura de carpetas distinta no necesita tocar el código. Ver README.
'use strict';

import fs from 'node:fs';
import path from 'node:path';

export const FICHERO_CONFIG = 'cerebro.config.json';

// Raíz por defecto: CEREBRO_ROOT; si no, el ancestro del cwd (él incluido) que trae
// cerebro.config.json; si no, el cwd. NUNCA se deriva de dónde está este fichero:
// el código puede vivir en cualquier sitio (o dentro de otro repo) y la raíz de
// la memoria es la de quien lo invoca. (--root manda sobre todo esto, en los llamadores.)
export function defaultRoot() {
  return resolverRaiz().root;
}

// Como defaultRoot, pero dice de dónde salió: 'env' (CEREBRO_ROOT), 'config' (cerebro.config.json
// subiendo desde el cwd) o 'cwd' (último recurso: sin pista alguna de dónde está el cerebro).
export function resolverRaiz() {
  if (process.env.CEREBRO_ROOT) return { root: path.resolve(process.env.CEREBRO_ROOT), origen: 'env' };
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, FICHERO_CONFIG))) return { root: d, origen: 'config' };
    const padre = path.dirname(d);
    if (padre === d) break;
    d = padre;
  }
  return { root: process.cwd(), origen: 'cwd' };
}

// Las operaciones que escriben se niegan si la raíz salió del último recurso: crearían
// `memoria/borradores/` en un cwd cualquiera y dirían «guardado» (fallo silencioso).
// `explicita`: la raíz vino de --root. Lanza un Error claro; sin él, la raíz es válida.
export function exigirCerebro({ root, origen }, explicita = false) {
  if (explicita || origen !== 'cwd') return;
  throw new Error(`no encuentro tu cerebro: falta ${FICHERO_CONFIG} en ${root} ni en ninguna carpeta superior; define CEREBRO_ROOT o usa --root`);
}

// Directorios que ningún walker debe recorrer: código compilado, dependencias
// y salidas de herramientas. El walker ya salta lo que empieza por `.`.
const WALK_SKIP = ['dist', 'graphify-out', 'web', 'node_modules', 'raw'];

// Forma de una fuente (todas las rutas relativas a la raíz, salvo que ya sean absolutas):
//   dir | archivo   directorio a recorrer, o un fichero único
//   source          etiqueta que ve el ranking y la salida
//   depth           profundidad del recorrido
//   indiceFile      fichero índice (descripciones); indiceFormato: 'guion' (`- [t](r) — d`) | 'estrella' (`* [t](r) - d`)
//   indicePorCarpeta  true: cada carpeta recorrida puede traer su índice
//   soloIndice      true: solo lo que liste el índice, sin recorrer
//   exclude         nombres de carpeta a saltar
//   ignorarFicheros nombres de fichero (minúsculas) a saltar
//   contiene        subcadena obligatoria en la ruta del fichero
function presetMiCerebro() {
  const comunes = { exclude: ['00-bandeja', 'archivo', 'registro', 'plantillas', 'node_modules'], indiceFile: 'index.md', indiceFormato: 'estrella', indicePorCarpeta: true, ignorarFicheros: ['index.md', 'log.md'] };
  const dirs = ['memoria', 'planes', 'proyectos', 'areas', 'recursos'];
  return {
    preset: 'micerebro',
    campoNombre: 'title',
    tipos: ['proyecto', 'area', 'recurso', 'nota', 'decision', 'aprendizaje', 'plan', 'persona', 'ficha-externa', 'registro', 'skill'],
    tipoDefecto: 'nota',
    pesosTipo: { proyecto: 1.15, area: 1.1, recurso: 1.15, decision: 1.15, aprendizaje: 1.15, plan: 1.0, nota: 1.0, persona: 1.0, skill: 1.0, 'ficha-externa': 0.9, registro: 0.85 },
    borradoresDir: 'memoria/borradores',
    caducables: ['memoria', 'proyectos', 'areas', 'recursos'],
    fuentes: dirs.map((d) => ({ dir: d, depth: 5, source: d, ...comunes })),
    // modo: 'directo' (la nota nace promovida: ficha validada, carpeta de su type, index.md y log.md; sin revisor),
    // 'borrador' (memoria/borradores/, la promueve cerebro-revisor) o 'indice' (destinos propios con índice).
    guardar: { modo: 'directo', defecto: null, destinos: {} },
    leer: { dirs, ignorarFicheros: ['index.md', 'log.md'] },
    // cerebro-revisor: mueve cada borrador a la carpeta de su type,
    // añade su línea al index.md de esa carpeta y una entrada `* **Creación**` al log.md de la raíz.
    // `datados`: los types cuyo fichero lleva el prefijo AAAA-MM-DD-. Los dudosos solo salen por consola.
    revisor: {
      destinos: { decision: 'memoria/decisiones', aprendizaje: 'memoria/aprendizajes', persona: 'memoria/personas' },
      datados: ['decision', 'aprendizaje'],
      carpetaDefecto: 'memoria',
      log: 'log.md',
      rutasSincronizadas: ['memoria', 'log.md'],
    },
  };
}

const PRESETS = { micerebro: presetMiCerebro };

function absolutiza(root, p) {
  return path.resolve(root, p);
}

const esObjeto = (v) => v && typeof v === 'object' && !Array.isArray(v);
const esListaTexto = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Las rutas del JSON del usuario deben quedar dentro de la raíz.
function validarUsuario(root, u) {
  const dentro = (campo, p) => {
    if (typeof p !== 'string' || !p) throw new Error(`${FICHERO_CONFIG}: ${campo} debe ser una ruta de texto`);
    const rel = path.relative(root, path.resolve(root, p));
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error(`${FICHERO_CONFIG}: ${campo} ("${p}") queda fuera de la raíz`);
    }
  };
  if (u.preset !== undefined && typeof u.preset !== 'string') throw new Error(`${FICHERO_CONFIG}: preset debe ser texto`);
  for (const k of ['tipos', 'caducables']) {
    if (u[k] !== undefined && !esListaTexto(u[k])) throw new Error(`${FICHERO_CONFIG}: ${k} debe ser una lista de textos`);
  }
  if (u.tipoDefecto !== undefined && u.tipoDefecto !== null && typeof u.tipoDefecto !== 'string') throw new Error(`${FICHERO_CONFIG}: tipoDefecto debe ser texto o null`);
  if (u.campoNombre !== undefined && typeof u.campoNombre !== 'string') throw new Error(`${FICHERO_CONFIG}: campoNombre debe ser texto`);
  if (u.pesosTipo !== undefined && !esObjeto(u.pesosTipo)) throw new Error(`${FICHERO_CONFIG}: pesosTipo debe ser un objeto`);
  if (u.borradoresDir !== undefined) dentro('borradoresDir', u.borradoresDir);
  if (u.fuentes !== undefined) {
    if (!Array.isArray(u.fuentes)) throw new Error(`${FICHERO_CONFIG}: fuentes debe ser una lista`);
    u.fuentes.forEach((f, i) => {
      if (!esObjeto(f)) throw new Error(`${FICHERO_CONFIG}: fuentes[${i}] debe ser un objeto`);
      if (!f.dir && !f.archivo) throw new Error(`${FICHERO_CONFIG}: fuentes[${i}] necesita dir o archivo`);
      if (typeof f.source !== 'string' || !f.source) throw new Error(`${FICHERO_CONFIG}: fuentes[${i}] necesita source (texto)`);
      if (f.dir) dentro(`fuentes[${i}].dir`, f.dir);
      if (f.archivo) dentro(`fuentes[${i}].archivo`, f.archivo);
      if (f.indiceFile !== undefined && (typeof f.indiceFile !== 'string' || /[\\/]/.test(f.indiceFile) || f.indiceFile.startsWith('..'))) throw new Error(`${FICHERO_CONFIG}: fuentes[${i}].indiceFile debe ser un nombre de fichero, sin rutas`);
    });
  }
  if (u.leer !== undefined) {
    if (!esObjeto(u.leer)) throw new Error(`${FICHERO_CONFIG}: leer debe ser un objeto`);
    if (u.leer.dirs !== undefined) {
      if (!esListaTexto(u.leer.dirs)) throw new Error(`${FICHERO_CONFIG}: leer.dirs debe ser una lista de textos`);
      u.leer.dirs.forEach((d, i) => dentro(`leer.dirs[${i}]`, d));
    }
    if (u.leer.ignorarFicheros !== undefined && !esListaTexto(u.leer.ignorarFicheros)) throw new Error(`${FICHERO_CONFIG}: leer.ignorarFicheros debe ser una lista de textos`);
  }
  if (u.revisor !== undefined) {
    if (!esObjeto(u.revisor)) throw new Error(`${FICHERO_CONFIG}: revisor debe ser un objeto`);
    for (const k of ['carpetaDefecto', 'log']) {
      if (u.revisor[k] !== undefined && u.revisor[k] !== null) dentro(`revisor.${k}`, u.revisor[k]);
    }
    if (u.revisor.destinos !== undefined) {
      if (!esObjeto(u.revisor.destinos)) throw new Error(`${FICHERO_CONFIG}: revisor.destinos debe ser un objeto`);
      for (const [k, d] of Object.entries(u.revisor.destinos)) dentro(`revisor.destinos.${k}`, d);
    }
    for (const k of ['datados', 'rutasSincronizadas']) {
      if (u.revisor[k] !== undefined) {
        if (!esListaTexto(u.revisor[k])) throw new Error(`${FICHERO_CONFIG}: revisor.${k} debe ser una lista de textos`);
        if (k === 'rutasSincronizadas') u.revisor[k].forEach((d, i) => dentro(`revisor.rutasSincronizadas[${i}]`, d));
      }
    }
  }
  if (u.guardar !== undefined) {
    if (!esObjeto(u.guardar)) throw new Error(`${FICHERO_CONFIG}: guardar debe ser un objeto`);
    if (u.guardar.modo !== undefined && !['indice', 'borrador', 'directo'].includes(u.guardar.modo)) throw new Error(`${FICHERO_CONFIG}: guardar.modo debe ser "indice", "borrador" o "directo"`);
    if (u.guardar.destinos !== undefined) {
      if (!esObjeto(u.guardar.destinos)) throw new Error(`${FICHERO_CONFIG}: guardar.destinos debe ser un objeto`);
      for (const [k, d] of Object.entries(u.guardar.destinos)) {
        if (!esObjeto(d)) throw new Error(`${FICHERO_CONFIG}: guardar.destinos.${k} debe ser un objeto`);
        dentro(`guardar.destinos.${k}.dir`, d.dir);
      }
    }
  }
}

// Devuelve la config activa con todas las rutas ya absolutas.
export function cargarConfig(root) {
  root = path.resolve(root);
  const ruta = path.join(root, FICHERO_CONFIG);
  let usuario = {};
  if (fs.existsSync(ruta)) {
    try {
      usuario = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch (e) {
      throw new Error(`${FICHERO_CONFIG} no es JSON válido: ${e.message}`);
    }
    if (!usuario || typeof usuario !== 'object' || Array.isArray(usuario)) throw new Error(`${FICHERO_CONFIG} debe ser un objeto JSON`);
  }
  const nombre = usuario.preset || 'micerebro';
  if (!PRESETS[nombre]) throw new Error(`preset desconocido "${nombre}" en ${FICHERO_CONFIG} — válidos: ${Object.keys(PRESETS).join(', ')}`);
  validarUsuario(root, usuario);
  const base = PRESETS[nombre](root);
  const cfg = { ...base };
  for (const [k, v] of Object.entries(usuario)) {
    if (k === 'preset') continue;
    // objetos anidados (leer, guardar): se fusionan con los del preset
    if ((k === 'leer' || k === 'guardar' || k === 'revisor') && v) {
      cfg[k] = { ...base[k], ...v };
      if (k === 'revisor' && v.destinos) cfg.revisor.destinos = { ...base.revisor.destinos, ...v.destinos };
      if (k === 'guardar' && v.destinos) cfg.guardar.destinos = { ...base.guardar.destinos, ...v.destinos };
    } else cfg[k] = v;
  }
  if (!Array.isArray(cfg.tipos) || cfg.tipos.length === 0) throw new Error('config: `tipos` debe ser una lista no vacía');
  if (cfg.tipoDefecto && !cfg.tipos.includes(cfg.tipoDefecto)) throw new Error(`config: tipoDefecto "${cfg.tipoDefecto}" no está en tipos`);
  cfg.preset = nombre;
  cfg.root = root;
  // Nada se indexa fuera de la raíz (enlaces de índice incluidos).
  cfg.confinar = true;
  cfg.tiposSet = new Set(cfg.tipos);
  cfg.borradoresDir = absolutiza(root, cfg.borradoresDir);
  cfg.fuentes = cfg.fuentes.map((f) => {
    const out = { depth: 4, indiceFormato: 'guion', ...f };
    if (out.dir) out.dir = absolutiza(root, out.dir);
    if (out.archivo) out.archivo = absolutiza(root, out.archivo);
    return out;
  });
  cfg.guardar = {
    ...cfg.guardar,
    destinos: Object.fromEntries(Object.entries(cfg.guardar.destinos || {}).map(([k, d]) => [k, { ...d, dir: absolutiza(root, d.dir) }])),
  };
  cfg.leer = { ...cfg.leer, dirs: cfg.leer.dirs.map((d) => absolutiza(root, d)) };
  return cfg;
}

// Ficha de un borrador en el formato del kit (micerebro): type/title/description/status/actualizado.
export function fichaBorradorKit({ tipo, titulo, cuerpo, fecha }) {
  const limpio = String(cuerpo).replace(/\r\n/g, '\n').trim();
  const primera = limpio.split('\n').find((l) => l.trim() !== '') || titulo;
  const description = primera.trim().replace(/^#+\s*/, '').slice(0, 220);
  return `---\ntype: ${tipo}\ntitle: ${JSON.stringify(titulo)}\ndescription: ${JSON.stringify(description)}\nstatus: draft\nactualizado: ${fecha}\n---\n\n${limpio}\n`;
}
