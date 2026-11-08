// Tests de okf-programar con un sistema simulado: ni se escribe ni se ejecuta nada real.
// Uso: node --test okf-programar.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { sistemaReal, programar, NOMBRE, ETIQUETA_MAC, MARCA } from './okf-programar.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const plantillasDir = path.join(aqui, '..', 'systemd');

// `existentes`: rutas que existen de partida; `fallan`: prefijos de comando que devuelven 1.
// `pre`: ficheros ajenos que ya existen (ruta → texto); `symlinks`: cuáles de ellos son enlaces;
// `fallosPor`: prefijo de comando → cuántas veces falla antes de ir bien.
function simulado(plataforma, { existentes = [], fallan = [], salidas = {}, pre = {}, symlinks = [], fallosPor = {} } = {}) {
  const base = {
    win32: { home: 'C:\\Users\\María José', node: 'C:\\Program Files\\nodejs\\node.exe', revisor: 'C:\\Kit Ñ\\okf\\okf-revisor.mjs' },
    darwin: { home: '/Users/maría josé', node: '/opt/homebrew/bin/node', revisor: '/Users/maría josé/okf kit/okf/okf-revisor.mjs' },
    linux: { home: '/home/maría josé', node: '/usr/bin/node', revisor: '/home/maría josé/okf kit/okf/okf-revisor.mjs' },
  }[plataforma];
  const ficheros = new Map();
  const comandos = [];
  const salida = [];
  const esperas = [];
  const dirsBorrados = [];
  const sis = {
    plataforma, ...base, uid: 501, plantillasDir,
    ejecutar(cmd, args) {
      const linea = [cmd, ...args].join(' ');
      comandos.push(linea);
      const fp = Object.keys(fallosPor).find((x) => linea.startsWith(x));
      if (fp && fallosPor[fp] > 0) { fallosPor[fp]--; return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5' }; }
      if (fallan.some((p) => linea.startsWith(p))) return { status: 1, stdout: '', stderr: 'no' };
      const clave = Object.keys(salidas).find((p) => linea.startsWith(p));
      if (!clave && linea.startsWith('schtasks /Query')) return { status: 1, stdout: '', stderr: 'no existe' }; // por defecto, sin tarea
      return { status: 0, stdout: clave ? salidas[clave] : '', stderr: '' };
    },
    consultar(cmd, args) { return this.ejecutar(cmd, args); },
    escribir: (r, t, o) => { ficheros.set(r, t); if (o) ficheros.opciones = o; delete pre[r]; },
    borrar: (r) => { ficheros.delete(r); delete pre[r]; const i = symlinks.indexOf(r); if (i >= 0) symlinks.splice(i, 1); },
    borrarDir: (r) => { dirsBorrados.push(r); },
    esSymlink: (r) => symlinks.includes(r),
    existe: (r) => ficheros.has(r) || r in pre || existentes.includes(r),
    leer: (r) => (ficheros.has(r) ? ficheros.get(r) : r in pre ? pre[r] : fs.readFileSync(r, 'utf8')),
    esperar: (ms) => { esperas.push(ms); },
    simulado: false,
    imprimir: (l) => salida.push(l),
  };
  return { sis, ficheros, comandos, salida, esperas, dirsBorrados, pre, symlinks };
}

const RAIZ = { win32: 'C:\\Users\\María José\\Mi Cerebro', darwin: '/Users/maría josé/Mi Cerebro', linux: '/home/maría josé/Mi Cerebro' };

test('Linux: aplicar escribe las dos units con rutas absolutas y activa el timer', () => {
  const m = simulado('linux');
  programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis });
  const dir = '/home/maría josé/.config/systemd/user';
  const svc = m.ficheros.get(`${dir}/okf-revisor.service`);
  assert.ok(svc.includes('ExecStart="/usr/bin/node" "/home/maría josé/okf kit/okf/okf-revisor.mjs" --root "/home/maría josé/Mi Cerebro"'));
  assert.ok(svc.includes('Environment="OKF_ROOT=/home/maría josé/Mi Cerebro"'));
  assert.ok(!svc.includes('%h'));
  assert.equal(m.ficheros.get(`${dir}/okf-revisor.timer`), `# ${MARCA}\n${fs.readFileSync(path.join(plantillasDir, 'okf-revisor.timer'), 'utf8')}`);
  assert.ok(svc.includes(MARCA));
  assert.deepEqual(m.comandos, ['systemctl --user daemon-reload', 'systemctl --user enable --now okf-revisor.timer']);
});

test('Linux: % en la ruta se duplica para systemd', () => {
  const m = simulado('linux');
  programar({ accion: 'aplicar', root: '/home/x/100%', sistema: m.sis });
  assert.ok([...m.ficheros.values()].some((t) => t.includes('"/home/x/100%%"')));
});

test('Linux: idempotente (dos aplicar dejan lo mismo) y quitar deshace', () => {
  const m = simulado('linux');
  programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis });
  const uno = JSON.stringify([...m.ficheros]);
  programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis });
  assert.equal(JSON.stringify([...m.ficheros]), uno);
  assert.equal(m.ficheros.size, 2);
  programar({ accion: 'quitar', root: RAIZ.linux, sistema: m.sis });
  assert.equal(m.ficheros.size, 0);
  assert.ok(m.comandos.includes('systemctl --user disable --now okf-revisor.timer'));
});

test('Linux: estado distingue no programado y programado', () => {
  const a = simulado('linux');
  programar({ accion: 'estado', root: RAIZ.linux, sistema: a.sis });
  assert.match(a.salida[0], /^No programado/);
  const timer = '/home/maría josé/.config/systemd/user/okf-revisor.timer';
  const b = simulado('linux', { pre: { [timer]: `# ${MARCA}\n` }, salidas: { 'systemctl --user is-active': 'active\n', 'systemctl --user list-timers': 'NEXT LEFT\nfoo 10min\n' } });
  programar({ accion: 'estado', root: RAIZ.linux, sistema: b.sis });
  assert.match(b.salida[0], /^Programado/);
  assert.ok(b.salida.some((l) => l.includes('foo 10min')));
});

test('Linux: si systemctl falla, aplicar lanza error', () => {
  const m = simulado('linux', { fallan: ['systemctl --user enable'] });
  assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis }), /systemctl/);
});

test('Mac: aplicar escribe el plist (node absoluto, intervalo, log) y hace bootstrap', () => {
  const m = simulado('darwin');
  programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: m.sis });
  const plist = `/Users/maría josé/Library/LaunchAgents/${ETIQUETA_MAC}.plist`;
  const t = m.ficheros.get(plist);
  assert.ok(t.includes('<string>/opt/homebrew/bin/node</string>'));
  assert.ok(t.includes('<string>/Users/maría josé/Mi Cerebro</string>'));
  assert.ok(t.includes('<key>StartInterval</key><integer>3600</integer>'));
  assert.ok(t.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(t.includes('/Users/maría josé/Library/Logs/okf-revisor.log'));
  assert.deepEqual(m.comandos, [`launchctl bootout gui/501/${ETIQUETA_MAC}`, `launchctl bootstrap gui/501 ${plist}`]);
});

test('Mac: el log va a registro/ del cerebro si la carpeta existe; & se escapa', () => {
  const m = simulado('darwin', { existentes: ['/Users/a/Cerebro & Co/registro'] });
  programar({ accion: 'aplicar', root: '/Users/a/Cerebro & Co', sistema: m.sis });
  const t = [...m.ficheros.values()][0];
  assert.ok(t.includes('/Users/a/Cerebro &amp; Co/registro/okf-revisor.log'));
});

test('Mac: idempotente, quitar y estado', () => {
  const m = simulado('darwin');
  programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: m.sis });
  const uno = JSON.stringify([...m.ficheros]);
  programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: m.sis });
  assert.equal(JSON.stringify([...m.ficheros]), uno);
  programar({ accion: 'quitar', root: RAIZ.darwin, sistema: m.sis });
  assert.equal(m.ficheros.size, 0);
  assert.ok(m.comandos.includes(`launchctl bootout gui/501/${ETIQUETA_MAC}`));
  const n = simulado('darwin', { fallan: ['launchctl print'] });
  programar({ accion: 'estado', root: RAIZ.darwin, sistema: n.sis });
  assert.match(n.salida[0], /^No programado/);
  const s = simulado('darwin', { salidas: { 'launchctl print': '\tstate = waiting\n\tlast exit code = 0\n' } });
  programar({ accion: 'estado', root: RAIZ.darwin, sistema: s.sis });
  assert.match(s.salida[0], /^Programado/);
  assert.ok(s.salida.some((l) => l.includes('last exit code = 0')));
});

test('Windows: aplicar crea el .vbs mudo (UTF-16LE, con node y revisor dentro) y la tarea horaria', () => {
  const m = simulado('win32');
  programar({ accion: 'aplicar', root: RAIZ.win32, sistema: m.sis });
  const vbs = 'C:\\Users\\María José\\AppData\\Local\\okf-revisor\\okf-revisor.vbs';
  const t = m.ficheros.get(vbs);
  assert.deepEqual(m.ficheros.opciones, { utf16le: true });
  assert.ok(t.includes(MARCA));
  assert.ok(t.includes('"C:\\Program Files\\nodejs\\node.exe"') && t.includes('"C:\\Kit Ñ\\okf\\okf-revisor.mjs"'));
  assert.ok(t.includes('sh.Run(cmd, 0, True)'));
  const c = m.comandos.filter((x) => x.startsWith('schtasks /Create'));
  assert.equal(c.length, 1);
  assert.equal(c[0], `schtasks /Create /TN ${NOMBRE} /SC HOURLY /MO 1 /TR wscript.exe //B //Nologo "${vbs}" "C:\\Users\\María José\\Mi Cerebro" /F`);
});

test('Windows: ruta demasiado larga para /TR da error claro', () => {
  const m = simulado('win32');
  assert.throws(() => programar({ accion: 'aplicar', root: `C:\\${'a'.repeat(250)}`, sistema: m.sis }), /261/);
});

test('Windows: idempotente (/F), quitar, estado', () => {
  const m = simulado('win32');
  const vbs = 'C:\\Users\\María José\\AppData\\Local\\okf-revisor\\okf-revisor.vbs';
  m.sis.ejecutar = ((orig) => (cmd, args) => { const r = orig(cmd, args); return cmd === 'schtasks' && args[0] === '/Query' ? { ...r, stdout: m.ficheros.has(vbs) ? `<Command>wscript.exe</Command><Arguments>//B "${vbs}" "x"</Arguments>` : '', status: m.ficheros.has(vbs) ? 0 : 1 } : r; })(m.sis.ejecutar);
  programar({ accion: 'aplicar', root: RAIZ.win32, sistema: m.sis });
  programar({ accion: 'aplicar', root: RAIZ.win32, sistema: m.sis });
  const creates = m.comandos.filter((x) => x.startsWith('schtasks /Create'));
  assert.equal(creates[0], creates[1]);
  assert.equal(m.ficheros.size, 1);
  programar({ accion: 'quitar', root: RAIZ.win32, sistema: m.sis });
  assert.equal(m.ficheros.size, 0);
  assert.deepEqual(m.dirsBorrados, ['C:\\Users\\María José\\AppData\\Local\\okf-revisor']);
  assert.ok(m.comandos.includes(`schtasks /Delete /TN ${NOMBRE} /F`));
  const n = simulado('win32', { fallan: ['schtasks /Query'] });
  programar({ accion: 'estado', root: RAIZ.win32, sistema: n.sis });
  assert.match(n.salida[0], /^No programado/);
  const s = simulado('win32', { salidas: { 'schtasks /Query': 'C:\\Users\\María José\\AppData\\Local\\okf-revisor\\okf-revisor.vbs\nTaskName: \\okf-revisor\nLast Run Time: 08/11/2026 10:00:00\nOther: x\n' } });
  programar({ accion: 'estado', root: RAIZ.win32, sistema: s.sis });
  assert.match(s.salida[0], /^Programado/);
  assert.ok(s.salida.some((l) => l.includes('Last Run Time')));
  assert.ok(!s.salida.some((l) => l.includes('Other')));
});

test('--dry-run no ejecuta ni escribe nada pero lo cuenta (los 3 SO)', () => {
  for (const so of ['linux', 'darwin', 'win32']) {
    const m = simulado(so);
    programar({ accion: 'aplicar', root: RAIZ[so], sistema: m.sis, dryRun: true });
    assert.equal(m.ficheros.size, 0, so);
    assert.deepEqual(m.comandos.filter((c) => !c.startsWith('schtasks /Query')), [], so); // la consulta es de solo lectura
    assert.ok(m.salida.some((l) => l.startsWith('--- escribiría')), so);
    assert.ok(m.salida.some((l) => l.startsWith('$ ')), so);
  }
});

test('--dry-run --quitar no borra', () => {
  const m = simulado('linux');
  programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis });
  const antes = m.comandos.length;
  programar({ accion: 'quitar', root: RAIZ.linux, sistema: m.sis, dryRun: true });
  assert.equal(m.ficheros.size, 2);
  assert.equal(m.comandos.length, antes);
});

test('plataforma desconocida: error', () => {
  const m = simulado('linux');
  m.sis.plataforma = 'plan9';
  assert.throws(() => programar({ accion: 'estado', root: '/x', sistema: m.sis }), /sin soporte/);
});

test('CLI real con --dry-run --aplicar no escribe en el home', () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'okf-prog-'));
  const r = spawnSync(process.execPath, [path.join(aqui, 'okf-programar.mjs'), '--dry-run', '--aplicar', '--root', home], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('--- escribiría') || r.stdout.includes('$ '));
  assert.deepEqual(fs.readdirSync(home), []);
});

test('D2: $ en la ruta se duplica en ExecStart pero no en Environment', () => {
  const m = simulado('linux');
  programar({ accion: 'aplicar', root: '/home/x/$HOME/c', sistema: m.sis });
  const svc = [...m.ficheros.values()][0];
  assert.ok(svc.includes('--root "/home/x/$$HOME/c"'));
  assert.ok(svc.includes('Environment="OKF_ROOT=/home/x/$HOME/c"'));
});

test('Mac: bootstrap se reintenta con espera si falla tras el bootout', () => {
  const m = simulado('darwin', { fallosPor: { 'launchctl bootstrap': 2 } });
  programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: m.sis });
  assert.equal(m.comandos.filter((c) => c.startsWith('launchctl bootstrap')).length, 3);
  assert.deepEqual(m.esperas, [1000, 1000]);
  const n = simulado('darwin', { fallosPor: { 'launchctl bootstrap': 99 } });
  assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: n.sis }), /bootstrap/);
  assert.equal(n.comandos.filter((c) => c.startsWith('launchctl bootstrap')).length, 5);
});

test('--dry-run: los mensajes finales dicen (simulado)', () => {
  for (const so of ['linux', 'darwin', 'win32']) {
    const m = simulado(so);
    programar({ accion: 'aplicar', root: RAIZ[so], sistema: m.sis, dryRun: true });
    assert.match(m.salida[m.salida.length - 1], /\(simulado\)$/, so);
  }
});

// --- Colisiones: nada ajeno se pisa ni se borra sin --forzar ---------------------------
const DIR_L = '/home/maría josé/.config/systemd/user';
const AJENOS = {
  linux: { ruta: `${DIR_L}/okf-revisor.service`, rutaTimer: `${DIR_L}/okf-revisor.timer` },
  darwin: { ruta: `/Users/maría josé/Library/LaunchAgents/${ETIQUETA_MAC}.plist` },
};

test('Linux: symlink ajeno aborta sin escribir ni ejecutar nada', () => {
  const m = simulado('linux', { pre: { [AJENOS.linux.ruta]: 'x' }, symlinks: [AJENOS.linux.ruta] });
  assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis }), /enlace simbólico.*--forzar/);
  assert.equal(m.ficheros.size, 0);
  assert.equal(m.comandos.length, 0);
});

test('Linux: fichero ajeno sin marca aborta, también en --dry-run', () => {
  for (const dryRun of [false, true]) {
    const m = simulado('linux', { pre: { [AJENOS.linux.rutaTimer]: '[Timer]\n' } });
    assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis, dryRun }), /no lleva la marca/);
    assert.equal(m.ficheros.size, 0);
    assert.equal(m.salida.length, 0);
  }
});

test('Linux: ajeno + --forzar lo sustituye (quita el symlink antes de escribir)', () => {
  const m = simulado('linux', { pre: { [AJENOS.linux.ruta]: 'x' }, symlinks: [AJENOS.linux.ruta] });
  programar({ accion: 'aplicar', root: RAIZ.linux, sistema: m.sis, forzar: true });
  assert.equal(m.symlinks.length, 0);
  assert.ok(m.ficheros.get(AJENOS.linux.ruta).includes(MARCA));
  assert.equal(m.ficheros.size, 2);
});

test('Linux: --quitar sobre ajeno no borra ni ejecuta; con --forzar sí', () => {
  const m = simulado('linux', { pre: { [AJENOS.linux.ruta]: 'x' }, symlinks: [AJENOS.linux.ruta] });
  assert.throws(() => programar({ accion: 'quitar', root: RAIZ.linux, sistema: m.sis }), /No lo borro/);
  assert.ok(AJENOS.linux.ruta in m.pre);
  assert.equal(m.comandos.length, 0);
  programar({ accion: 'quitar', root: RAIZ.linux, sistema: m.sis, forzar: true });
  assert.ok(!(AJENOS.linux.ruta in m.pre));
});

test('Linux: --quitar sin nada instalado no ejecuta systemctl', () => {
  const m = simulado('linux');
  programar({ accion: 'quitar', root: RAIZ.linux, sistema: m.sis });
  assert.equal(m.comandos.length, 0);
});

test('Mac: plist ajeno aborta, --quitar tampoco lo borra, --forzar lo sustituye', () => {
  const m = simulado('darwin', { pre: { [AJENOS.darwin.ruta]: '<plist/>' } });
  assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: m.sis }), /no lleva la marca/);
  assert.throws(() => programar({ accion: 'quitar', root: RAIZ.darwin, sistema: m.sis }), /No lo borro/);
  assert.equal(m.comandos.length, 0);
  programar({ accion: 'aplicar', root: RAIZ.darwin, sistema: m.sis, forzar: true });
  assert.ok(m.ficheros.get(AJENOS.darwin.ruta).includes(MARCA));
});

test('Windows: tarea ajena aborta (no es la de nuestro .vbs), --quitar no la borra, --forzar sí', () => {
  const salidas = { 'schtasks /Query': '<Command>C:\\otra\\cosa.exe</Command>' };
  const m = simulado('win32', { salidas });
  assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.win32, sistema: m.sis }), /Ya hay una tarea/);
  assert.throws(() => programar({ accion: 'quitar', root: RAIZ.win32, sistema: m.sis }), /No la borro/);
  assert.ok(!m.comandos.some((c) => /\/Create|\/Delete/.test(c)));
  assert.equal(m.ficheros.size, 0);
  programar({ accion: 'aplicar', root: RAIZ.win32, sistema: m.sis, forzar: true });
  assert.ok(m.comandos.some((c) => c.startsWith('schtasks /Create')));
});

test('Windows: .vbs ajeno sin marca aborta', () => {
  const vbs = 'C:\\Users\\María José\\AppData\\Local\\okf-revisor\\okf-revisor.vbs';
  const m = simulado('win32', { fallan: ['schtasks /Query'], pre: { [vbs]: 'MsgBox 1' } });
  assert.throws(() => programar({ accion: 'aplicar', root: RAIZ.win32, sistema: m.sis }), /no lleva la marca/);
  assert.ok(!m.comandos.some((c) => c.startsWith('schtasks /Create')));
});

// escribir/leer/borrar REALES (con BOM UTF-16 de verdad) sobre un directorio temporal: las rutas
// win32 se proyectan dentro de él para no crear ficheros con `\` en el cwd de Linux.
test('Windows: escribir/leer reales — aplicar, aplicar, quitar sin abortar (el .vbs UTF-16 se reconoce)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'okf-win-'));
  const real = sistemaReal();
  const m = (r) => path.join(tmp, r.replace(/\\/g, '/').replace(':', ''));
  const vbsWin = 'C:\\Users\\María & José\\AppData\\Local\\okf-revisor\\okf-revisor.vbs';
  const comandos = [];
  let tarea = false;
  const sis = {
    ...real, plataforma: 'win32', home: 'C:\\Users\\María & José', node: 'C:\\Program Files\\nodejs\\node.exe', revisor: 'C:\\Kit Ñ\\okf\\okf-revisor.mjs',
    escribir: (r, t, o) => real.escribir(m(r), t, o), leer: (r) => real.leer(m(r)), borrar: (r) => real.borrar(m(r)),
    borrarDir: (r) => real.borrarDir(m(r)), existe: (r) => real.existe(m(r)), esSymlink: (r) => real.esSymlink(m(r)),
    simulado: false, imprimir: () => {},
    ejecutar(cmd, args) {
      comandos.push([cmd, ...args].join(' '));
      if (args[0] === '/Create') tarea = true;
      if (args[0] === '/Delete') tarea = false;
      return { status: 0, stdout: '', stderr: '' };
    },
    consultar(cmd, args) {
      if (!tarea) return { status: 1, stdout: '', stderr: '' };
      // El XML real escapa & y no respeta mayúsculas.
      return { status: 0, stdout: `<Arguments>//B "${vbsWin.toUpperCase().replace(/&/g, '&amp;')}"</Arguments>`, stderr: '' };
    },
  };
  try {
    const root = 'C:\\Users\\María & José\\Mi Cerebro';
    programar({ accion: 'aplicar', root, sistema: sis });
    const bytes = fs.readFileSync(m(vbsWin));
    assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xfe);
    assert.ok(sis.leer(vbsWin).includes(MARCA));
    programar({ accion: 'aplicar', root, sistema: sis });
    assert.ok(fs.existsSync(m(vbsWin)));
    programar({ accion: 'quitar', root, sistema: sis });
    assert.ok(!fs.existsSync(m(vbsWin)));
    assert.ok(!fs.existsSync(path.dirname(m(vbsWin))));
    assert.equal(tarea, false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('leer real: UTF-8 con BOM y UTF-16LE', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'okf-bom-'));
  const real = sistemaReal();
  try {
    fs.writeFileSync(path.join(tmp, 'a'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ñ x')]));
    assert.equal(real.leer(path.join(tmp, 'a')), 'ñ x');
    real.escribir(path.join(tmp, 'b'), 'ñ y', { utf16le: true });
    assert.equal(real.leer(path.join(tmp, 'b')), 'ñ y');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
