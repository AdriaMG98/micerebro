// Tests del revisor con el preset `micerebro`: mini-cerebro en un temporal (sin git: GIT_CEILING_DIRECTORIES).
// Uso: node --test cerebro-revisor-micerebro.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const revisor = path.join(aqui, 'cerebro-revisor.mjs');
const hoy = new Date().toISOString().slice(0, 10);

function escribir(root, rel, texto) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
}
const leer = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const existe = (root, rel) => fs.existsSync(path.join(root, rel));

function borrador(tipo, titulo, desc, cuerpo = 'Cuerpo con tildes: acción, niño, año.') {
  const t = tipo === null ? '' : `type: ${tipo}\n`;
  return `---\n${t}title: "${titulo}"\ndescription: "${desc}"\nstatus: draft\nactualizado: ${hoy}\n---\n\n${cuerpo}\n`;
}

// Cerebro del kit: index/log de la raíz y el index con marcador «Vacío por ahora» de decisiones.
function cerebro() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-revisor-kit-'));
  escribir(root, 'index.md', '---\nokf_version: 0.2\n---\n# MiCerebro\n');
  escribir(root, 'log.md', '# Log\n\n## 2026-11-07\n\n* **Cambio**: algo anterior.\n');
  escribir(root, 'memoria/decisiones/index.md', '# Decisiones\n\nUna nota por decisión.\n\n(Vacío por ahora. Aquí se listan las notas.)\n');
  escribir(root, 'memoria/borradores/dec.md', borrador('decision', 'Elegir cafetera exprés', 'Compramos una cafetera italiana: acción decidida'));
  escribir(root, 'memoria/borradores/apr.md', borrador('aprendizaje', 'Riego de tomates', 'Regar por la mañana evita el moho'));
  escribir(root, 'memoria/borradores/per.md', borrador('persona', 'Ana Gómez', 'Contable de confianza del niño'));
  escribir(root, 'memoria/borradores/not.md', borrador('nota', 'Idea suelta', 'Una idea para el jardín'));
  escribir(root, 'memoria/borradores/mal.md', borrador('inventado', 'Roto', 'Tipo que no existe'));
  return root;
}

function correr(root, ...args) {
  const r = spawnSync(process.execPath, [revisor, ...args], {
    env: { ...process.env, CEREBRO_ROOT: root, GIT_CEILING_DIRECTORIES: path.dirname(root) },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function foto(root) {
  const lista = [];
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) rec(f); else lista.push(`${path.relative(root, f)}\n${fs.readFileSync(f, 'utf8')}`); } };
  rec(root);
  return lista.sort().join('\n---\n');
}

test('--dry-run no escribe nada y anuncia los destinos', () => {
  const root = cerebro();
  const antes = foto(root);
  const { code, out } = correr(root, '--dry-run');
  assert.equal(code, 0, out);
  assert.equal(foto(root), antes);
  assert.match(out, new RegExp(`PROMOCIONARÍA: memoria/borradores/dec.md → memoria/decisiones/${hoy}-elegir-cafetera-expres.md`));
  assert.match(out, /PROMOCIONARÍA: memoria\/borradores\/per.md → memoria\/personas\/ana-gomez.md/);
  assert.match(out, /DUDOSO: memoria\/borradores\/mal.md — R1 — type inválido: inventado/);
});

test('decision, aprendizaje, persona y nota van a su sitio con index.md y log.md', () => {
  const root = cerebro();
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  const d = `memoria/decisiones/${hoy}-elegir-cafetera-expres.md`;
  const a = `memoria/aprendizajes/${hoy}-riego-de-tomates.md`;
  for (const rel of [d, a, 'memoria/personas/ana-gomez.md', 'memoria/idea-suelta.md']) assert.ok(existe(root, rel), rel);
  for (const b of ['dec', 'apr', 'per', 'not']) assert.ok(!existe(root, `memoria/borradores/${b}.md`));
  // status: stable y tildes intactas
  assert.match(leer(root, d), /^---\ntype: decision\ntitle: "Elegir cafetera exprés"\n[\s\S]*status: stable\n/);
  assert.match(leer(root, 'memoria/personas/ana-gomez.md'), /Contable de confianza del niño/);
  assert.match(leer(root, 'memoria/personas/ana-gomez.md'), /acción, niño, año/);
  // index.md: el de decisiones conserva su texto, pierde el marcador y gana la línea; los demás se crean sin ficha
  const idx = leer(root, 'memoria/decisiones/index.md');
  assert.ok(idx.includes(`* [Elegir cafetera exprés](${hoy}-elegir-cafetera-expres.md) - Compramos una cafetera italiana: acción decidida`));
  assert.ok(!idx.includes('Vacío por ahora') && idx.includes('Una nota por decisión.'));
  assert.equal(leer(root, 'memoria/personas/index.md'), '# Personas\n\n* [Ana Gómez](ana-gomez.md) - Contable de confianza del niño\n');
  assert.ok(leer(root, 'memoria/index.md').includes('* [Idea suelta](idea-suelta.md) - Una idea para el jardín'));
  // log.md: cabecera de hoy arriba (tras el título), entradas Creación, lo anterior intacto
  const log = leer(root, 'log.md');
  assert.ok(log.startsWith(`# Log\n\n## ${hoy}\n\n* **Creación**: `), log);
  assert.ok(log.includes(`* **Creación**: \`${d}\` — Compramos una cafetera italiana: acción decidida`));
  assert.ok(log.includes('* **Creación**: `memoria/personas/ana-gomez.md` — Contable de confianza del niño'));
  assert.ok(log.endsWith('## 2026-11-07\n\n* **Cambio**: algo anterior.\n'), log);
  assert.equal(log.split(`## ${hoy}`).length, 2);
  // el inválido se queda, con su motivo en la salida y sin ficheros nuevos
  assert.ok(existe(root, 'memoria/borradores/mal.md'));
  assert.match(out, /DUDOSO: memoria\/borradores\/mal.md — R1 — type inválido: inventado/);
  assert.match(out, /4 promocionados, 1 dudosos/);
});

test('segunda pasada idempotente', () => {
  const root = cerebro();
  correr(root);
  const antes = foto(root);
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.equal(foto(root), antes);
  assert.match(out, /0 promocionados, 1 dudosos/);
});

test('nunca pisa un fichero existente: sufijo -2, y la cabecera de hoy ya presente se reutiliza', () => {
  const root = cerebro();
  escribir(root, 'memoria/personas/ana-gomez.md', 'otra Ana\n');
  escribir(root, 'log.md', `# Log\n\n## ${hoy}\n\n* **Cambio**: previo.\n\n## 2026-11-07\n\n* **Cambio**: antiguo.\n`);
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.equal(leer(root, 'memoria/personas/ana-gomez.md'), 'otra Ana\n');
  assert.ok(existe(root, 'memoria/personas/ana-gomez-2.md'));
  const log = leer(root, 'log.md');
  assert.equal(log.split(`## ${hoy}`).length, 2);
  assert.ok(log.indexOf('previo.') < log.indexOf('ana-gomez-2.md') && log.indexOf('ana-gomez-2.md') < log.indexOf('## 2026-11-07'), log);
});

test('sin index.md ni log.md se crean; un borrador sin ficha se queda', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-revisor-kit-'));
  escribir(root, 'memoria/borradores/a.md', borrador('decision', 'Mudanza', 'Nos mudamos'));
  escribir(root, 'memoria/borradores/sinficha.md', 'solo texto\n');
  const { code, out } = correr(root);
  assert.equal(code, 0, out);
  assert.ok(leer(root, 'log.md').startsWith(`# Log\n\n## ${hoy}\n\n* **Creación**`));
  assert.ok(leer(root, 'memoria/decisiones/index.md').startsWith('# Decisiones\n\n* [Mudanza]('));
  assert.ok(existe(root, 'memoria/borradores/sinficha.md'));
  assert.match(out, /DUDOSO: memoria\/borradores\/sinficha.md — R1 — sin frontmatter/);
});
