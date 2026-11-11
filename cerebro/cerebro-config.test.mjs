// Tests del preset `micerebro` y de cerebro.config.json: mini-cerebro en un temporal.
// Uso: node --test cerebro-config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cargarConfig } from './cerebro-config.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const cerebroCli = path.join(aqui, 'cerebro.mjs');
const mcp = path.join(aqui, 'cerebro-mcp.mjs');

function escribir(root, rel, texto) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
}

function ficha(tipo, titulo, desc, cuerpo) {
  return `---\ntype: ${tipo}\ntitle: "${titulo}"\ndescription: "${desc}"\nstatus: stable\nactualizado: 2026-11-01\n---\n\n${cuerpo}\n`;
}

function cerebro(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-micerebro-'));
  escribir(root, 'index.md', '---\ncerebro_version: 0.2\n---\n# MiCerebro\n');
  escribir(root, 'memoria/decisiones/2026-10-01-elegir-cafetera.md', ficha('decision', 'Elegir cafetera', 'Compramos una cafetera italiana de acero', 'Decidimos la cafetera italiana por durabilidad.'));
  escribir(root, 'memoria/decisiones/index.md', '# Decisiones\n\n* [Elegir cafetera](2026-10-01-elegir-cafetera.md) - Cafetera italiana descrita en el índice\n');
  escribir(root, 'memoria/aprendizajes/2026-10-02-tomates.md', ficha('aprendizaje', 'Tomates en maceta', 'Los tomates necesitan sol directo', 'Riego por la mañana.'));
  escribir(root, 'proyectos/reforma-cocina.md', ficha('proyecto', 'Reforma de cocina', 'Reforma integral con presupuesto de azulejos', 'Azulejos hidráulicos en la pared.'));
  escribir(root, '00-bandeja/suelto.md', ficha('nota', 'Suelto', 'Papel de bandeja con zanahorias', 'zanahorias zanahorias'));
  escribir(root, 'archivo/viejo.md', ficha('proyecto', 'Viejo', 'Proyecto archivado de zanahorias', 'zanahorias'));
  for (const [rel, txt] of Object.entries(extra)) escribir(root, rel, txt);
  return root;
}

// Config del kit con el flujo antiguo: lo guardado nace borrador y lo promueve el revisor.
const BORRADOR = { 'cerebro.config.json': '{"guardar":{"modo":"borrador"}}' };

function cli(root, args, input) {
  const r = spawnSync(process.execPath, [cerebroCli, ...args, '--root', root], { encoding: 'utf8', input });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

test('sin cerebro.config.json: preset micerebro', () => {
  const root = cerebro();
  const c = cargarConfig(root);
  assert.equal(c.preset, 'micerebro');
  assert.equal(c.tipoDefecto, 'nota');
  assert.equal(c.borradoresDir, path.join(root, 'memoria/borradores'));
  assert.ok(c.tiposSet.has('aprendizaje') && !c.tiposSet.has('feedback'));
});

test('buscar encuentra lo indexado y usa el índice por carpeta', () => {
  const root = cerebro();
  const r = cli(root, ['buscar', 'cafetera italiana']);
  assert.match(r.out, /2026-10-01-elegir-cafetera\.md/);
  const d = cli(root, ['buscar', 'azulejos reforma']);
  assert.match(d.out, /reforma-cocina\.md/);
});

test('buscar NO ve 00-bandeja ni archivo', () => {
  const root = cerebro();
  const r = cli(root, ['buscar', 'zanahorias']);
  assert.match(r.out, /0 aciertos/);
  assert.doesNotMatch(r.out, /suelto\.md|viejo\.md/);
});

test('guardar aprendizaje crea borrador con ficha y tildes intactas (modo borrador)', () => {
  const root = cerebro(BORRADOR);
  const r = cli(root, ['guardar', 'aprendizaje', 'Cómo regar higueras', '--body', '-'], 'Regar poco: la higuera es muy áspera con el exceso.\n');
  assert.equal(r.status, 0, r.err);
  const f = path.join(root, 'memoria/borradores/como-regar-higueras.md');
  const txt = fs.readFileSync(f, 'utf8');
  assert.match(txt, /^---\ntype: aprendizaje\ntitle: "Cómo regar higueras"\ndescription: "Regar poco: la higuera es muy áspera con el exceso\."\nstatus: draft\nactualizado: \d{4}-\d{2}-\d{2}\n---\n/);
  assert.equal(fs.existsSync(path.join(root, 'memoria/index.md')), false, 'no toca índices');
});

test('guardar con tipo feedback falla en micerebro', () => {
  const root = cerebro();
  const r = cli(root, ['guardar', 'feedback', 'x', '--body', 'algo']);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /tipo inválido "feedback"/);
});

test('buscar excluye borradores salvo --todo', () => {
  const root = cerebro(BORRADOR);
  cli(root, ['guardar', 'nota', 'Mermelada de naranjas', '--body', 'Mermelada de naranjas amargas']);
  assert.match(cli(root, ['buscar', 'mermelada naranjas']).out, /0 aciertos/);
  assert.match(cli(root, ['buscar', 'mermelada naranjas', '--todo']).out, /borradores\/mermelada-de-naranjas\.md/);
});

test('cerebro.config.json sobrescribe tipos y tipo por defecto', () => {
  const root = cerebro({ 'cerebro.config.json': '{"preset":"micerebro","tipos":["nota","idea"],"tipoDefecto":"idea"}' });
  const c = cargarConfig(root);
  assert.equal(c.preset, 'micerebro');
  assert.deepEqual(c.tipos, ['nota', 'idea']);
  assert.equal(c.tipoDefecto, 'idea');
});

test('raíz: --root > CEREBRO_ROOT > cerebro.config.json hacia arriba desde el cwd > cwd', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-raiz-')));
  const a = path.join(dir, 'a');
  const otro = path.join(dir, 'otro');
  escribir(a, 'cerebro.config.json', '{}');
  escribir(a, 'sub/hondo/x.txt', '');
  escribir(otro, 'x.txt', '');
  const raiz = (cwd, env = {}, args = []) => {
    const e = { ...process.env, ...env };
    if (!('CEREBRO_ROOT' in env)) delete e.CEREBRO_ROOT;
    const r = spawnSync(process.execPath, [cerebroCli, ...args], { cwd, env: e, encoding: 'utf8' });
    return /raíz actual: (\S+)/.exec(r.stdout)[1];
  };
  assert.equal(raiz(path.join(a, 'sub/hondo'), {}, ['--help']), a); // sube hasta cerebro.config.json
  assert.equal(raiz(otro, {}, ['--help']), otro); // sin config: el cwd
  assert.equal(raiz(path.join(a, 'sub'), { CEREBRO_ROOT: otro }, ['--help']), otro); // CEREBRO_ROOT > config
  assert.equal(raiz(path.join(a, 'sub'), { CEREBRO_ROOT: otro }, ['--help', '--root', a]), a); // --root > CEREBRO_ROOT
});

test('preset desconocido da error claro', () => {
  const root = cerebro({ 'cerebro.config.json': '{"preset":"nope"}' });
  assert.throws(() => cargarConfig(root), /preset desconocido/);
  assert.match(cli(root, ['buscar', 'x']).err, /preset desconocido/);
});

function llamarMcp(root, llamadas) {
  const lineas = llamadas.map((p, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: p.method, params: p.params }));
  const r = spawnSync(process.execPath, [mcp], { encoding: 'utf8', input: lineas.join('\n') + '\n', env: { ...process.env, CEREBRO_ROOT: root } });
  return r.stdout.trim().split('\n').map((l) => JSON.parse(l));
}

test('cerebro-mcp con micerebro (modo borrador): listar tools, guardar y buscar', () => {
  const root = cerebro(BORRADOR);
  const res = llamarMcp(root, [
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'cerebro_guardar', arguments: { tipo: 'decision', titulo: 'Usar pizarra', cuerpo: 'Decidimos usar una pizarra blanca.' } } },
    { method: 'tools/call', params: { name: 'cerebro_guardar', arguments: { tipo: 'feedback', titulo: 'x', cuerpo: 'y' } } },
    { method: 'tools/call', params: { name: 'cerebro_guardar', arguments: { titulo: 'Sin tipo', cuerpo: 'cae en nota' } } },
    { method: 'tools/call', params: { name: 'cerebro_buscar', arguments: { pregunta: 'cafetera italiana' } } },
    { method: 'tools/call', params: { name: 'cerebro_leer', arguments: { nombre: 'Reforma de cocina' } } },
  ]);
  const tools = res[0].result.tools;
  const guardar = tools.find((t) => t.name === 'cerebro_guardar');
  assert.ok(guardar.inputSchema.properties.tipo.enum.includes('aprendizaje'));
  assert.match(res[1].result.content[0].text, /memoria\/borradores\/usar-pizarra\.md/);
  assert.equal(res[2].result.isError, true);
  assert.match(fs.readFileSync(path.join(root, 'memoria/borradores/sin-tipo.md'), 'utf8'), /^---\ntype: nota\n/);
  assert.match(res[4].result.content[0].text, /elegir-cafetera/);
  assert.match(res[5].result.content[0].text, /Azulejos hidráulicos/);
});

test('confinamiento: rutas del cerebro.config.json fuera de la raíz se rechazan', () => {
  const casos = [
    '{"leer":{"dirs":["../fuera"]}}',
    '{"borradoresDir":"../fuera/b"}',
    '{"borradoresDir":"/tmp/fuera"}',
    '{"fuentes":[{"dir":"../fuera","source":"x"}]}',
    '{"fuentes":[{"archivo":"/etc/passwd","source":"x"}]}',
    '{"guardar":{"destinos":{"a":{"dir":"../fuera","indice":"i.md","formato":"contexto"}}}}',
  ];
  for (const caso of casos) {
    const root = cerebro({ 'cerebro.config.json': caso });
    assert.throws(() => cargarConfig(root), /fuera de la raíz/, caso);
    assert.match(cli(root, ['buscar', 'x']).err, /fuera de la raíz/, caso);
  }
  const ok = cerebro({ 'cerebro.config.json': '{"leer":{"dirs":["memoria"]},"borradoresDir":"memoria/b"}' });
  assert.equal(cargarConfig(ok).borradoresDir, path.join(ok, 'memoria/b'));
});

test('config parcial: leer/guardar se fusionan con el preset y los tipos mal dados dan error legible', () => {
  const root = cerebro({ 'cerebro.config.json': '{"leer":{},"guardar":{}}' });
  const c = cargarConfig(root);
  assert.ok(c.leer.dirs.length > 0 && Array.isArray(c.leer.ignorarFicheros));
  assert.equal(c.guardar.modo, 'directo');
  const c2 = cargarConfig(cerebro({ 'cerebro.config.json': '{"leer":{"ignorarFicheros":["x.md"]}}' }));
  assert.ok(c2.leer.dirs.length > 0);
  const mal = ['{"leer":3}', '{"tipos":"nota"}', '{"fuentes":[{"source":"x"}]}', '{"leer":{"dirs":"memoria"}}', '{"guardar":{"modo":"zzz"}}', '[]'];
  for (const m of mal) {
    assert.throws(() => cargarConfig(cerebro({ 'cerebro.config.json': m })), /cerebro\.config\.json/, m);
  }
  // el MCP no revienta con `leer` parcial
  const res = llamarMcp(cerebro({ 'cerebro.config.json': '{"leer":{}}' }), [{ method: 'tools/call', params: { name: 'cerebro_listar', arguments: {} } }]);
  assert.ok(res[0].result.content[0].text.includes('Reforma de cocina'));
});

// ── sin cerebro, MiCerebro no escribe: el último recurso (cwd sin cerebro.config.json) solo vale para leer ──
test('guardar sin --root, sin CEREBRO_ROOT y sin cerebro.config.json: error y nada creado', () => {
  const ajeno = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-sin-cerebro-'));
  const env = { ...process.env };
  delete env.CEREBRO_ROOT;
  const r = spawnSync(process.execPath, [cerebroCli, 'guardar', 'nota', 'Algo', '--body', 'texto'], { cwd: ajeno, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no encuentro tu cerebro: falta cerebro\.config\.json/);
  assert.deepEqual(fs.readdirSync(ajeno), []);
  // buscar sigue funcionando (lectura)
  const b = spawnSync(process.execPath, [cerebroCli, 'buscar', 'algo'], { cwd: ajeno, env, encoding: 'utf8' });
  assert.doesNotMatch(b.stderr, /no encuentro tu cerebro/);
  assert.deepEqual(fs.readdirSync(ajeno), []);
});

test('cerebro-mcp cerebro_guardar sin cerebro: isError y nada creado; con CEREBRO_ROOT guarda y da la ruta absoluta', () => {
  const ajeno = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-sin-cerebro-'));
  const env = { ...process.env };
  delete env.CEREBRO_ROOT;
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cerebro_guardar', arguments: { tipo: 'nota', titulo: 'Algo', cuerpo: 'texto' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const llama = (cwd, e) => {
    const r = spawnSync(process.execPath, [mcp], { cwd, env: e, input: msgs, encoding: 'utf8' });
    const lineas = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return lineas.find((x) => x.id === 2).result;
  };
  const mal = llama(ajeno, env);
  assert.equal(mal.isError, true);
  assert.match(mal.content[0].text, /no encuentro tu cerebro/);
  assert.deepEqual(fs.readdirSync(ajeno), []);
  const root = cerebro();
  const bien = llama(ajeno, { ...env, CEREBRO_ROOT: root });
  assert.ok(!bien.isError);
  assert.ok(bien.content[0].text.includes(path.join(root, 'memoria', 'algo.md')));
  assert.deepEqual(fs.readdirSync(ajeno), []);
});
