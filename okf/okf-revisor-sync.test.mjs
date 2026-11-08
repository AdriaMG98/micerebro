// Tests de la sincronización git del revisor: commit solo con cambios, push solo con
// remoto + upstream y a la rama actual, y opción para desactivar el commit.
// Uso: node --test okf-revisor-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const revisor = path.join(aqui, 'okf-revisor.mjs');
const hoy = new Date().toISOString().slice(0, 10);
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function escribir(root, rel, texto) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
}

function cerebro({ borrador = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-sync-')));
  escribir(root, 'log.md', '# Log\n');
  escribir(root, 'memoria/index.md', '# Memoria\n');
  if (borrador) escribir(root, 'memoria/borradores/idea.md', `---\ntype: nota\ntitle: "Idea"\ndescription: "Una idea"\nstatus: draft\nactualizado: ${hoy}\n---\n\nCuerpo.\n`);
  git(root, 'init', '-q', '-b', 'trabajo');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'inicial');
  return root;
}

function correr(root, ...args) {
  const r = spawnSync(process.execPath, [revisor, ...args], { cwd: root, env: { ...process.env, ...GIT_ENV, OKF_ROOT: root }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('commit con cambios, sin remoto: no empuja', () => {
  const root = cerebro();
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.match(out, /sin remoto configurado/);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('sin cambios no commitea', () => {
  const root = cerebro({ borrador: false });
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.match(out, /sin cambios que subir/);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
});

test('--no-commit y OKF_REVISOR_COMMIT=0 promueven pero no tocan git', () => {
  for (const modo of ['flag', 'env']) {
    const root = cerebro();
    const r = spawnSync(process.execPath, [revisor, ...(modo === 'flag' ? ['--no-commit'] : [])], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, OKF_ROOT: root, ...(modo === 'env' ? { OKF_REVISOR_COMMIT: '0' } : {}) },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(root, 'memoria/idea.md')));
    assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
    assert.notEqual(git(root, 'status', '--porcelain'), '');
  }
});

test('con remoto y upstream: push normal de la rama actual (no cose HEAD:main)', () => {
  const root = cerebro();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-sync-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'trabajo');
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.match(out, /commit y push hechos/);
  assert.equal(git(bare, 'rev-parse', 'trabajo'), git(root, 'rev-parse', 'HEAD'));
  const ramas = git(bare, 'branch', '--format=%(refname:short)').split('\n');
  assert.deepEqual(ramas, ['trabajo']); // main no existe en el remoto
});

test('con remoto pero sin upstream: commit sí, push no, y no es un error', () => {
  const root = cerebro();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-sync-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'remote', 'add', 'origin', bare);
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.match(out, /no tiene upstream/);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(git(bare, 'branch', '--list').trim(), '');
});

test('--no-push: commit sin subir aunque haya upstream', () => {
  const root = cerebro();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-sync-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'trabajo');
  const { code, out } = correr(root, '--no-push');
  assert.equal(code, 0, out);
  assert.match(out, /push desactivado/);
  assert.notEqual(git(bare, 'rev-parse', 'trabajo'), git(root, 'rev-parse', 'HEAD'));
});
