// Tests del guardado directo (guardar.modo "directo", el de por defecto en micerebro) y de que el
// revisor sigue sirviendo a quien use el modo "borrador". Mini-cerebro en un temporal.
// Uso: node --test cerebro-directo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cargarConfig } from './cerebro-config.mjs';
import { guardarDirecto } from './cerebro-promover.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const cerebroCli = path.join(aqui, 'cerebro.mjs');
const mcp = path.join(aqui, 'cerebro-mcp.mjs');
const revisor = path.join(aqui, 'cerebro-revisor.mjs');
const hoy = new Date().toISOString().slice(0, 10);

function cerebro(config = '{}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-directo-'));
  fs.writeFileSync(path.join(root, 'cerebro.config.json'), config);
  fs.writeFileSync(path.join(root, 'index.md'), '---\nokf_version: 0.2\n---\n# MiCerebro\n');
  return root;
}

function cli(root, args, input) {
  const r = spawnSync(process.execPath, [cerebroCli, ...args, '--root', root], { encoding: 'utf8', input });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

function listar(dir) {
  const out = [];
  const ir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) ir(f); else out.push(path.relative(dir, f));
    }
  };
  ir(dir);
  return out.sort();
}

test('el modo por defecto del preset micerebro es directo; "borrador" e "indice" siguen válidos y otro valor falla', () => {
  assert.equal(cargarConfig(cerebro()).guardar.modo, 'directo');
  assert.equal(cargarConfig(cerebro('{"guardar":{"modo":"borrador"}}')).guardar.modo, 'borrador');
  assert.throws(() => cargarConfig(cerebro('{"guardar":{"modo":"zzz"}}')), /"indice", "borrador" o "directo"/);
});

test('guardar directo: la nota queda en su carpeta, con index.md y log.md, y buscar la encuentra al instante', () => {
  const root = cerebro();
  const r = cli(root, ['guardar', 'aprendizaje', 'Cómo regar higueras', '--body', '-'], 'Regar poco: la higuera es áspera con el exceso de agua.\n');
  assert.equal(r.status, 0, r.err);
  const f = path.join(root, 'memoria/aprendizajes', `${hoy}-como-regar-higueras.md`);
  assert.ok(r.out.includes(f), `el mensaje trae la ruta absoluta: ${r.out}`);
  assert.doesNotMatch(r.out, /borrador/);
  const txt = fs.readFileSync(f, 'utf8');
  assert.match(txt, /^---\ntype: aprendizaje\ntitle: "Cómo regar higueras"\n/);
  assert.match(txt, /\nstatus: stable\n/);
  assert.match(fs.readFileSync(path.join(root, 'memoria/aprendizajes/index.md'), 'utf8'), /\* \[Cómo regar higueras\]\(.*higueras\.md\) - Regar poco/);
  assert.match(fs.readFileSync(path.join(root, 'log.md'), 'utf8'), new RegExp(`## ${hoy}\\n\\n\\* \\*\\*Creación\\*\\*: \`memoria/aprendizajes/`));
  assert.ok(!fs.existsSync(path.join(root, 'memoria/borradores')));
  const b = cli(root, ['buscar', 'regar higueras']);
  assert.match(b.out, /como-regar-higueras/);
  assert.doesNotMatch(b.out, /0 aciertos/);
});

test('guardar directo: ficha inválida → error por stderr, código ≠ 0 y nada en disco', () => {
  const root = cerebro();
  const antes = listar(root);
  const r = cli(root, ['guardar', 'nota', '   ', '--body', 'texto']);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /ficha inválida, no se ha guardado nada: R1 — falta title/);
  assert.deepEqual(listar(root), antes);
  // la misma validación en la API: un type fuera del kit tampoco escribe nada
  const cfg = cargarConfig(root);
  assert.throws(() => guardarDirecto(root, cfg, { tipo: 'inventado', titulo: 'X', cuerpo: 'y', fecha: hoy }), /type inválido: inventado/);
  assert.throws(() => guardarDirecto(root, cfg, { tipo: 'nota', titulo: 'X', cuerpo: 'y', fecha: '2026-13-45' }), /actualizado inválido/);
  assert.deepEqual(listar(root), antes);
});

test('guardar directo: mismo slug no pisa nada, añade -2, -3 (como los borradores) y ambos quedan indexados', () => {
  const root = cerebro();
  for (let i = 0; i < 3; i++) assert.equal(cli(root, ['guardar', 'nota', 'Idea suelta', '--body', `Versión ${i}`]).status, 0);
  assert.deepEqual(listar(path.join(root, 'memoria')).filter((f) => f !== 'index.md'), ['idea-suelta-2.md', 'idea-suelta-3.md', 'idea-suelta.md']);
  assert.match(fs.readFileSync(path.join(root, 'memoria/idea-suelta.md'), 'utf8'), /Versión 0/);
  assert.equal((fs.readFileSync(path.join(root, 'memoria/index.md'), 'utf8').match(/^\* \[/gm) || []).length, 3);
});

function llamarMcp(root, name, args) {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [mcp], { env: { ...process.env, CEREBRO_ROOT: root }, input: msgs, encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === 2).result;
}

test('cerebro_guardar del MCP en modo directo: texto con la ruta absoluta, sin decir «borrador», y buscable', () => {
  const root = cerebro();
  const res = llamarMcp(root, 'cerebro_guardar', { tipo: 'decision', titulo: 'Usar pizarra', cuerpo: 'Decidimos usar una pizarra blanca.' });
  assert.ok(!res.isError, JSON.stringify(res));
  const f = path.join(root, 'memoria/decisiones', `${hoy}-usar-pizarra.md`);
  assert.ok(res.content[0].text.includes(f));
  assert.match(res.content[0].text, /^MiCerebro: guardado /);
  assert.doesNotMatch(res.content[0].text, /borrador/);
  assert.ok(fs.existsSync(f));
  assert.match(llamarMcp(root, 'cerebro_buscar', { pregunta: 'pizarra blanca' }).content[0].text, /usar-pizarra/);
});

test('modo borrador: guardar deja borrador y el revisor lo promueve (mismo resultado que antes)', () => {
  const root = cerebro('{"guardar":{"modo":"borrador"}}');
  const r = cli(root, ['guardar', 'decision', 'Elegir cafetera', '--body', 'Compramos una cafetera italiana.']);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /borrador guardado memoria\/borradores\/elegir-cafetera\.md/);
  assert.deepEqual(listar(root).filter((f) => f.startsWith('memoria')), ['memoria/borradores/elegir-cafetera.md']);
  const v = spawnSync(process.execPath, [revisor, '--no-commit'], { env: { ...process.env, CEREBRO_ROOT: root, GIT_CEILING_DIRECTORIES: path.dirname(root) }, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /PROMOCIONADO: memoria\/borradores\/elegir-cafetera\.md → memoria\/decisiones\/.*elegir-cafetera\.md/);
  assert.deepEqual(listar(root).filter((f) => f.startsWith('memoria')), [`memoria/decisiones/${hoy}-elegir-cafetera.md`, 'memoria/decisiones/index.md']);
  assert.match(fs.readFileSync(path.join(root, 'log.md'), 'utf8'), /\*\*Creación\*\*/);
});
