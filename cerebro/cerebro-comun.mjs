// cerebro-comun — funciones compartidas por el revisor: parser de frontmatter,
// escritura atómica y sincronización git (commit + push opcionales).
// Cero dependencias externas: solo módulos internos de Node.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// La raíz por defecto vive en cerebro-config (un solo cálculo para MiCerebro, el MCP y el revisor).
export { defaultRoot } from './cerebro-config.mjs';

export function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.cerebro-revisor-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// YAML-lite deliberadamente pequeño: solo las claves planas que exige MiCerebro.
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content, hasFrontmatter: false };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!field) continue;
    let value = field[2];
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    data[field[1]] = value;
  }
  return { data, body: content.slice(match[0].length), hasFrontmatter: true };
}

export function listMarkdown(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdown(file);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [file] : [];
  });
}

export function readNotes(dir) {
  const notes = [];
  for (const file of listMarkdown(dir)) {
    const content = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(content);
    notes.push({ file, content, body: fm.body, data: fm.data, hasFrontmatter: fm.hasFrontmatter });
  }
  return notes;
}

export function git(repoRoot, args, { permitirFallo = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (permitirFallo) return null;
    const detalle = (error.stderr || error.message || '').toString().trim().split('\n')[0];
    throw new Error(`git ${args[0]} falló: ${detalle}`);
  }
}

// Sincroniza lo que ha promovido el revisor con git.
//   rutas    lo único que viaja en el commit (nunca arrastra trabajo ajeno suelto en el repo).
//   firma    quién commitea, para el mensaje.
//   commit   false: no se toca git (ni commit ni push).
//   push     false: commit sí, push no.
// Commit solo si hay cambios en `rutas`. Push solo si hay remoto y la rama actual tiene
// upstream configurado, y es un `git push` normal (sube la rama actual a su upstream, nada más).
// Un fallo de red no tira la promoción: queda commiteada en local y el proceso sale con código 1.
export function sincronizar(repoRoot, resumen, { rutas, firma, commit = true, push = true }) {
  if (!commit) {
    console.log('Sync: desactivado (--no-commit) — nada que subir.');
    return;
  }
  const pendientes = git(repoRoot, ['status', '--porcelain', '--', ...rutas], { permitirFallo: true });
  if (pendientes === null) {
    console.log('Sync: no es un repo git — nada que subir.');
    return;
  }
  if (!pendientes.trim()) {
    console.log('Sync: sin cambios que subir.');
    return;
  }
  try {
    git(repoRoot, ['add', '--', ...rutas]);
    git(repoRoot, ['commit', '-m', `memoria: ${resumen} (${firma})`, '--', ...rutas]);
    if (!push) {
      console.log('Sync: commit hecho — push desactivado (--no-push).');
      return;
    }
    if (!(git(repoRoot, ['remote'], { permitirFallo: true }) || '').trim()) {
      console.log('Sync: commit hecho — sin remoto configurado, no se sube.');
      return;
    }
    if (git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { permitirFallo: true }) === null) {
      console.log('Sync: commit hecho — la rama actual no tiene upstream, no se sube.');
      return;
    }
    git(repoRoot, ['push']);
    console.log('Sync: commit y push hechos.');
  } catch (error) {
    console.log(`Sync: NO subido — ${error.message}`);
    process.exitCode = 1;
  }
}
