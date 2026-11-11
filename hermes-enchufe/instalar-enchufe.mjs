#!/usr/bin/env node
// Instala el enchufe de memoria en Hermes con Node (>=18), sin dependencias y sin Python.
// Es el instalador del kit PC (Windows/Mac): Node es lo único que Hermes garantiza en el equipo.
// (instalar-enchufe.py sigue siendo el de Linux/VM y el kit Servidor.)
//
// No edita YAML a mano: toda la configuración pasa por la CLI de Hermes (`hermes config set`),
// que fusiona config.yaml y escribe en .env las claves MAYUSCULAS_SIN_PUNTOS.
//
//   node instalar-enchufe.mjs --cerebro <ruta>                 # ensayo: no cambia nada
//   node instalar-enchufe.mjs --cerebro <ruta> --aplicar       # backup + instala
//   node instalar-enchufe.mjs --deshacer <carpeta-backup>      # restaura y quita el enlace
// Opciones: --hermes <ruta a hermes.exe o "hermes">  --node <ruta a node>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const NOMBRE = 'enchufe';
const VIGILANTE = 'vigilante-contexto';
const MARCA_COPIA = '.enchufe-copia';

const barras = (p) => String(p).replace(/\\/g, '/');
const conComillas = (p) => (/\s/.test(p) ? `"${p}"` : p);

function uso(msg) {
  if (msg) console.error(msg);
  console.error('Uso: node instalar-enchufe.mjs --cerebro <ruta> [--hermes <ruta>] [--node <ruta>] [--aplicar]\n' +
    '     node instalar-enchufe.mjs --deshacer <carpeta-backup>');
  process.exit(2);
}

function leerArgs(argv) {
  const a = { aplicar: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--aplicar') a.aplicar = true;
    else if (['--cerebro', '--hermes', '--node', '--deshacer'].includes(k)) {
      if (i + 1 >= argv.length) uso(`Falta el valor de ${k}`);
      a[k.slice(2)] = argv[++i];
    } else uso(`Argumento desconocido: ${k}`);
  }
  if (a.deshacer ? a.cerebro : !a.cerebro) uso(a.deshacer ? '--deshacer no lleva --cerebro' : 'Falta --cerebro');
  return a;
}

function localizarHermes(arg) {
  if (arg) return arg;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const exe = path.join(process.env.LOCALAPPDATA, 'hermes', 'bin', 'hermes.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'hermes';
}

function hermes(bin, args) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
  });
  if (r.error) throw new Error(`No puedo ejecutar «${bin}»: ${r.error.message}`);
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Valor actual de una clave de config.yaml (undefined si no está puesta).
function leerConfig(bin, clave) {
  const r = hermes(bin, ['config', 'get', clave, '--json', '--raw']);
  if (r.code !== 0) return undefined;
  const linea = r.out.split(/\r?\n/).filter((l) => l.trim()).pop();
  try { return JSON.parse(linea); } catch { return undefined; }
}

// Valor actual de una variable del .env (se lee el fichero: `config get` miraría antes el entorno).
function leerEnv(fichero, clave) {
  if (!fs.existsSync(fichero)) return undefined;
  let valor;
  for (const linea of fs.readFileSync(fichero, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== clave) continue;
    let v = m[2];
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    valor = v;
  }
  return valor;
}

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Lo que apunta el enlace (o undefined si no es un enlace), resuelto.
function destinoEnlace(p) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return undefined;
    return fs.realpathSync(p);
  } catch { return undefined; }
}

function estadoPlugin(enlace) {
  let st;
  try { st = fs.lstatSync(enlace); } catch { return 'falta'; }
  const real = destinoEnlace(enlace);
  if (st.isSymbolicLink() || real) {
    return real && real === fs.realpathSync(PLUGIN) ? 'enlace' : 'conflicto';
  }
  if (st.isDirectory() && fs.existsSync(path.join(enlace, MARCA_COPIA))) return 'copia';
  return 'conflicto';
}

function crearPlugin(enlace) {
  fs.mkdirSync(path.dirname(enlace), { recursive: true });
  try {
    fs.symlinkSync(PLUGIN, enlace, process.platform === 'win32' ? 'junction' : 'dir');
    return 'enlace';
  } catch (e) {
    fs.cpSync(PLUGIN, enlace, { recursive: true });
    fs.writeFileSync(path.join(enlace, MARCA_COPIA), `copia de ${barras(PLUGIN)}\n`);
    console.log(`  (no pude crear el enlace: ${e.code || e.message}; copio la carpeta)`);
    return 'copia';
  }
}

function quitarPlugin(enlace) {
  let st;
  try { st = fs.lstatSync(enlace); } catch { return false; }
  if (st.isSymbolicLink() || destinoEnlace(enlace)) {
    try { fs.unlinkSync(enlace); } catch { fs.rmdirSync(enlace); }
    return true;
  }
  if (st.isDirectory() && fs.existsSync(path.join(enlace, MARCA_COPIA))) {
    fs.rmSync(enlace, { recursive: true, force: true });
    return true;
  }
  return false;
}

function deshacer(carpeta) {
  const meta = JSON.parse(fs.readFileSync(path.join(carpeta, 'meta.json'), 'utf8'));
  const datos = meta.datos;
  for (const f of ['config.yaml', '.env']) {
    const copia = path.join(carpeta, f);
    if (fs.existsSync(copia)) { fs.copyFileSync(copia, path.join(datos, f)); console.log(`restaurado: ${f}`); }
    else if (f === '.env' && !meta.tuvoEnv && fs.existsSync(path.join(datos, f))) {
      fs.rmSync(path.join(datos, f)); console.log('quitado: .env (no existía antes)');
    }
  }
  if (meta.creoEnlace) {
    console.log(quitarPlugin(path.join(datos, 'plugins', NOMBRE)) ? 'quitado: plugins/enchufe' : 'plugins/enchufe: no había nada que quitar');
  }
  console.log('Hecho. Ahora: hermes gateway restart');
}

function main() {
  const a = leerArgs(process.argv.slice(2));
  if (a.deshacer) return deshacer(path.resolve(a.deshacer));

  const cerebro = barras(path.resolve(a.cerebro));
  for (const f of ['.cerebro/cerebro/cerebro-mcp.mjs', '.cerebro/cerebro/cerebro.mjs']) {
    if (!fs.existsSync(`${cerebro}/${f}`)) { console.error(`No encuentro ${cerebro}/${f}: ¿es esa la carpeta del cerebro?`); return 1; }
  }
  const nodo = barras(a.node || process.execPath);
  const bin = localizarHermes(a.hermes);

  const rutaCfg = hermes(bin, ['config', 'path']);
  if (rutaCfg.code !== 0 || !rutaCfg.out) { console.error(`«${bin} config path» falló: ${rutaCfg.err || rutaCfg.out}`); return 1; }
  const cfgFichero = path.resolve(rutaCfg.out.split(/\r?\n/).filter((l) => l.trim()).pop().trim());
  const datos = path.dirname(cfgFichero);
  const envFichero = path.join(datos, '.env');
  console.log(`Hermes: ${barras(bin)}\nDatos de Hermes: ${barras(datos)}\nNode: ${nodo}\nCerebro: ${cerebro}`);
  console.log(a.aplicar ? 'Modo: APLICAR\n' : 'Modo: ensayo (no se cambia nada)\n');

  // Plugin: un conflicto para todo antes de tocar nada.
  const enlace = path.join(datos, 'plugins', NOMBRE);
  const pl = estadoPlugin(enlace);
  if (pl === 'conflicto') {
    console.error(`CONFLICTO: ${barras(enlace)} existe y no apunta a este plugin. No se toca nada.`);
    return 1;
  }

  const dirSkills = `${cerebro}/.hermes/skills`;
  const cerebroMjs = `${cerebro}/.cerebro/cerebro/cerebro.mjs`;
  const mcp = { command: nodo, args: [`${cerebro}/.cerebro/cerebro/cerebro-mcp.mjs`], env: { CEREBRO_ROOT: cerebro } };
  const envDeseado = {
    CEREBRO_ROOT: cerebro,
    ENCHUFE_CEREBRO_PATH: `${cerebro}/.cerebro/cerebro`,
    ENCHUFE_CEREBRO_CMD: `${conComillas(nodo)} ${conComillas(cerebroMjs)}`,
  };

  // Claves de config.yaml: [clave, valor deseado | función(actual) -> valor deseado]
  const dirs = (actual) => {
    const l = Array.isArray(actual) ? actual : (typeof actual === 'string' && actual ? [actual] : []);
    return l.map(barras).includes(dirSkills) ? l : [...l, dirSkills];
  };
  const plugins = (actual) => {
    const l = Array.isArray(actual) ? actual : [];
    return l.includes(VIGILANTE) ? l : [...l, VIGILANTE];
  };
  const claves = [
    ['memory.provider', NOMBRE],
    ['mcp_servers.cerebro', mcp],
    ['skills.external_dirs', dirs],
    ['skills.create_dir', dirSkills],
    ['skills.project_discovery', false],
    ['plugins.enabled', plugins],
  ];

  const acciones = [];
  for (const [clave, deseado] of claves) {
    const actual = leerConfig(bin, clave);
    const valor = typeof deseado === 'function' ? deseado(actual) : deseado;
    acciones.push({ nombre: clave, hecho: igual(actual, valor), valor, args: ['config', 'set', clave, typeof valor === 'string' ? valor : JSON.stringify(valor)] });
  }
  for (const [clave, valor] of Object.entries(envDeseado)) {
    acciones.push({ nombre: clave, hecho: leerEnv(envFichero, clave) === valor, valor, args: ['config', 'set', clave, valor], env: true });
  }

  const pendientes = acciones.filter((x) => !x.hecho);
  const etiquetaPl = { enlace: 'plugins/enchufe: ya estaba (enlace)', copia: 'plugins/enchufe: ya estaba (copia)', falta: `plugins/enchufe: ${a.aplicar ? 'se crea' : 'se crearía'} (${process.platform === 'win32' ? 'junction' : 'enlace'} a ${barras(PLUGIN)})` };
  console.log(etiquetaPl[pl]);

  let backup;
  if (a.aplicar && (pl === 'falta' || pendientes.length)) {
    const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
    backup = path.join(datos, 'backups', `enchufe-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const f of [cfgFichero, envFichero]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backup, path.basename(f)));
    fs.writeFileSync(path.join(backup, 'meta.json'), JSON.stringify({ datos: barras(datos), creoEnlace: pl === 'falta', tuvoEnv: fs.existsSync(envFichero) }, null, 2));
    console.log(`backup: ${barras(backup)}`);
    if (pl === 'falta') crearPlugin(enlace);
  }

  let fallos = 0;
  for (const x of acciones) {
    if (x.hecho) { console.log(`ya estaba: ${x.nombre}`); continue; }
    const resumen = x.nombre === 'mcp_servers.cerebro' ? `command=${x.valor.command}` : JSON.stringify(x.valor);
    if (!a.aplicar) { console.log(`se pondría: ${x.nombre} = ${resumen}`); continue; }
    const r = hermes(bin, x.args);
    if (r.code === 0) console.log(`puesto: ${x.nombre} = ${resumen}`);
    else { fallos++; console.error(`FALLÓ: ${x.nombre}: ${r.err || r.out}`); }
  }

  if (!a.aplicar) { console.log('\nEnsayo terminado. Repite con --aplicar para instalar.'); return 0; }
  if (fallos) { console.error(`\n${fallos} paso(s) fallaron. Para volver atrás: node instalar-enchufe.mjs --deshacer "${barras(backup)}"`); return 1; }
  if (fs.existsSync(cfgFichero) && fs.readFileSync(cfgFichero, 'utf8').includes('RUTA-DE-TU-CEREBRO')) {
    console.error('\nAVISO: config.yaml aún contiene RUTA-DE-TU-CEREBRO: sustitúyelo por la ruta real.'); return 1;
  }
  console.log('\nHecho. Ahora: hermes gateway restart');
  return 0;
}

try { process.exitCode = main(); } catch (e) { console.error(`Error: ${e.message}`); process.exitCode = 1; }
