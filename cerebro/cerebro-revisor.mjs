#!/usr/bin/env node
// cerebro-revisor — filtro determinista de borradores para la memoria curada MiCerebro.
// Cero dependencias externas: solo módulos internos de Node.
//
// Uso: node cerebro-revisor.mjs [--dry-run] [--no-commit] [--no-push] [--root <ruta>]
// Raíz: --root > CEREBRO_ROOT > cerebro.config.json hacia arriba desde el cwd > cwd.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { cargarConfig } from './cerebro-config.mjs';
import { validateKit, destinoKit, promoverKit } from './cerebro-promover.mjs';
import { defaultRoot, readNotes, sincronizar } from './cerebro-comun.mjs';

// Rutas, tipos, borradores y carpetas de destino salen de cerebro-config (cargarConfig).

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// --- Sincronización ----------------------------------------------------------
// Lo promovido se commitea en el repo de la raíz, limitado a `revisor.rutasSincronizadas`
// (nunca arrastra trabajo ajeno suelto). El push solo ocurre si hay remoto y upstream.
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

const apagado = (v) => /^(0|false|no|off)$/i.test(String(v || '').trim());

async function main() {
  const { flags: args, root: rootArg } = parseArgs(process.argv.slice(2));
  if (args.has('-h') || args.has('--help')) {
    console.log('Uso: node cerebro-revisor.mjs [--dry-run] [--no-commit] [--no-push] [--root <ruta>]\n  CEREBRO_REVISOR_COMMIT=0 equivale a --no-commit; CEREBRO_REVISOR_PUSH=0 a --no-push.');
    return;
  }
  const dryRun = args.has('--dry-run');
  const commit = !args.has('--no-commit') && !apagado(process.env.CEREBRO_REVISOR_COMMIT);
  const push = !args.has('--no-push') && !apagado(process.env.CEREBRO_REVISOR_PUSH);
  const root = path.resolve(rootArg || defaultRoot());
  const cfg = cargarConfig(root);
  const borradores = cfg.borradoresDir;
  const hoy = todayUtc().toISOString().slice(0, 10);
  // `_rechazados/` es archivo: el revisor no lo lee.
  const enRechazados = (note) => path.relative(borradores, note.file).split(path.sep)[0] === '_rechazados';
  const esIndice = (note) => ['index.md', 'log.md'].includes(path.basename(note.file).toLowerCase());
  const drafts = readNotes(borradores).filter((note) => !enRechazados(note) && !esIndice(note));
  let promoted = 0;
  let doubtful = 0;

  for (const draft of drafts) {
    const rel = path.relative(root, draft.file).split(path.sep).join('/');
    let failures;
    try {
      failures = validateKit(draft, cfg);
    } catch (error) {
      // Un borrador raro tampoco tumba la pasada: queda dudoso y se sigue.
      failures = [`Validación fallida — ${error.message}`];
    }
    if (failures.length) {
      doubtful++;
      console.log(`DUDOSO: ${rel} — ${failures.join('; ')}`);
      continue;
    }
    if (dryRun) {
      promoted++;
      console.log(`PROMOCIONARÍA: ${rel} → ${path.relative(root, destinoKit(root, draft, cfg, hoy)).split(path.sep).join('/')}`);
      continue;
    }
    try {
      const nota = promoverKit(root, draft, cfg, hoy);
      promoted++;
      console.log(`PROMOCIONADO: ${rel} → ${path.relative(root, nota.file).split(path.sep).join('/')}`);
    } catch (error) {
      doubtful++;
      console.log(`DUDOSO: ${rel} — Promoción fallida — ${error.message}`);
    }
  }
  const resumen = `${promoted} promocionados, ${doubtful} dudosos`;
  console.log(`Resumen: ${drafts.length} borradores revisados, ${resumen}.`);
  if (dryRun) console.log('Sync: omitido (--dry-run).');
  else {
    // Solo lo que existe: `git add` rechaza una ruta sin coincidencias.
    const rutas = cfg.revisor.rutasSincronizadas.filter((r) => fs.existsSync(path.join(root, r)));
    sincronizar(root, resumen, { rutas, firma: 'cerebro-revisor automático', commit, push });
  }
}

main().catch((error) => {
  console.error(`MiCerebro revisor error: ${error.message}`);
  process.exitCode = 1;
});
