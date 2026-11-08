#!/usr/bin/env node
// okf-mcp — servidor MCP por stdio para la memoria curada OKF.
// Cero dependencias externas: envuelve el CLI existente sin duplicar su lógica.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { cargarConfig, defaultRoot, fichaBorradorKit } from './okf-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Rutas y tipos salen de la config activa (okf-config.mjs).

function slugify(title) {
  let s = String(title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return s || 'nota';
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.okf-mcp-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// YAML-lite: basta para los campos planos que usa el contexto OKF.
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!field) continue;
    let value = field[2].trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    data[field[1]] = value;
  }
  return { data, body: content.slice(match[0].length) };
}

function listMdFiles(dir) {
  let files = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(listMdFiles(filePath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(filePath);
  }
  return files;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function textResult(text, isError = false) {
  const result = { content: [{ type: 'text', text: String(text) }] };
  if (isError) result.isError = true;
  return result;
}

function runOkf(root, args, input) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'okf.mjs'), ...args, '--root', root], {
    input,
    encoding: 'utf8',
    cwd: root,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'okf terminó con error').trim());
  return result.stdout;
}

function requireString(args, key) {
  if (!args || typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`falta el argumento de texto '${key}'`);
  return args[key];
}

function guardar(root, config, args) {
  const tipo = args && typeof args.tipo === 'string' && args.tipo.trim() ? args.tipo : config.tipoDefecto || requireString(args, 'tipo');
  const titulo = requireString(args, 'titulo');
  const cuerpo = requireString(args, 'cuerpo');
  if (!config.tiposSet.has(tipo)) throw new Error(`tipo inválido "${tipo}"`);
  // Todo okf_guardar nace borrador: el revisor es la única puerta a la nota publicada.
  const slug = slugify(titulo);
  let nombre = slug;
  for (let n = 2; fs.existsSync(path.join(config.borradoresDir, `${nombre}.md`)); n++) nombre = `${slug}-${n}`;
  const destino = path.join(config.borradoresDir, `${nombre}.md`);
  atomicWrite(destino, fichaBorradorKit({ tipo, titulo, cuerpo, fecha: today() }));
  return `OKF: borrador guardado ${path.relative(root, destino)}`;
}

function buildTools(config) {
  const descGuardar = `Guarda una nota SIEMPRE como borrador (${path.relative(config.root, config.borradoresDir)}/), sin indexar: la promueve el revisor. Tipos: ${config.tipos.join(', ')}${config.tipoDefecto ? ` (por defecto ${config.tipoDefecto})` : ''}.`;
  return [
    { name: 'okf_buscar', description: 'Busca contexto curado con la escalera determinista OKF.', inputSchema: { type: 'object', properties: { pregunta: { type: 'string' } }, required: ['pregunta'], additionalProperties: false } },
    { name: 'okf_leer', description: `Lee una nota de contexto por ${config.campoNombre} o por fichero.`, inputSchema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'], additionalProperties: false } },
    { name: 'okf_listar', description: 'Lista nombres, tipos y descripciones del contexto curado.', inputSchema: { type: 'object', properties: { tipo: { type: 'string', enum: config.tipos } }, additionalProperties: false } },
    { name: 'okf_guardar', description: descGuardar, inputSchema: { type: 'object', properties: { tipo: { type: 'string', enum: config.tipos }, titulo: { type: 'string' }, cuerpo: { type: 'string' } }, required: config.tipoDefecto ? ['titulo', 'cuerpo'] : ['tipo', 'titulo', 'cuerpo'], additionalProperties: false } },
    { name: 'okf_caducados', description: 'Informa notas caducadas y enlaces rotos.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ];
}

function callTool(root, config, name, args) {
  try {
    if (name === 'okf_buscar') {
      return textResult(runOkf(root, ['buscar', requireString(args, 'pregunta')]));
    }
    if (name === 'okf_leer') {
      const nombre = requireString(args, 'nombre');
      const wantedFile = nombre.endsWith('.md') ? nombre : `${nombre}.md`;
      for (const dir of config.leer.dirs) {
        for (const filePath of listMdFiles(dir)) {
          if (path.basename(filePath) === wantedFile || parseFrontmatter(fs.readFileSync(filePath, 'utf8')).data[config.campoNombre] === nombre) {
            return textResult(fs.readFileSync(filePath, 'utf8'));
          }
        }
      }
      throw new Error(`no existe la nota '${nombre}'`);
    }
    if (name === 'okf_listar') {
      if (args?.tipo !== undefined && !config.tiposSet.has(args.tipo)) throw new Error(`tipo inválido "${args.tipo}"`);
      const lines = [];
      const ficheros = config.leer.dirs.flatMap((dir) => listMdFiles(dir).sort());
      for (const filePath of ficheros) {
        if (config.leer.ignorarFicheros.includes(path.basename(filePath))) continue;
        const data = parseFrontmatter(fs.readFileSync(filePath, 'utf8')).data;
        if (!data[config.campoNombre] || !data.type || (args?.tipo && data.type !== args.tipo)) continue;
        lines.push(`${data[config.campoNombre]} | ${data.type} | ${data.description || ''}`);
      }
      return textResult(lines.join('\n'));
    }
    if (name === 'okf_guardar') return textResult(guardar(root, config, args));
    if (name === 'okf_caducados') return textResult(runOkf(root, ['caducados']));
    return textResult(`tool desconocida: ${name}`, true);
  } catch (error) {
    return textResult(error.message, true);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// Raíz: --root > OKF_ROOT > okf.config.json hacia arriba desde el cwd > cwd.
const rootIdx = process.argv.indexOf('--root');
const root = path.resolve((rootIdx >= 0 && process.argv[rootIdx + 1]) || defaultRoot());
const config = cargarConfig(root);
const TOOLS = buildTools(config);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const request = JSON.parse(line);
      const notification = request.id === undefined;
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        if (!notification) respondError(request?.id ?? null, -32600, 'Invalid Request');
      } else if (request.method === 'notifications/initialized') {
        // Notificación MCP: no lleva respuesta.
      } else if (request.method === 'initialize') {
        if (!notification) respond(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'okf', version: '1.0.0' } });
      } else if (request.method === 'ping') {
        if (!notification) respond(request.id, {});
      } else if (request.method === 'tools/list') {
        if (!notification) respond(request.id, { tools: TOOLS });
      } else if (request.method === 'tools/call') {
        if (!notification) respond(request.id, callTool(root, config, request.params?.name, request.params?.arguments || {}));
      } else if (!notification) {
        respondError(request.id, -32601, 'Method not found');
      }
    } catch (error) {
      respondError(null, -32700, `Parse error: ${error.message}`);
    }
  }
});

// Conserva el proceso vivo mientras el cliente MCP mantiene abierto stdin.
await new Promise((resolve) => process.stdin.on('end', resolve));
