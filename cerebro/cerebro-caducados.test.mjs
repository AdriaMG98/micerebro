#!/usr/bin/env node
// Test de caja negra de `cerebro caducados`: monta un workspace de mentira en un
// temporal, escribe notas concretas y comprueba qué marca como enlace roto.
// Cubre el falso positivo de sintaxis de código (bash `[[ ... ]]` entre
// backticks, o un wikilink de ejemplo documentado) leída como wikilink real
//
// Uso: node cerebro-caducados.test.mjs   (exit 0 = verde, 1 = rojo)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const cerebroCli = path.join(aqui, 'cerebro.mjs');
const hoy = new Date().toISOString().slice(0, 10);

function montarWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-caducados-test-'));
  const mkdir = (rel) => fs.mkdirSync(path.join(root, rel), { recursive: true });
  mkdir('memoria');
  return root;
}

function escribirNota(root, nombre, cuerpo) {
  const file = path.join(root, 'memoria', `${nombre}.md`);
  fs.writeFileSync(
    file,
    `---\ntype: nota\ntitle: ${nombre}\ndescription: "prueba"\nstatus: stable\nactualizado: ${hoy}\n---\n\n${cuerpo}\n`
  );
}

function correrCaducados(root) {
  const res = spawnSync(process.execPath, [cerebroCli, 'caducados', '--root', root], { encoding: 'utf8' });
  return `${res.stdout}${res.stderr}`;
}

let fallos = 0;
const informar = (ok, nombre, qué, detalle) => {
  if (!ok) fallos++;
  console.log(`${ok ? 'ok  ' : 'FALLO'} ${nombre} — ${qué}${ok ? '' : `\n      ${detalle}`}`);
};

const root = montarWorkspace();

// Nota con código inline de bash (doble corchete) y un bloque vallado con un
// wikilink de ejemplo dentro: ninguno de los dos debe contarse como roto.
escribirNota(
  root,
  'nota-con-codigo-inline-y-bloque',
  [
    'Se comprueba con `[[ -n "$var" ]] && echo ok`, sintaxis de bash.',
    '',
    'Ejemplo de frontmatter en un bloque vallado:',
    '',
    '```',
    'wikilinks por [[nombre-que-no-existe]] dentro del bloque, no cuenta.',
    '```',
    '',
    'Esto sí es un wikilink real y roto: [[nota-inventada-que-no-existe]].',
  ].join('\n')
);

{
  const salida = correrCaducados(root);
  const tieneInline = salida.includes('-eq') || salida.includes('-n "$var"');
  const tieneBloqueEjemplo = salida.includes('nombre-que-no-existe');
  const tieneRealRoto = salida.includes('nota-inventada-que-no-existe');
  informar(!tieneInline && !tieneBloqueEjemplo, 'ignora-codigo', 'código inline y bloque vallado no se leen como wikilink', salida);
  informar(tieneRealRoto, 'detecta-real', 'un wikilink real y roto fuera de código sigue detectándose', salida);
}

fs.rmSync(root, { recursive: true, force: true });

// Simula la carrera con el revisor: una nota existe cuando
// buildCatalog la cataloga, pero desaparece antes de que cmdCaducados haga su
// propio `statSync` en el bucle. Como el proceso de cerebro.mjs es un único
// spawnSync, no podemos borrar el fichero "a mitad" desde fuera; en su lugar
// precargamos un hook (--import) que intercepta `fs.statSync` y, la primera
// vez que se le pida el stat de la nota marcada, borra el fichero y relanza
// el ENOENT real que lanzaría el stat tras una carrera genuina.
{
  const root2 = montarWorkspace();
  escribirNota(root2, 'nota-que-desaparece-en-la-carrera', 'Cuerpo sin wikilinks ni nada especial.');
  const notaPath = path.join(root2, 'memoria', 'nota-que-desaparece-en-la-carrera.md');
  const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-race-hook-')), 'hook.mjs');
  fs.writeFileSync(
    hook,
    [
      "import fs from 'node:fs';",
      `const objetivo = ${JSON.stringify(notaPath)};`,
      'let disparado = false;',
      'const statSyncOriginal = fs.statSync;',
      'fs.statSync = function (p, ...args) {',
      '  if (!disparado && String(p) === objetivo) {',
      '    disparado = true;',
      '    try { fs.rmSync(p); } catch {}',
      '  }',
      '  return statSyncOriginal.call(this, p, ...args);',
      '};',
    ].join('\n')
  );
  const res = spawnSync(
    process.execPath,
    [`--import=${hook}`, cerebroCli, 'caducados', '--root', root2],
    { encoding: 'utf8' }
  );
  const salida = `${res.stdout}${res.stderr}`;
  const noMuereConENOENT = res.status === 0 && !salida.includes('ENOENT');
  const siListaTotal = /Total: \d+ ficheros/.test(salida);
  informar(
    noMuereConENOENT && siListaTotal,
    'sobrevive-carrera-stat',
    'si la nota desaparece entre buildCatalog y el stat del bucle, caducados sigue y no muere con ENOENT',
    salida
  );
  fs.rmSync(root2, { recursive: true, force: true });
  fs.rmSync(path.dirname(hook), { recursive: true, force: true });
}

const total = 3;
console.log(`\n${total - fallos}/${total} verdes`);
process.exit(fallos > 0 ? 1 : 0);
