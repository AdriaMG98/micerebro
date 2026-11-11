// Tests de `cerebro curar --candidatos`: tres casos sembrados (duplicada, caducada, enlace roto).
// Uso: node --test cerebro-curar.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cerebroCli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cerebro.mjs');
const hoy = new Date().toISOString().slice(0, 10);
const haceDiezDias = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

function escribir(root, rel, texto) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
}
const ficha = (tipo, titulo, desc, fecha, cuerpo = 'Cuerpo.') => `---\ntype: ${tipo}\ntitle: "${titulo}"\ndescription: "${desc}"\nstatus: stable\nactualizado: ${fecha}\n---\n\n${cuerpo}\n`;

function cerebro() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-curar-'));
  escribir(root, 'cerebro.config.json', '{}');
  // par duplicado (misma fecha)
  escribir(root, 'memoria/a-regar.md', ficha('aprendizaje', 'Regar los tomates por la mañana', 'Regar tomates por la mañana evita el moho', hoy));
  escribir(root, 'memoria/b-regar.md', ficha('aprendizaje', 'Regar tomates por la mañana', 'Los tomates se riegan por la mañana para evitar moho', hoy));
  // caducada
  escribir(root, 'memoria/vieja.md', ficha('nota', 'Contraseña del trastero', 'Código viejo del candado', '2020-01-01'));
  // enlace roto (y uno bueno, uno externo, uno en código)
  escribir(root, 'memoria/enlaza.md', ficha('nota', 'Mapa de la casa', 'Plano con enlaces', hoy, 'Ver [bueno](vieja.md), [roto](no-existe.md), [web](https://x.org/a.md) y `[falso](nada.md)`.'));
  // no candidatas: borrador y archivo
  escribir(root, 'memoria/borradores/dup.md', ficha('aprendizaje', 'Regar los tomates por la mañana', 'Regar tomates por la mañana evita el moho', '2020-01-01', '[x](nada.md)'));
  escribir(root, 'archivo/viejo.md', ficha('nota', 'Archivada', 'Cosa archivada', '2019-01-01', '[x](nada.md)'));
  // contradicción: mismo tema, fechas distintas
  escribir(root, 'memoria/precio-1.md', ficha('decision', 'Tarifa mensual del hosting', 'Tarifa mensual del hosting es de diez euros', hoy));
  escribir(root, 'memoria/precio-2.md', ficha('decision', 'Tarifa mensual del hosting', 'Tarifa mensual del hosting es de quince euros', haceDiezDias));
  return root;
}

function curar(root, ...extra) {
  const r = spawnSync(process.execPath, [cerebroCli, 'curar', '--candidatos', ...extra, '--root', root], { encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

function huella(root) {
  const h = crypto.createHash('sha256');
  const ir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) ir(f); else h.update(f).update(fs.readFileSync(f));
    }
  };
  ir(root);
  return h.digest('hex');
}

test('curar --candidatos en JSON: duplicada, contradicción, caducada y enlace roto; sin borradores ni archivo', () => {
  const root = cerebro();
  const antes = huella(root);
  const r = curar(root, '--json');
  assert.equal(r.status, 0, r.err);
  const lista = JSON.parse(r.out);
  for (const x of lista) assert.deepEqual(Object.keys(x).sort(), ['motivo', 'notas', 'tipo']);
  const de = (tipo) => lista.filter((x) => x.tipo === tipo);
  assert.deepEqual(de('duplicada').map((x) => x.notas), [['memoria/a-regar.md', 'memoria/b-regar.md']]);
  assert.deepEqual(de('contradiccion').map((x) => x.notas), [['memoria/precio-1.md', 'memoria/precio-2.md']]);
  assert.deepEqual(de('caducada').map((x) => x.notas), [['memoria/vieja.md']]);
  assert.deepEqual(de('enlace-roto').map((x) => x.notas), [['memoria/enlaza.md']]);
  assert.match(de('enlace-roto')[0].motivo, /no-existe\.md/);
  assert.ok(!JSON.stringify(lista).includes('borradores') && !JSON.stringify(lista).includes('archivo/'));
  assert.equal(huella(root), antes, 'solo lee: no escribe nada');
});

test('curar --candidatos legible y sin candidatas: «Nada que revisar»', () => {
  const r = curar(cerebro());
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /\[duplicada\] memoria\/a-regar\.md  <->  memoria\/b-regar\.md/);
  assert.match(r.out, /\[caducada\] memoria\/vieja\.md/);
  assert.match(r.out, /\[enlace-roto\] memoria\/enlaza\.md/);
  assert.match(r.out, /Total: 1 duplicadas, 1 contradicciones, 1 caducadas, 1 enlaces rotos\./);
  const limpio = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-curar-'));
  escribir(limpio, 'cerebro.config.json', '{}');
  escribir(limpio, 'memoria/solo.md', ficha('nota', 'Una sola', 'Nota única y reciente', hoy));
  assert.match(curar(limpio).out, /Nada que revisar/);
  assert.deepEqual(JSON.parse(curar(limpio, '--json').out), []);
});

test('curar sin --candidatos da el uso', () => {
  const r = spawnSync(process.execPath, [cerebroCli, 'curar', '--root', cerebro()], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uso: cerebro curar --candidatos/);
});
