# MiCerebro — memoria curada en Markdown para agentes

Una memoria de largo plazo para tus agentes de IA que es **solo una carpeta de ficheros
Markdown**. Sin base de datos, sin dependencias: Node 18+ y git.

- `cerebro.mjs` — CLI: `buscar`, `guardar`, `caducados`, `curar --candidatos`.
- `cerebro-mcp.mjs` — servidor MCP (stdio) con las mismas herramientas, para Claude Code, Codex, Hermes…
- `cerebro-promover.mjs` — validar la ficha, elegir carpeta, escribir y anotar `index.md` y `log.md` (lo comparten el guardado directo, el revisor y `cerebro-migrar`).
- `cerebro-revisor.mjs` — solo para `guardar.modo: "borrador"`: revisa los **borradores** y promueve a la memoria los buenos.
- `hermes-enchufe/` — plugin de memoria para Hermes Agent que usa todo lo anterior.

La idea: lo que guardan los agentes **queda promovido y buscable al instante**. Con el modo por
defecto (`guardar.modo: "directo"`) no hay revisor: `cerebro guardar` / `cerebro_guardar` construyen la ficha,
la validan (la misma comprobación que hacía el revisor) y la escriben en la carpeta de su `type`,
con su línea en el `index.md` y una entrada en `log.md`. Si la ficha no valida, no se escribe nada y
sale un error. Quien prefiera el flujo antiguo pone `"modo": "borrador"`: entonces todo nace como
borrador en `memoria/borradores/` y el revisor (determinista, sin LLM) lo promueve cada hora. Como
la memoria es una carpeta, también es un repo git.

## Instalación

```bash
git clone https://github.com/AdriaMG98/micerebro.git ~/micerebro-kit
cp -r ~/micerebro-kit/ejemplo ~/MiCerebro
cd ~/MiCerebro && git init -b main && git add -A && git commit -m "MiCerebro vacío"
export CEREBRO_ROOT=~/MiCerebro        # opcional si trabajas dentro de ~/MiCerebro (ver «Raíz»)
node ~/micerebro-kit/cerebro/cerebro.mjs --help
```

No hay nada que compilar ni instalar. Si quieres un atajo: `alias cerebro='node ~/micerebro-kit/cerebro/cerebro.mjs'`.

## Estructura MiCerebro

```
MiCerebro/
├── cerebro.config.json        # opcional: preset y ajustes (ver más abajo)
├── index.md               # mapa de carpetas
├── log.md                 # diario: una línea «Creación» por nota promovida
├── memoria/               # lo que debe durar
│   ├── index.md
│   ├── borradores/        # solo en modo "borrador": aquí caen las notas de los agentes
│   ├── decisiones/        # AAAA-MM-DD-titulo.md
│   ├── aprendizajes/      # AAAA-MM-DD-titulo.md
│   └── personas/
├── planes/                # planes vivos
├── proyectos/             # cosas con un final
├── areas/                 # responsabilidades que no terminan
└── recursos/              # material de consulta por tema
```

Cada carpeta tiene su `index.md` con una línea por nota: `* [Título](fichero.md) - descripción`.
`buscar` usa esas descripciones para puntuar; las mantiene el guardado (o el revisor, en modo borrador). `ejemplo/` es un cerebro
vacío con esta estructura, en modo directo (sin borradores).

Una nota es un `.md` con ficha YAML al principio:

```markdown
---
type: aprendizaje            # proyecto | area | recurso | nota | decision | aprendizaje | plan | persona | ficha-externa | registro | skill
title: "Riego de tomates"
description: "Regar por la mañana evita el moho."
status: draft                # al promoverla (directo o por el revisor) pasa a stable
actualizado: 2026-11-08
---

Cuerpo de la nota. Enlaces entre notas en Markdown relativo: [otra nota](../ruta/otra-nota.md).
```

## Raíz: de dónde sale la carpeta del cerebro

Todos los programas (`cerebro.mjs`, `cerebro-mcp.mjs`, `cerebro-revisor.mjs`) resuelven la raíz así, por orden:

1. `--root <ruta>`
2. variable de entorno `CEREBRO_ROOT`
3. subir desde el directorio actual hasta encontrar un `cerebro.config.json`
4. el directorio actual (último recurso: solo para leer)

Si la raíz sale del punto 4 (sin `--root`, sin `CEREBRO_ROOT` y sin `cerebro.config.json` hacia arriba), las
operaciones que escriben (`cerebro guardar`, `cerebro_guardar` del MCP, `cerebro-migrar --aplicar`) se niegan con
«no encuentro tu cerebro» y no crean nada; buscar y listar siguen funcionando.

Nunca se deduce de dónde están los scripts: puedes tenerlos en cualquier sitio.

## CLI

```bash
cerebro buscar "cómo regar tomates"            # devuelve la nota ganadora, no una lista
cerebro buscar "tomates" --todo                # incluye borradores y archivados
cerebro buscar "tomates" --debug               # puntuaciones
echo "Texto de la nota" | cerebro guardar aprendizaje "Título" --body -   # la crea ya promovida (modo borrador: un borrador)
echo "Texto" | cerebro guardar "Título" --body -                          # tipo por defecto: nota
cerebro caducados                              # notas sin tocar en 30 días y enlaces [[rotos]] (no borra nada)
cerebro curar --candidatos [--json]            # qué notas revisar: duplicadas, contradicciones, caducadas, enlaces rotos
```

La búsqueda es léxica y determinista (sin embeddings): puntúa título + descripción, desempata
con el cuerpo, pondera por `type` y deja fuera borradores y `_archivo/`.

### Curar: `cerebro curar --candidatos`

Solo lee (nunca escribe) y no usa LLM: lista qué notas curadas conviene mirar. Ignora borradores y
`archivo/`. Salida legible, o `--json` con una lista de `{tipo, notas: [rutas], motivo}`.

| `tipo` | Qué detecta |
|---|---|
| `duplicada` | dos notas con título o descripción casi iguales: similitud de Jaccard ≥ **0,7** sobre los tokens (minúsculas, sin tildes, sin stopwords, ≥ 2 letras; mínimo 2 tokens por lado) |
| `contradiccion` | el mismo par, pero con `actualizado` distinto en las dos: mismo tema, fechas distintas |
| `caducada` | `actualizado` de hace más de **180 días** (sin `actualizado`, no se juzga) |
| `enlace-roto` | enlace Markdown relativo `[x](ruta.md)` a un fichero que no existe, o `[[wikilink]]` sin nota con ese nombre (el código no cuenta) |

## Servidor MCP

Tools: `cerebro_buscar`, `cerebro_leer`, `cerebro_listar`, `cerebro_guardar` (en modo directo queda ya promovida; en modo borrador, como borrador) y `cerebro_caducados`.
Se lanza con `node /ruta/micerebro-kit/cerebro/cerebro-mcp.mjs` y toma la raíz como arriba (`--root` u `CEREBRO_ROOT`).

**Claude Code**

```bash
claude mcp add cerebro -e CEREBRO_ROOT=$HOME/MiCerebro -- node $HOME/micerebro-kit/cerebro/cerebro-mcp.mjs
```

**Codex** (`~/.codex/config.toml`; TOML y YAML no expanden `$HOME`: cambia `/home/TU_USUARIO` por tu ruta)

```toml
[mcp_servers.cerebro]
command = "node"
args = ["/home/TU_USUARIO/micerebro-kit/cerebro/cerebro-mcp.mjs"]
env = { CEREBRO_ROOT = "/home/TU_USUARIO/MiCerebro" }
```

**Hermes Agent** (`config.yaml` del perfil; alternativa al plugin de abajo)

```yaml
mcp_servers:
  cerebro:
    command: node
    args: ["/home/TU_USUARIO/micerebro-kit/cerebro/cerebro-mcp.mjs"]
    env:
      CEREBRO_ROOT: /home/TU_USUARIO/MiCerebro
```

Dile a tu agente en su fichero de instrucciones (`CLAUDE.md`, `AGENTS.md`…) que busque con
`cerebro_buscar` antes de preguntarte algo y que guarde con `cerebro_guardar` lo que valga la pena conservar.

## Revisor de borradores (solo modo `borrador`)

En modo `directo` (el de por defecto) no hace falta. Sigue funcionando para quien use `guardar.modo: "borrador"`.

```bash
node cerebro/cerebro-revisor.mjs --dry-run          # ensayo: lista qué promovería, no escribe nada
node cerebro/cerebro-revisor.mjs                    # promueve y commitea
```

Por cada borrador de `memoria/borradores/` (ignora `_rechazados/`, `index.md` y `log.md`):

- **Válido** (ficha con `type` admitido, `title` y `description`): se mueve a la carpeta de su
  `type` (`decision` → `memoria/decisiones/`, `aprendizaje` → `memoria/aprendizajes/`,
  `persona` → `memoria/personas/`, el resto → `memoria/`), pasa a `status: stable`, se añade a
  su `index.md` y se anota en `log.md`. Decisiones y aprendizajes llevan prefijo `AAAA-MM-DD-`.
  Nunca pisa un fichero: si existe, `-2`, `-3`…
- **Dudoso** (ficha incompleta o `type` desconocido): se queda donde está y sale en consola
  como `DUDOSO: … — motivo`.

**Sincronización con git** (tras promover):

- Commit solo si hay cambios en `memoria/` o `log.md`; solo toca esas rutas, nunca otro trabajo
  sin commitear.
- Push solo si el repo tiene remoto **y** la rama actual tiene upstream; es un `git push` normal
  de la rama actual. Sin remoto o sin upstream no sube y no es un error.
- `--no-commit` (o `CEREBRO_REVISOR_COMMIT=0`) desactiva git por completo; `--no-push`
  (o `CEREBRO_REVISOR_PUSH=0`) hace commit pero no sube. Un fallo de red deja el commit local y
  sale con código 1.

### Revisor automático

> Solo sirve con `guardar.modo: "borrador"`. En modo `directo` (el de por defecto) no hay nada que programar: `cerebro-programar.mjs` y `systemd/` no hacen falta.

Un solo comando programa el revisor para que corra cada hora en tu máquina (usa la raíz
como el resto: `--root`, `CEREBRO_ROOT`, `cerebro.config.json` hacia arriba o el directorio actual):

```bash
# Linux, macOS y Windows (PowerShell o cmd), desde tu carpeta de cerebro:
node /ruta/micerebro-kit/cerebro/cerebro-programar.mjs --aplicar      # programa
node /ruta/micerebro-kit/cerebro/cerebro-programar.mjs --estado       # ¿está programado? (por defecto)
node /ruta/micerebro-kit/cerebro/cerebro-programar.mjs --quitar       # lo deshace
# --dry-run con cualquiera: imprime lo que escribiría y ejecutaría, sin hacerlo
```

Es idempotente (aplicar dos veces deja lo mismo) y hay una sola programación por usuario:
aplicar con otra raíz sustituye a la anterior. Todo lo que crea lleva la marca «Generado por cerebro-programar.mjs»: si ya hay algo con ese nombre que no es suyo (un enlace simbólico, una unit o tarea tuya), aborta sin tocarlo; `--forzar` lo sustituye. Todo se escribe fuera de tu cerebro, en la
carpeta del usuario, y siempre con rutas absolutas (`node` incluido).

| Sistema | Qué crea | Log |
|---|---|---|
| Linux | `~/.config/systemd/user/cerebro-revisor.{service,timer}` (generadas desde `systemd/`), `systemctl --user enable --now cerebro-revisor.timer` | `journalctl --user -u cerebro-revisor` |
| macOS | LaunchAgent `~/Library/LaunchAgents/io.github.adriamg98.cerebro-revisor.plist` (`StartInterval` 3600 + `RunAtLoad`), cargado con `launchctl bootstrap gui/<uid>` | `registro/cerebro-revisor.log` de tu cerebro si existe la carpeta; si no, `~/Library/Logs/cerebro-revisor.log` |
| Windows | tarea `cerebro-revisor` de `schtasks` cada hora + `%LOCALAPPDATA%\cerebro-revisor\cerebro-revisor.vbs` (con la ruta de node dentro, en UTF-16) | sin log propio (ejecútalo a mano para ver la salida) |

En Windows la tarea no abre ventana: `schtasks` lanza `wscript.exe //B`, y el `.vbs` ejecuta
node con la ventana oculta; la tarea solo lleva la raíz como argumento. Es lo más robusto porque viene en todo Windows y no depende de
opciones de consola que cambian entre versiones. Como `schtasks /TR` admite 261 caracteres,
una ruta muy larga da error claro: usa una más corta.

Para hacerlo a mano en Linux, copia las units de `systemd/` a `~/.config/systemd/user/`,
edita `CEREBRO_ROOT` y `ExecStart`, y lanza `systemctl --user daemon-reload` y
`systemctl --user enable --now cerebro-revisor.timer`.

## cerebro.config.json

Opcional, en la raíz del cerebro. Elige preset (hoy solo `micerebro`) y **sustituye cualquier
campo** del preset, así que una estructura de carpetas distinta no necesita tocar el código. Todas
las rutas son relativas a la raíz y no pueden salir de ella.

```json
{
  "preset": "micerebro",
  "tipos": ["nota", "decision", "idea"],
  "tipoDefecto": "nota",
  "borradoresDir": "bandeja/borradores",
  "caducables": ["notas"],
  "fuentes": [
    { "dir": "notas", "source": "notas", "depth": 5,
      "indiceFile": "index.md", "indiceFormato": "estrella", "indicePorCarpeta": true,
      "exclude": ["archivo"], "ignorarFicheros": ["index.md", "log.md"] },
    { "archivo": "LEEME.md", "source": "leeme" }
  ],
  "leer": { "dirs": ["notas"], "ignorarFicheros": ["index.md", "log.md"] },
  "revisor": {
    "destinos": { "decision": "notas/decisiones" },
    "datados": ["decision"],
    "carpetaDefecto": "notas",
    "log": "log.md",
    "rutasSincronizadas": ["notas", "log.md"]
  }
}
```

| Campo | Para qué sirve |
|---|---|
| `tipos`, `tipoDefecto` | Valores válidos de `type`; el defecto permite `cerebro guardar "Título"` sin tipo. |
| `campoNombre` | Clave de la ficha que es el nombre de la nota (`title` por defecto). |
| `pesosTipo` | Peso de cada `type` en el ranking de `buscar`. |
| `borradoresDir` | Dónde caen los borradores. |
| `caducables` | Etiquetas `source` que mira `cerebro caducados`. |
| `fuentes` | Qué carpetas/ficheros indexa `buscar`. Por fuente: `dir` o `archivo`, `source` (etiqueta), `depth`, `indiceFile` + `indiceFormato` (`estrella`: `* [t](r) - d`, o `guion`: `- [t](r) — d`), `indicePorCarpeta`, `soloIndice`, `exclude`, `ignorarFicheros`, `contiene`. |
| `leer` | Carpetas donde `cerebro_leer`/`cerebro_listar` buscan. |
| `revisor` | `destinos` (carpeta por `type`), `datados` (types con prefijo de fecha), `carpetaDefecto`, `log`, `rutasSincronizadas` (lo único que viaja en el commit). |
| `guardar` | `modo: "directo"` (defecto: la nota nace promovida, con `index.md` y `log.md`; un slug repetido añade `-2`, `-3`…), `"borrador"` (nace en `borradoresDir` y la promueve el revisor) o `"indice"` (el CLI escribe la nota directa y añade su línea a un índice; requiere `destinos` y `defecto`; el MCP en este modo guarda borradores). |

Un fichero con JSON roto, un preset desconocido o una ruta fuera de la raíz da un error claro.

## Plugin de Hermes (`hermes-enchufe/`)

Conecta la memoria de Hermes con MiCerebro: en el primer turno de cada sesión busca en MiCerebro y se lo
presta al modelo; expone las tools `cerebro_buscar` y `cerebro_guardar`; y espeja la libreta integrada de
Hermes a MiCerebro (con el modo directo, ya promovido). Si MiCerebro no responde, avisa una vez y encola lo pendiente en
`enchufe-pendientes.jsonl` (se reintenta después). Nunca lanza excepciones hacia Hermes.

```bash
python3 hermes-enchufe/instalar-enchufe.py                 # ensayo: enseña qué haría
python3 hermes-enchufe/instalar-enchufe.py --aplicar       # symlink en <HERMES_HOME>/plugins + provider: enchufe
python3 hermes-enchufe/instalar-enchufe.py --deshacer <backup.tar.gz>
```

Usa `--hermes-home` si tu Hermes no está en `~/.hermes`. Reinicia Hermes después.

Configuración, solo por entorno:

| Variable | Valor |
|---|---|
| `CEREBRO_ROOT` | Raíz de tu cerebro (la lee MiCerebro). Sin ella, el enchufe la deduce de dónde está instalado (`<raíz>/.cerebro/hermes-enchufe`, o `ENCHUFE_CEREBRO_PATH` dentro de `<raíz>/.cerebro/`, con `<raíz>/cerebro.config.json`) y se la pasa a cerebro. Un gateway ya arrancado no relee el `.env`: reinicia Hermes tras cambiarlo. |
| `ENCHUFE_CEREBRO_PATH` | Ruta a `cerebro.mjs` o a la carpeta `cerebro/`. Sin ella: `cerebro/` junto a `hermes-enchufe/`. |
| `ENCHUFE_CEREBRO_CMD` | Comando completo para invocar MiCerebro (gana a lo anterior), p. ej. `node /ruta/cerebro/cerebro.mjs`. |
| `ENCHUFE_CEREBRO_MCP_CMD` | Comando de `cerebro-mcp.mjs` (por defecto, el de arriba con `cerebro-mcp.mjs`). |
| `ENCHUFE_TIPOS` | Tipos de nota admitidos, separados por comas (por defecto los de MiCerebro). |
| `ENCHUFE_PERFIL` | Nombre del perfil (por defecto, deducido de `HERMES_HOME`). |
| `ENCHUFE_GBRAIN_URL`, `ENCHUFE_GBRAIN_TOKEN` | Opcionales: activan la tool `gbrain_query`, una búsqueda semántica contra un servidor MCP HTTP compatible. |

**Windows con Hermes en Windows y MiCerebro dentro de WSL:** si el plugin está bajo
`\\wsl.localhost\<distro>\…`, MiCerebro se lanza con `wsl.exe -d <distro> -e node …` y se le pasa
`CEREBRO_ROOT` (que debe ser una ruta de Linux). Si no, define `ENCHUFE_CEREBRO_CMD` a mano.

Los secretos (token de gbrain, etc.) van en el entorno del servicio, nunca en el repo.

## Traer tu memoria de otro sitio (`cerebro-migrar`)

Copia memoria que ya tienes al formato MiCerebro. **Siempre copia**: no borra ni toca el origen,
no pisa ningún destino (si existe, `-2`, `-3`…) y no escribe fuera de la raíz del cerebro ni
sigue enlaces simbólicos. Primero inventario, después aplicar:

```bash
node cerebro/cerebro-migrar.mjs --origen <ruta> [--tipo libreta|carpeta|planes|auto] [--root <MiCerebro>] --dry-run
node cerebro/cerebro-migrar.mjs --origen <ruta> [--tipo ...] [--root <MiCerebro>] --aplicar   # tras revisar el inventario
```

| `--tipo` | Origen | Qué hace |
|---|---|---|
| `libreta` | `MEMORY.md` / `USER.md` de Hermes (entradas separadas por `§`) | cada entrada es una nota en `memoria/personas/` o `memoria/` (`USER.md` → `persona`, `MEMORY.md` → `nota`); en modo borrador, un borrador en `memoria/borradores/` |
| `carpeta` | carpeta Markdown u Obsidian | cada `.md` pasa a nota con ficha (`type`, `title`, `description`, `status`, `actualizado`) |
| `planes` | `.md` de planes | todo a `planes/` con `type: plan` |
| `auto` (por defecto) | | `MEMORY.md`/`USER.md` o ficheros con `§` → libreta; si no, carpeta |

Reglas de `carpeta`:

* **Tipos.** Se conserva el `type` si es de MiCerebro; `user`→`persona`, `feedback`→`aprendizaje`, `project`→`proyecto`, `reference`→`recurso`, `note`→`nota`; cualquier otro cae en `nota` y el inventario lo avisa. El tipo original queda en `tipo_original`.
* **Destino.** `proyecto`, `area`, `recurso` y `plan` van directos a `proyectos/`, `areas/`, `recursos/`, `planes/`. Todo lo demás (`nota`, `decision`, `aprendizaje`, `persona`…) se escribe ya promovido en su carpeta de `memoria/` (`status: stable`, con `index.md` y `log.md`); con `guardar.modo: "borrador"` entra en `memoria/borradores/` con `status: draft` y lo coloca el revisor.
* **Frontmatter.** Lo que ya tenía (`tags`, etc.) se conserva; `name` hace de `title`; si falta `description` se toma de la primera línea. Se añade `origen` (ruta relativa de la nota en el origen). `actualizado` sale del propio frontmatter (`actualizado`, `updated`, `date`) o de la fecha del fichero.
* **Enlaces.** `[[nota]]`, `[[nota|alias]]`, `[[nota#sección]]` y `[texto](otra.md)` pasan a enlace Markdown relativo al fichero destino; si la nota no se migra, queda el texto plano. `![[imagen.png]]` apunta al adjunto copiado. Bloques de código y `código en línea` no se tocan.
* **Adjuntos.** Lo que no es `.md` se copia tal cual a `recursos/adjuntos/<carpeta-origen>/` (`--sin-adjuntos` para no copiarlos). Se ignoran `.obsidian/`, `.git/`, `node_modules/` y todo lo que empiece por `.`.

Al aplicar queda `registro/AAAA-MM-DD-migrar-<nombre>.md` con la tabla origen → destino y el
sha256 de cada origen.

## Tests

```bash
node --test                                  # MiCerebro (CLI, MCP, config, revisor, sync git)
python3 -m pytest hermes-enchufe/tests -q    # plugin (necesita pytest; usa un stub de Hermes si no está instalado)
```

## Sobre el formato

La estructura (carpetas con `index.md`, `log.md`, fichas YAML sobre Markdown, `okf_version` en el
índice raíz) sigue el espíritu del **Open Knowledge Format** (OKF), una especificación abierta
de Google Cloud Platform: <https://github.com/GoogleCloudPlatform/open-knowledge-format>. Este
repositorio es una implementación independiente y no incluye texto ni código de esa especificación;
consúltala allí. No está afiliado a Google ni avalado por Google; la especificación OKF es suya
(licencia Apache-2.0) y aquí solo se usa como referencia de formato.

## Licencia

MIT-0 (MIT No Attribution): haz lo que quieras, sin obligación de atribuir. Ver `LICENSE`.
Copyright 2026 Adrià Martínez.
