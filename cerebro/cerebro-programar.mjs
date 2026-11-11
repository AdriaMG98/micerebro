#!/usr/bin/env node
// cerebro-programar — programa el revisor de borradores (cerebro-revisor.mjs) para que corra cada hora.
// Cero dependencias externas: solo módulos internos de Node.
//
// Uso: node cerebro-programar.mjs [--estado | --aplicar | --quitar] [--dry-run] [--forzar] [--root <ruta>]
// Raíz: --root > CEREBRO_ROOT > cerebro.config.json hacia arriba desde el cwd > cwd.
//
// Un programador por usuario y máquina (nombre fijo `cerebro-revisor`): aplicar con otra raíz
// sustituye a la anterior. Es lo que quiere un alumno con un solo cerebro; con varios,
// se encadenan las raíces en un script propio.
//   Windows  tarea `schtasks` `cerebro-revisor`, cada hora, lanzada por un .vbs mudo (sin ventana).
//   macOS    LaunchAgent `io.github.adriamg98.cerebro-revisor` (StartInterval 3600 + RunAtLoad).
//   Linux    units de usuario cerebro-revisor.{service,timer} generadas desde las de ../systemd/.
// Todo lo que toca el sistema pasa por el objeto `sistema` (inyectable): los tests lo simulan.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultRoot } from './cerebro-comun.mjs';

export const NOMBRE = 'cerebro-revisor';
export const ETIQUETA_MAC = 'io.github.adriamg98.cerebro-revisor';

// Marca que llevan TODOS los artefactos que crea este script. Sin ella, un fichero, tarea o plist
// con el mismo nombre es de otra persona (o de otra herramienta): no se pisa ni se borra sin --forzar.
export const MARCA = 'Generado por cerebro-programar.mjs';

// .vbs por máquina, con node y el revisor escritos dentro (así /TR solo lleva la raíz y cabe en
// 261 caracteres). Se guarda en UTF-16LE con BOM, que WSH lee bien: sirve aunque node o el
// revisor lleven tildes (usuario «María José»), cosa que un .vbs en UTF-8 sin BOM rompería.
// La raíz sí llega por argumento: cambia sin regenerar el fichero.
function vbs(node, revisor) {
  const lit = (t) => `"${String(t).replace(/"/g, '""')}"`;
  return [
    `' ${MARCA}`,
    'Set sh = CreateObject("WScript.Shell")',
    'q = Chr(34)',
    `cmd = q & ${lit(node)} & q & " " & q & ${lit(revisor)} & q & " --root " & q & WScript.Arguments(0) & q`,
    'WScript.Quit sh.Run(cmd, 0, True)',
    '',
  ].join('\r\n');
}

export function sistemaReal() {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  return {
    plataforma: process.platform,
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    node: process.execPath,
    revisor: path.join(aqui, 'cerebro-revisor.mjs'),
    plantillasDir: path.join(aqui, '..', 'systemd'),
    consultar(cmd, args) { return this.ejecutar(cmd, args); }, // solo lectura: el ensayo la deja real
    ejecutar(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
    },
    escribir(ruta, texto, { utf16le = false } = {}) {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fs.writeFileSync(ruta, utf16le ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, 'utf16le')]) : texto);
    },
    borrar(ruta) { fs.rmSync(ruta, { force: true }); }, // un symlink se quita a sí mismo, no su destino
    borrarDir(ruta) { try { fs.rmdirSync(ruta); } catch { /* no vacía o inexistente: se deja */ } },
    esSymlink(ruta) { try { return fs.lstatSync(ruta).isSymbolicLink(); } catch { return false; } },
    esperar(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
    simulado: false,
    existe(ruta) { return fs.existsSync(ruta); },
    // Detecta BOM: el .vbs va en UTF-16LE (FF FE); un fichero ajeno puede traer UTF-8 con BOM.
    leer(ruta) {
      const b = fs.readFileSync(ruta);
      if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
      return b.toString('utf8');
    },
    imprimir(linea) { console.log(linea); },
  };
}

// Mismo sistema, pero escribir/borrar/ejecutar solo se cuentan. Lo de solo lectura sigue siendo real.
export function sistemaEnsayo(real) {
  const dicho = (t) => real.imprimir(t);
  return {
    ...real,
    simulado: true,
    consultar: (c, a) => real.ejecutar(c, a),
    ejecutar(cmd, args) { dicho(`$ ${[cmd, ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`); return { status: 0, stdout: '', stderr: '' }; },
    escribir(ruta, texto) { dicho(`--- escribiría ${ruta}\n${texto}--- fin ${ruta}`); },
    borrar(ruta) { dicho(`(borraría ${ruta})`); },
    borrarDir(ruta) { dicho(`(borraría la carpeta ${ruta} si está vacía)`); },
    esperar() {},
  };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Mensaje final: en ensayo lo dice, para que nadie crea que se hizo.
const fin = (sis, t) => sis.imprimir(sis.simulado ? `${t} (simulado)` : t);

// ¿Es nuestro lo que hay en `ruta`? false = no existe; true = lo creamos nosotros (marca).
// Algo ajeno (symlink o sin marca) aborta con mensaje claro, salvo --forzar (devuelve 'ajeno').
function dueno(sis, ruta, forzar, verbo) {
  const enlace = sis.esSymlink(ruta);
  if (!enlace && !sis.existe(ruta)) return false;
  if (!enlace && String(sis.leer(ruta)).includes(MARCA)) return true;
  if (forzar) return 'ajeno';
  throw new Error(`${ruta} ya existe y no lo creó cerebro-programar (${enlace ? 'es un enlace simbólico' : `no lleva la marca «${MARCA}»`}). No lo ${verbo}. Muévelo o bórralo tú, o repite con --forzar si de verdad quieres sustituirlo.`);
}

// Escribe un artefacto nuestro; si había uno ajeno (con --forzar) se quita antes, para no escribir a través de un symlink.
function poner(sis, ruta, texto, forzar, opciones) {
  if (dueno(sis, ruta, forzar, 'piso') === 'ajeno') sis.borrar(ruta);
  sis.escribir(ruta, texto, opciones);
}

// systemd: comillas dobles y `%` duplicado (los especificadores se expanden también entre comillas).
const sd = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
// En ExecStart= también se expande `$VAR`: se duplica el `$` (no en Environment=).
const sdExec = (s) => sd(s).replace(/\$/g, () => '$$');

// --- Windows ---------------------------------------------------------------------

function rutasWindows(sis) {
  const w = path.win32;
  const dir = w.join(sis.home, 'AppData', 'Local', NOMBRE);
  return { dir, vbs: w.join(dir, 'cerebro-revisor.vbs') };
}

// La tarea es nuestra si su acción apunta a nuestro .vbs. false = no existe.
function tareaNuestra(sis, vbsRuta) {
  const r = sis.consultar('schtasks', ['/Query', '/TN', NOMBRE, '/XML']);
  if (r.status !== 0) return false;
  // El XML escapa entidades (& en una ruta sale como &amp;) y las rutas de Windows no distinguen mayúsculas.
  const xml = r.stdout.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);
  return xml.toLowerCase().includes(vbsRuta.toLowerCase()) ? true : 'ajena';
}

function aplicarWindows(sis, root, forzar) {
  const { vbs: ruta } = rutasWindows(sis);
  const q = (s) => `"${s}"`;
  const tr = ['wscript.exe', '//B', '//Nologo', q(ruta), q(root)].join(' ');
  // /TR admite como mucho 261 caracteres: mejor avisar que dejar una tarea cortada.
  if (tr.length > 261) throw new Error(`la línea de la tarea mide ${tr.length} caracteres y schtasks admite 261: usa una ruta más corta`);
  if (tareaNuestra(sis, ruta) === 'ajena' && !forzar) {
    throw new Error(`Ya hay una tarea programada llamada ${NOMBRE} que no creó cerebro-programar (su acción no usa ${ruta}). No la piso. Bórrala tú (schtasks /Delete /TN ${NOMBRE}) o repite con --forzar.`);
  }
  poner(sis, ruta, vbs(sis.node, sis.revisor), forzar, { utf16le: true });
  const r = sis.ejecutar('schtasks', ['/Create', '/TN', NOMBRE, '/SC', 'HOURLY', '/MO', '1', '/TR', tr, '/F']);
  if (r.status !== 0) throw new Error(`schtasks /Create falló: ${r.stderr || r.stdout}`);
  fin(sis, `Tarea ${NOMBRE} creada: cada hora, sin ventana.`);
}

function quitarWindows(sis, root, forzar) {
  const { dir, vbs: ruta } = rutasWindows(sis);
  const tarea = tareaNuestra(sis, ruta);
  const fichero = dueno(sis, ruta, forzar, 'borro');
  if (tarea === 'ajena' && !forzar) {
    throw new Error(`La tarea ${NOMBRE} existe pero no la creó cerebro-programar. No la borro. Bórrala tú (schtasks /Delete /TN ${NOMBRE}) o repite con --forzar.`);
  }
  if (tarea) sis.ejecutar('schtasks', ['/Delete', '/TN', NOMBRE, '/F']);
  if (fichero) { sis.borrar(ruta); sis.borrarDir(dir); }
  fin(sis, tarea || fichero ? `Tarea ${NOMBRE} y su lanzador borrados.` : `No había nada que quitar (tarea ${NOMBRE}).`);
}

function estadoWindows(sis) {
  const { vbs: ruta } = rutasWindows(sis);
  if (tareaNuestra(sis, ruta) === 'ajena') return sis.imprimir(`Hay una tarea ${NOMBRE} que NO es de cerebro-programar.`);
  const r = sis.ejecutar('schtasks', ['/Query', '/TN', NOMBRE, '/FO', 'LIST', '/V']);
  if (r.status !== 0) return sis.imprimir(`No programado: no existe la tarea ${NOMBRE}.`);
  sis.imprimir(`Programado: tarea ${NOMBRE}.`);
  // Los nombres de campo salen en el idioma de Windows: se muestran los de estado y última ejecución.
  const lineas = r.stdout.split(/\r?\n/).filter((l) => /last run|última ejecución|ultima ejecucion|last result|último resultado|status|estado/i.test(l));
  for (const l of lineas) sis.imprimir(`  ${l.trim()}`);
}

// --- macOS -----------------------------------------------------------------------

function rutasMac(sis, root) {
  const m = path.posix;
  const plist = m.join(sis.home, 'Library', 'LaunchAgents', `${ETIQUETA_MAC}.plist`);
  const registro = m.join(root, 'registro');
  const log = sis.existe(registro) ? m.join(registro, 'cerebro-revisor.log') : m.join(sis.home, 'Library', 'Logs', 'cerebro-revisor.log');
  return { plist, log };
}

function plistMac(sis, root, log) {
  // launchd no hereda el PATH del usuario: node va por ruta absoluta y el PATH lleva su carpeta
  // (el revisor llama a git).
  const pathEnv = [path.posix.dirname(sis.node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MARCA} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ETIQUETA_MAC}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(sis.node)}</string>
    <string>${xml(sis.revisor)}</string>
    <string>--root</string>
    <string>${xml(root)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function aplicarMac(sis, root, forzar) {
  const { plist, log } = rutasMac(sis, root);
  const dominio = `gui/${sis.uid}`;
  poner(sis, plist, plistMac(sis, root, log), forzar);
  // Idempotente: se suelta la versión cargada (si la hay) antes de cargar la nueva. Justo después
  // de un bootout, bootstrap suele fallar un instante (errores 5 y 37): se reintenta con espera.
  sis.ejecutar('launchctl', ['bootout', `${dominio}/${ETIQUETA_MAC}`]);
  let r;
  for (let i = 0; i < 5; i++) {
    r = sis.ejecutar('launchctl', ['bootstrap', dominio, plist]);
    if (r.status === 0) break;
    sis.esperar(1000);
  }
  if (r.status !== 0) throw new Error(`launchctl bootstrap falló: ${r.stderr || r.stdout}`);
  fin(sis, `LaunchAgent ${ETIQUETA_MAC} cargado: cada hora. Log: ${log}`);
}

function quitarMac(sis, root, forzar) {
  const { plist } = rutasMac(sis, '');
  const hay = dueno(sis, plist, forzar, 'borro');
  if (!hay) return fin(sis, `No había nada que quitar (${ETIQUETA_MAC}).`);
  sis.ejecutar('launchctl', ['bootout', `gui/${sis.uid}/${ETIQUETA_MAC}`]);
  sis.borrar(plist);
  fin(sis, `LaunchAgent ${ETIQUETA_MAC} descargado y borrado.`);
}

function estadoMac(sis) {
  const { plist } = rutasMac(sis, '');
  const r = sis.ejecutar('launchctl', ['print', `gui/${sis.uid}/${ETIQUETA_MAC}`]);
  if (r.status !== 0) return sis.imprimir(`No programado: ${ETIQUETA_MAC} no está cargado${sis.existe(plist) ? ' (el plist existe: aplica de nuevo)' : ''}.`);
  sis.imprimir(`Programado: ${ETIQUETA_MAC}.`);
  for (const l of r.stdout.split('\n').filter((x) => /state =|last exit code|runs =/i.test(x))) sis.imprimir(`  ${l.trim()}`);
}

// --- Linux -----------------------------------------------------------------------

function rutasLinux(sis) {
  const dir = path.posix.join(sis.home, '.config', 'systemd', 'user');
  return { dir, servicio: path.posix.join(dir, `${NOMBRE}.service`), timer: path.posix.join(dir, `${NOMBRE}.timer`) };
}

// Parte de las units de systemd/ y solo sustituye las dos líneas que dependen de la máquina.
function unitsLinux(sis, root) {
  const plantilla = (n) => sis.leer(path.join(sis.plantillasDir, n));
  const servicio = plantilla('cerebro-revisor.service').split('\n').map((l) => {
    if (l.startsWith('Environment=CEREBRO_ROOT=')) return `Environment=${sd(`CEREBRO_ROOT=${root}`)}`;
    if (l.startsWith('ExecStart=')) return `ExecStart=${sdExec(sis.node)} ${sdExec(sis.revisor)} --root ${sdExec(root)}`;
    if (l.startsWith('# Ajusta las dos rutas')) return `# ${MARCA}: vuelve a ejecutarlo para cambiarlo.`;
    return l;
  }).join('\n');
  return { servicio, timer: `# ${MARCA}\n${plantilla('cerebro-revisor.timer')}` };
}

function aplicarLinux(sis, root, forzar) {
  const { servicio, timer } = unitsLinux(sis, root);
  const r = rutasLinux(sis);
  // Se comprueban las dos antes de escribir ninguna: o se hace todo o no se toca nada.
  dueno(sis, r.servicio, forzar, 'piso');
  dueno(sis, r.timer, forzar, 'piso');
  poner(sis, r.servicio, servicio, forzar);
  poner(sis, r.timer, timer, forzar);
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', `${NOMBRE}.timer`]]) {
    const x = sis.ejecutar('systemctl', args);
    if (x.status !== 0) throw new Error(`systemctl ${args.join(' ')} falló: ${x.stderr || x.stdout}`);
  }
  fin(sis, `Timer ${NOMBRE}.timer activado: cada hora.`);
}

function quitarLinux(sis, root, forzar) {
  const r = rutasLinux(sis);
  const hay = [dueno(sis, r.servicio, forzar, 'borro'), dueno(sis, r.timer, forzar, 'borro')];
  if (!hay[0] && !hay[1]) return fin(sis, `No había nada que quitar (${NOMBRE}).`);
  sis.ejecutar('systemctl', ['--user', 'disable', '--now', `${NOMBRE}.timer`]);
  sis.borrar(r.servicio);
  sis.borrar(r.timer);
  sis.ejecutar('systemctl', ['--user', 'daemon-reload']);
  fin(sis, `Timer ${NOMBRE}.timer desactivado y units borradas.`);
}

function estadoLinux(sis) {
  const r = rutasLinux(sis);
  if (!sis.existe(r.timer) && !sis.esSymlink(r.timer)) return sis.imprimir(`No programado: no existe ${r.timer}.`);
  if (dueno(sis, r.timer, true, '') !== true) return sis.imprimir(`Hay un ${NOMBRE}.timer que NO es de cerebro-programar (${r.timer}).`);
  const ac = sis.ejecutar('systemctl', ['--user', 'is-active', `${NOMBRE}.timer`]);
  sis.imprimir(`${ac.stdout.trim() === 'active' ? 'Programado' : 'Units escritas pero timer inactivo'}: ${NOMBRE}.timer.`);
  const t = sis.ejecutar('systemctl', ['--user', 'list-timers', `${NOMBRE}.timer`, '--no-pager']);
  for (const l of t.stdout.split('\n').filter((x) => x.trim())) sis.imprimir(`  ${l.trim()}`);
}

// --- Entrada ---------------------------------------------------------------------

const POR_SO = {
  win32: { aplicar: aplicarWindows, quitar: quitarWindows, estado: estadoWindows },
  darwin: { aplicar: aplicarMac, quitar: quitarMac, estado: estadoMac },
  linux: { aplicar: aplicarLinux, quitar: quitarLinux, estado: estadoLinux },
};

// accion: 'estado' | 'aplicar' | 'quitar'. `root` ya viene resuelta (absoluta, en el estilo del SO).
export function programar({ accion = 'estado', root, sistema, dryRun = false, forzar = false }) {
  const so = POR_SO[sistema.plataforma];
  if (!so) throw new Error(`plataforma sin soporte: ${sistema.plataforma}`);
  const sis = dryRun && accion !== 'estado' ? sistemaEnsayo(sistema) : sistema;
  if (dryRun && accion === 'estado') sistema.imprimir('(--dry-run no cambia nada en --estado)');
  so[accion](sis, root, forzar);
}

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

function main() {
  const { flags, root: rootArg } = parseArgs(process.argv.slice(2));
  if (flags.has('-h') || flags.has('--help')) {
    console.log('Uso: node cerebro-programar.mjs [--estado | --aplicar | --quitar] [--dry-run] [--forzar] [--root <ruta>]\n  --forzar sustituye lo ajeno (sin la marca del script). Programa el revisor para que corra cada hora (schtasks / launchd / systemd de usuario).');
    return;
  }
  const acciones = ['--aplicar', '--quitar', '--estado'].filter((f) => flags.has(f));
  if (acciones.length > 1) throw new Error(`elige una sola acción (${acciones.join(', ')})`);
  const accion = (acciones[0] || '--estado').slice(2);
  const root = path.resolve(rootArg || defaultRoot());
  programar({ accion, root, sistema: sistemaReal(), dryRun: flags.has('--dry-run'), forzar: flags.has('--forzar') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`MiCerebro programar error: ${error.message}`);
    process.exitCode = 1;
  }
}
