// Tests de cerebro-migrar: origen y cerebro en temporales; se comprueba que el origen no cambia.
// Uso: node --test cerebro-migrar.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { partirLibreta, slug, MAPA_TIPOS, limpiarDescripcion } from './cerebro-migrar.mjs';
import { parseFrontmatter } from './cerebro-comun.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const migrar = path.join(aqui, 'cerebro-migrar.mjs');

function escribir(base, rel, texto) {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
}

function huellas(dir) {
  const out = {};
  const ir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) ir(f);
      else if (e.isFile()) out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  };
  ir(dir);
  return out;
}

// Cerebro con el flujo antiguo: las notas sin carpeta propia caen en borradores/ para el revisor.
function modoBorrador(root) {
  escribir(root, 'cerebro.config.json', '{"guardar":{"modo":"borrador"}}');
}

function ejecutar(args) {
  const r = spawnSync(process.execPath, [migrar, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function escenario() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-migrar-'));
  const root = path.join(base, 'cerebro');
  fs.mkdirSync(root);
  const libreta = path.join(base, 'libreta');
  escribir(libreta, 'MEMORY.md', 'Prefiere respuestas cortas en español\n§\nEl café es descafeinado, ñoño\n§\nTercera\ncon dos líneas\n');
  escribir(libreta, 'USER.md', 'Nombre: María José\n§\nVive en Logroño\n');
  const boveda = path.join(base, 'boveda');
  escribir(boveda, '.obsidian/app.json', '{}');
  escribir(boveda, 'Riego.md', '---\ntype: feedback\ntitle: Riego de tomates\ntags: [huerto]\n---\n# Riego\nVer [[Cafetera]], [[sub/Pozo|el pozo]], [[Nada]] y `[[codigo]]`. ![[foto.png]]\n');
  escribir(boveda, 'Cafetera.md', '# Cafetera\nVuelve a [[Riego]].\n');
  escribir(boveda, 'sub/Pozo.md', '---\ntype: reference\n---\nEl pozo.\n');
  escribir(boveda, 'sub/Huerto.md', '---\ntype: project\n---\nProyecto.\n');
  escribir(boveda, 'sub/Riego.md', 'Otra con el mismo nombre\n');
  fs.writeFileSync(path.join(boveda, 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const planes = path.join(base, 'planes');
  escribir(planes, 'obra.md', '---\nname: Plan de obra\n---\n# Plan\n* [ ] algo\n');
  return { base, root, libreta, boveda, planes };
}

test('partirLibreta: separa por § y respeta tildes', () => {
  assert.deepEqual(partirLibreta('uno ñ\n§\ndos é\n§\n\ntres\n'), ['uno ñ', 'dos é', 'tres']);
  assert.deepEqual(partirLibreta('a § b'), ['a', 'b']);
  assert.deepEqual(partirLibreta(''), []);
});

test('slug y mapa de tipos', () => {
  assert.equal(slug('Café de la Mañana!'), 'cafe-de-la-manana');
  assert.deepEqual([MAPA_TIPOS.user, MAPA_TIPOS.feedback, MAPA_TIPOS.project, MAPA_TIPOS.reference], ['persona', 'aprendizaje', 'proyecto', 'recurso']);
});

test('dry-run no escribe nada y avisa de que es inventario', () => {
  const e = escenario();
  const antes = huellas(e.base);
  for (const [origen, extra] of [[e.libreta, []], [e.boveda, []], [e.planes, ['--tipo', 'planes']]]) {
    const r = ejecutar(['--origen', origen, '--root', e.root, '--dry-run', ...extra]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no se ha escrito nada/);
  }
  assert.deepEqual(fs.readdirSync(e.root), []);
  assert.deepEqual(huellas(e.base), antes);
});

test('libreta (modo borrador): una entrada = un borrador con ficha, USER.md → persona', () => {
  const e = escenario();
  modoBorrador(e.root);
  const r = ejecutar(['--origen', e.libreta, '--root', e.root, '--aplicar', '--hoy', '2026-11-08']);
  assert.equal(r.code, 0, r.err);
  const dir = path.join(e.root, 'memoria/borradores');
  const ficheros = fs.readdirSync(dir).sort();
  assert.equal(ficheros.length, 5);
  const cafe = parseFrontmatter(fs.readFileSync(path.join(dir, 'el-cafe-es-descafeinado-nono.md'), 'utf8'));
  assert.equal(cafe.data.type, 'nota');
  assert.equal(cafe.data.status, 'draft');
  assert.equal(cafe.data.title, 'El café es descafeinado, ñoño');
  const persona = parseFrontmatter(fs.readFileSync(path.join(dir, 'vive-en-logrono.md'), 'utf8'));
  assert.equal(persona.data.type, 'persona');
  assert.equal(persona.data.actualizado, '2026-11-08');
});

test('carpeta Obsidian (modo borrador): tipos, enlaces, adjuntos, conflicto, registro y origen intacto', () => {
  const e = escenario();
  modoBorrador(e.root);
  const antes = huellas(e.base);
  const r = ejecutar(['--origen', e.boveda, '--root', e.root, '--aplicar', '--hoy', '2026-11-08']);
  assert.equal(r.code, 0, r.err);
  const sinCerebro = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith('cerebro')));
  assert.deepEqual(sinCerebro(huellas(e.base)), sinCerebro(antes)); // el origen, byte a byte igual
  const riego = fs.readFileSync(path.join(e.root, 'memoria/borradores/riego.md'), 'utf8');
  const fm = parseFrontmatter(riego);
  assert.equal(fm.data.type, 'aprendizaje'); // feedback
  assert.equal(fm.data.tipo_original, 'feedback');
  assert.equal(fm.data.status, 'draft');
  assert.match(riego, /tags: \[huerto\]/);
  assert.match(riego, /\[Cafetera\]\(cafetera\.md\)/);
  assert.match(riego, /\[el pozo\]\(\.\.\/\.\.\/recursos\/pozo\.md\)/);
  assert.match(riego, /Nada/);
  assert.doesNotMatch(riego, /\[\[Nada/);
  assert.match(riego, /`\[\[codigo\]\]`/); // el código no se toca
  assert.match(riego, /!\[foto\.png\]\(\.\.\/\.\.\/recursos\/adjuntos\/boveda\/foto\.png\)/);
  assert.ok(fs.existsSync(path.join(e.root, 'memoria/borradores/riego-2.md')), 'conflicto → sufijo -2');
  assert.equal(parseFrontmatter(fs.readFileSync(path.join(e.root, 'proyectos/huerto.md'), 'utf8')).data.type, 'proyecto');
  assert.equal(parseFrontmatter(fs.readFileSync(path.join(e.root, 'recursos/pozo.md'), 'utf8')).data.type, 'recurso');
  assert.equal(fs.readFileSync(path.join(e.root, 'recursos/adjuntos/boveda/foto.png')).length, 4);
  assert.ok(!fs.existsSync(path.join(e.root, 'memoria/borradores/app.md')) && !JSON.stringify(huellas(e.root)).includes('obsidian'));
  const reg = fs.readFileSync(path.join(e.root, 'registro/2026-11-08-migrar-boveda.md'), 'utf8');
  assert.equal(parseFrontmatter(reg).data.type, 'registro');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(e.boveda, 'Riego.md'))).digest('hex');
  assert.ok(reg.includes(sha), 'el registro lleva el sha256 del origen');
});

test('planes: .md a planes/ con type plan; segunda aplicación no pisa', () => {
  const e = escenario();
  for (let i = 0; i < 2; i++) assert.equal(ejecutar(['--origen', e.planes, '--tipo', 'planes', '--root', e.root, '--aplicar', '--hoy', '2026-11-08']).code, 0);
  const primero = fs.readFileSync(path.join(e.root, 'planes/obra.md'), 'utf8');
  assert.equal(parseFrontmatter(primero).data.type, 'plan');
  assert.equal(parseFrontmatter(primero).data.title, 'Plan de obra');
  assert.ok(fs.existsSync(path.join(e.root, 'planes/obra-2.md')));
  assert.ok(fs.existsSync(path.join(e.root, 'registro/2026-11-08-migrar-planes-2.md')));
});

test('un destino existente nunca se sobrescribe', () => {
  const e = escenario();
  escribir(e.root, 'planes/obra.md', 'MIO');
  ejecutar(['--origen', e.planes, '--tipo', 'planes', '--root', e.root, '--aplicar']);
  assert.equal(fs.readFileSync(path.join(e.root, 'planes/obra.md'), 'utf8'), 'MIO');
});

test('los enlaces simbólicos no se siguen ni sacan nada fuera de la raíz', () => {
  const e = escenario();
  const secreto = path.join(e.base, 'secreto');
  escribir(secreto, 'clave.md', 'no debe copiarse');
  fs.symlinkSync(secreto, path.join(e.boveda, 'enlace'));
  fs.symlinkSync(path.join(secreto, 'clave.md'), path.join(e.boveda, 'clave.md'));
  // un directorio del cerebro que apunta fuera: la escritura se niega
  fs.symlinkSync(secreto, path.join(e.root, 'planes'));
  const r = ejecutar(['--origen', e.planes, '--tipo', 'planes', '--root', e.root, '--aplicar']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /fuera de la raíz/);
  assert.deepEqual(fs.readdirSync(secreto), ['clave.md']);
  fs.unlinkSync(path.join(e.root, 'planes'));
  const r2 = ejecutar(['--origen', e.boveda, '--root', e.root, '--dry-run']);
  assert.match(r2.out, /enlace simbólico/);
  assert.doesNotMatch(r2.out, /secreto|no debe copiarse/);
});

test('errores de uso: sin acción, con ambas, origen inexistente', () => {
  const e = escenario();
  assert.notEqual(ejecutar(['--origen', e.boveda, '--root', e.root]).code, 0);
  assert.notEqual(ejecutar(['--origen', e.boveda, '--root', e.root, '--dry-run', '--aplicar']).code, 0);
  assert.match(ejecutar(['--origen', path.join(e.base, 'nada'), '--root', e.root, '--dry-run']).err, /no existe/);
});

test('description generada: texto plano, una línea, ≤200', () => {
  assert.equal(limpiarDescripcion('## Ver [la **nota**](a.md), [[b|alias]] y ![[c.png]] ![img](x.png) `code`'), 'Ver la nota, alias y c.png img code');
  assert.equal(limpiarDescripcion('* [ ] hacer <b>algo</b>'), 'hacer algo');
  const larga = limpiarDescripcion('palabra '.repeat(80));
  assert.ok(larga.length <= 200 && !larga.includes('\n'));
  const e = escenario();
  modoBorrador(e.root);
  escribir(e.boveda, 'Enlaza.md', '# T\n\n[[Cafetera|La cafetera]] con **negrita** y ![[foto.png]] y [web](https://x.es)\n');
  assert.equal(ejecutar(['--origen', e.boveda, '--root', e.root, '--aplicar']).code, 0);
  const d = parseFrontmatter(fs.readFileSync(path.join(e.root, 'memoria/borradores/enlaza.md'), 'utf8')).data.description;
  assert.equal(d, 'La cafetera con negrita y foto.png y web');
});

test('origen igual a, dentro de, o que contiene la raíz: error y nada escrito', () => {
  const e = escenario();
  escribir(e.root, 'memoria/x.md', 'algo');
  const dentroDe = path.join(e.root, 'memoria');
  for (const o of [e.root, dentroDe, e.base]) {
    const r = ejecutar(['--origen', o, '--root', e.root, '--dry-run']);
    assert.notEqual(r.code, 0, o);
    assert.match(r.err, /no puede ser la raíz del cerebro/);
  }
  assert.deepEqual(Object.keys(huellas(e.root)), [path.join('memoria', 'x.md')]);
});

test('modo directo (por defecto): --aplicar escribe ya promovido, con index.md y log.md, y el revisor no tiene nada que hacer', () => {
  const e = escenario();
  const r = ejecutar(['--origen', e.libreta, '--root', e.root, '--aplicar', '--hoy', '2026-11-08']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(path.join(e.root, 'memoria/borradores')), 'nada en borradores/');
  const cafe = parseFrontmatter(fs.readFileSync(path.join(e.root, 'memoria/el-cafe-es-descafeinado-nono.md'), 'utf8'));
  assert.equal(cafe.data.status, 'stable');
  assert.equal(cafe.data.type, 'nota');
  const persona = parseFrontmatter(fs.readFileSync(path.join(e.root, 'memoria/personas/vive-en-logrono.md'), 'utf8'));
  assert.equal(persona.data.type, 'persona');
  assert.match(fs.readFileSync(path.join(e.root, 'memoria/index.md'), 'utf8'), /\* \[El café es descafeinado, ñoño\]\(el-cafe-es-descafeinado-nono\.md\)/);
  assert.match(fs.readFileSync(path.join(e.root, 'memoria/personas/index.md'), 'utf8'), /vive-en-logrono\.md/);
  const log = fs.readFileSync(path.join(e.root, 'log.md'), 'utf8');
  assert.match(log, /## 2026-11-08/);
  assert.equal((log.match(/\* \*\*Creación\*\*/g) || []).length, 5);
  assert.match(r.out, /5 directos/);
});

test('modo directo: la bóveda coloca notas, decisiones y repetidos sin pisar; --dry-run dice dónde irían', () => {
  const e = escenario();
  const seco = ejecutar(['--origen', e.boveda, '--root', e.root, '--dry-run', '--hoy', '2026-11-08']);
  assert.match(seco.out, /memoria\/aprendizajes\/2026-11-08-riego-de-tomates\.md/);
  assert.deepEqual(fs.readdirSync(e.root), []);
  const r = ejecutar(['--origen', e.boveda, '--root', e.root, '--aplicar', '--hoy', '2026-11-08']);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(e.root, 'memoria/aprendizajes/2026-11-08-riego-de-tomates.md')));
  assert.ok(fs.existsSync(path.join(e.root, 'memoria/riego.md')) && fs.existsSync(path.join(e.root, 'memoria/cafetera.md')));
  assert.ok(!fs.existsSync(path.join(e.root, 'memoria/borradores')));
});
