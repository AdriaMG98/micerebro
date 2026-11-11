// Tests de instalar-enchufe.mjs con un `hermes` FALSO (un script que simula `config path/get/set`
// sobre un JSON y registra las llamadas). Ejecutar: node --test instalar-enchufe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const INSTALADOR = path.join(AQUI, 'instalar-enchufe.mjs');

const FALSO = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const home = process.env.FAKE_HOME, args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'llamadas.log'), JSON.stringify(args) + '\\n');
const cfg = path.join(home, 'config.yaml'), env = path.join(home, '.env');
const leer = () => (fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8') || '{}') : {});
const camino = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
if (args[0] === 'config' && args[1] === 'path') console.log(cfg);
else if (args[0] === 'config' && args[1] === 'get') {
  const v = camino(leer(), args[2]);
  if (v === undefined) { console.error('Config key not set: ' + args[2]); process.exit(1); }
  console.log(JSON.stringify(v));
} else if (args[0] === 'config' && args[1] === 'set') {
  const [k, raw] = [args[2], args[3]];
  if (/^[A-Z][A-Z0-9_]*$/.test(k)) {
    const q = /[\\s"'#]/.test(raw) ? '"' + raw.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"' : raw;
    const l = (fs.existsSync(env) ? fs.readFileSync(env, 'utf8').split('\\n') : []).filter((x) => x && !x.startsWith(k + '='));
    fs.writeFileSync(env, [...l, k + '=' + q].join('\\n') + '\\n');
  } else {
    let v = raw; if (/^[\\[{]/.test(raw) || raw === 'false' || raw === 'true') v = JSON.parse(raw);
    const o = leer(); const ps = k.split('.'); let c = o;
    for (const p of ps.slice(0, -1)) c = c[p] = c[p] || {};
    c[ps.at(-1)] = v; fs.writeFileSync(cfg, JSON.stringify(o, null, 1));
  }
  console.log('ok');
} else process.exit(3);
`;

function entorno({ cerebroNombre = 'cerebro', config } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'enchufe-test-'));
  const home = path.join(raiz, 'datos hermes');
  fs.mkdirSync(home);
  if (config) fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(config));
  const falso = path.join(raiz, 'hermes-falso');
  fs.writeFileSync(falso, FALSO, { mode: 0o755 });
  const cerebro = path.join(raiz, cerebroNombre);
  fs.mkdirSync(path.join(cerebro, '.okf', 'okf'), { recursive: true });
  for (const f of ['okf.mjs', 'okf-mcp.mjs']) fs.writeFileSync(path.join(cerebro, '.okf', 'okf', f), '');
  const correr = (...extra) => {
    const r = spawnSync(process.execPath, [INSTALADOR, '--cerebro', cerebro, '--hermes', falso, ...extra],
      { encoding: 'utf8', env: { ...process.env, FAKE_HOME: home } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const leerCfg = () => JSON.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'));
  const sets = () => (fs.existsSync(path.join(home, 'llamadas.log'))
    ? fs.readFileSync(path.join(home, 'llamadas.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[1] === 'set')
    : []);
  return { raiz, home, cerebro, correr, leerCfg, sets, limpiar: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

const posix = (p) => p.replace(/\\/g, '/');

test('ensayo: no cambia nada', () => {
  const e = entorno({ config: { model: { provider: 'nvidia' } } });
  const antes = fs.readFileSync(path.join(e.home, 'config.yaml'), 'utf8');
  const r = e.correr();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Modo: ensayo/);
  assert.match(r.out, /se pondría: memory\.provider = "enchufe"/);
  assert.equal(fs.readFileSync(path.join(e.home, 'config.yaml'), 'utf8'), antes);
  assert.equal(e.sets().length, 0);
  assert.ok(!fs.existsSync(path.join(e.home, 'plugins')));
  assert.ok(!fs.existsSync(path.join(e.home, 'backups')));
  assert.ok(!fs.existsSync(path.join(e.home, '.env')));
  e.limpiar();
});

test('aplicar dos veces: la segunda es «ya estaba» y no escribe', () => {
  const e = entorno({ config: {} });
  const r1 = e.correr('--aplicar');
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /Hecho\. Ahora: hermes gateway restart/);
  const c = e.leerCfg();
  const cer = posix(e.cerebro);
  assert.equal(c.memory.provider, 'enchufe');
  assert.deepEqual(c.mcp_servers.okf, { command: posix(process.execPath), args: [`${cer}/.okf/okf/okf-mcp.mjs`], env: { OKF_ROOT: cer } });
  assert.deepEqual(c.skills.external_dirs, [`${cer}/.hermes/skills`]);
  assert.equal(c.skills.create_dir, `${cer}/.hermes/skills`);
  assert.deepEqual(c.plugins.enabled, ['vigilante-contexto']);
  const env = fs.readFileSync(path.join(e.home, '.env'), 'utf8');
  assert.match(env, new RegExp(`^OKF_ROOT=${cer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(fs.lstatSync(path.join(e.home, 'plugins', 'enchufe')).isSymbolicLink());
  assert.ok(fs.readdirSync(path.join(e.home, 'backups')).some((d) => d.startsWith('enchufe-')));
  assert.ok(!fs.readFileSync(path.join(e.home, 'config.yaml'), 'utf8').includes('RUTA-DE-TU-CEREBRO'));

  const n = e.sets().length;
  const r2 = e.correr('--aplicar');
  assert.equal(r2.code, 0, r2.err);
  assert.equal(e.sets().length, n, 'la segunda pasada no debe llamar a config set');
  assert.equal((r2.out.match(/^ya estaba:/gm) || []).length, 9);
  assert.doesNotMatch(r2.out, /^puesto:/m);
  e.limpiar();
});

test('skills.external_dirs y plugins.enabled existentes se conservan', () => {
  const e = entorno({ config: { skills: { external_dirs: ['/otra/carpeta'] }, plugins: { enabled: ['otro-plugin'] } } });
  const r = e.correr('--aplicar');
  assert.equal(r.code, 0, r.err);
  const c = e.leerCfg();
  assert.deepEqual(c.skills.external_dirs, ['/otra/carpeta', `${posix(e.cerebro)}/.hermes/skills`]);
  assert.deepEqual(c.plugins.enabled, ['otro-plugin', 'vigilante-contexto']);
  e.limpiar();
});

test('ruta con espacios: ENCHUFE_OKF_CMD entrecomillado y partible como shell POSIX', () => {
  const e = entorno({ cerebroNombre: 'mi cerebro', config: {} });
  const r = e.correr('--aplicar');
  assert.equal(r.code, 0, r.err);
  const envSet = e.sets().find((a) => a[2] === 'ENCHUFE_OKF_CMD');
  const cer = posix(e.cerebro);
  assert.ok(envSet[3].includes(`"${cer}/.okf/okf/okf.mjs"`), envSet[3]);
  // partido como hace __init__.py (shlex posix): dos tokens, el segundo con el espacio intacto
  const py = spawnSync('python3', ['-c', 'import shlex,sys;print(shlex.split(sys.argv[1],posix=True))', envSet[3]], { encoding: 'utf8' });
  if (py.status === 0) assert.match(py.stdout, /okf\.mjs'\]/), assert.ok(py.stdout.includes('mi cerebro'));
  assert.equal(e.leerCfg().mcp_servers.okf.env.OKF_ROOT, cer);
  assert.equal(e.leerCfg().skills.create_dir, `${cer}/.hermes/skills`);
  // y la segunda pasada reconoce el valor con comillas del .env
  const n = e.sets().length;
  e.correr('--aplicar');
  assert.equal(e.sets().length, n);
  e.limpiar();
});

test('conflicto: plugins/enchufe existe y no apunta al plugin -> no toca nada', () => {
  const e = entorno({ config: {} });
  fs.mkdirSync(path.join(e.home, 'plugins', 'enchufe'), { recursive: true });
  fs.writeFileSync(path.join(e.home, 'plugins', 'enchufe', 'ajeno.txt'), 'mío');
  const r = e.correr('--aplicar');
  assert.equal(r.code, 1);
  assert.match(r.err, /CONFLICTO/);
  assert.equal(e.sets().length, 0);
  assert.ok(!fs.existsSync(path.join(e.home, 'backups')));
  assert.ok(fs.existsSync(path.join(e.home, 'plugins', 'enchufe', 'ajeno.txt')));
  e.limpiar();
});

test('deshacer restaura config.yaml y .env y quita el enlace', () => {
  const e = entorno({ config: { model: { provider: 'nvidia' } } });
  fs.writeFileSync(path.join(e.home, '.env'), 'NVIDIA_API_KEY=abc\n');
  const antesCfg = fs.readFileSync(path.join(e.home, 'config.yaml'), 'utf8');
  const r = e.correr('--aplicar');
  assert.equal(r.code, 0, r.err);
  const backup = path.join(e.home, 'backups', fs.readdirSync(path.join(e.home, 'backups'))[0]);
  const d = spawnSync(process.execPath, [INSTALADOR, '--deshacer', backup], { encoding: 'utf8' });
  assert.equal(d.status, 0, d.stderr);
  assert.equal(fs.readFileSync(path.join(e.home, 'config.yaml'), 'utf8'), antesCfg);
  assert.equal(fs.readFileSync(path.join(e.home, '.env'), 'utf8'), 'NVIDIA_API_KEY=abc\n');
  assert.ok(!fs.existsSync(path.join(e.home, 'plugins', 'enchufe')));
  e.limpiar();
});
