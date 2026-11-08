# okf — memoria curada en Markdown para agentes

Una memoria de largo plazo para tus agentes de IA que es **solo una carpeta de ficheros
Markdown**. Sin base de datos, sin dependencias: Node 18+ y git.

- `okf.mjs` — CLI: `buscar`, `guardar`, `caducados`.
- `okf-mcp.mjs` — servidor MCP (stdio) con las mismas herramientas, para Claude Code, Codex, Hermes…
- `okf-revisor.mjs` — revisa los **borradores** que escriben los agentes y promueve a la memoria los buenos.
- `hermes-enchufe/` — plugin de memoria para Hermes Agent que usa todo lo anterior.

La idea: los agentes **nunca escriben directamente en tu memoria**. Todo lo que guardan nace
como borrador en `memoria/borradores/`; el revisor (determinista, sin LLM) comprueba la ficha,
mueve la nota a su carpeta, la apunta en el `index.md` y deja una línea en `log.md`. Y como la
memoria es una carpeta, también es un repo git: cada promoción queda commiteada.

## Instalación

```bash
git clone https://github.com/AdriaMG98/okf.git ~/okf-kit
cp -r ~/okf-kit/ejemplo ~/MiCerebro
cd ~/MiCerebro && git init -b main && git add -A && git commit -m "MiCerebro vacío"
export OKF_ROOT=~/MiCerebro        # opcional si trabajas dentro de ~/MiCerebro (ver «Raíz»)
node ~/okf-kit/okf/okf.mjs --help
```

No hay nada que compilar ni instalar. Si quieres un atajo: `alias okf='node ~/okf-kit/okf/okf.mjs'`.

## Estructura MiCerebro

```
MiCerebro/
├── okf.config.json        # opcional: preset y ajustes (ver más abajo)
├── index.md               # mapa de carpetas
├── log.md                 # diario: una línea «Creación» por nota promovida
├── memoria/               # lo que debe durar
│   ├── index.md
│   ├── borradores/        # aquí caen las notas de los agentes (okf guardar / okf_guardar)
│   ├── decisiones/        # AAAA-MM-DD-titulo.md
│   ├── aprendizajes/      # AAAA-MM-DD-titulo.md
│   └── personas/
├── planes/                # planes vivos
├── proyectos/             # cosas con un final
├── areas/                 # responsabilidades que no terminan
└── recursos/              # material de consulta por tema
```

Cada carpeta tiene su `index.md` con una línea por nota: `* [Título](fichero.md) - descripción`.
`buscar` usa esas descripciones para puntuar; el revisor las mantiene. `ejemplo/` es un cerebro
vacío con esta estructura y un borrador de muestra.

Una nota es un `.md` con ficha YAML al principio:

```markdown
---
type: aprendizaje            # proyecto | area | recurso | nota | decision | aprendizaje | plan | persona | ficha-externa | registro | skill
title: "Riego de tomates"
description: "Regar por la mañana evita el moho."
status: draft                # draft hasta que el revisor la promueve (entonces stable)
actualizado: 2026-11-08
---

Cuerpo de la nota. Enlaces entre notas con [[otro-titulo]].
```

## Raíz: de dónde sale la carpeta del cerebro

Todos los programas (`okf.mjs`, `okf-mcp.mjs`, `okf-revisor.mjs`) resuelven la raíz así, por orden:

1. `--root <ruta>`
2. variable de entorno `OKF_ROOT`
3. subir desde el directorio actual hasta encontrar un `okf.config.json`
4. el directorio actual

Nunca se deduce de dónde están los scripts: puedes tenerlos en cualquier sitio.

## CLI

```bash
okf buscar "cómo regar tomates"            # devuelve la nota ganadora, no una lista
okf buscar "tomates" --todo                # incluye borradores y archivados
okf buscar "tomates" --debug               # puntuaciones
echo "Texto de la nota" | okf guardar aprendizaje "Título" --body -   # crea un borrador
echo "Texto" | okf guardar "Título" --body -                          # tipo por defecto: nota
okf caducados                              # notas sin tocar en 30 días y enlaces [[rotos]] (no borra nada)
```

La búsqueda es léxica y determinista (sin embeddings): puntúa título + descripción, desempata
con el cuerpo, pondera por `type` y deja fuera borradores y `_archivo/`.

## Servidor MCP

Tools: `okf_buscar`, `okf_leer`, `okf_listar`, `okf_guardar` (siempre borrador) y `okf_caducados`.
Se lanza con `node /ruta/okf-kit/okf/okf-mcp.mjs` y toma la raíz como arriba (`--root` u `OKF_ROOT`).

**Claude Code**

```bash
claude mcp add okf -e OKF_ROOT=$HOME/MiCerebro -- node $HOME/okf-kit/okf/okf-mcp.mjs
```

**Codex** (`~/.codex/config.toml`; TOML y YAML no expanden `$HOME`: cambia `/home/TU_USUARIO` por tu ruta)

```toml
[mcp_servers.okf]
command = "node"
args = ["/home/TU_USUARIO/okf-kit/okf/okf-mcp.mjs"]
env = { OKF_ROOT = "/home/TU_USUARIO/MiCerebro" }
```

**Hermes Agent** (`config.yaml` del perfil; alternativa al plugin de abajo)

```yaml
mcp_servers:
  okf:
    command: node
    args: ["/home/TU_USUARIO/okf-kit/okf/okf-mcp.mjs"]
    env:
      OKF_ROOT: /home/TU_USUARIO/MiCerebro
```

Dile a tu agente en su fichero de instrucciones (`CLAUDE.md`, `AGENTS.md`…) que busque con
`okf_buscar` antes de preguntarte algo y que guarde con `okf_guardar` lo que valga la pena conservar.

## Revisor de borradores

```bash
node okf/okf-revisor.mjs --dry-run          # ensayo: lista qué promovería, no escribe nada
node okf/okf-revisor.mjs                    # promueve y commitea
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
- `--no-commit` (o `OKF_REVISOR_COMMIT=0`) desactiva git por completo; `--no-push`
  (o `OKF_REVISOR_PUSH=0`) hace commit pero no sube. Un fallo de red deja el commit local y
  sale con código 1.

### Timer de systemd (usuario)

```bash
mkdir -p ~/.config/systemd/user
cp systemd/okf-revisor.service systemd/okf-revisor.timer ~/.config/systemd/user/
# edita OKF_ROOT y la ruta de ExecStart (usan %h = tu carpeta personal)
systemctl --user daemon-reload
systemctl --user enable --now okf-revisor.timer
systemctl --user list-timers okf-revisor.timer
```

En macOS, el equivalente es un `launchd` o un `cron` que ejecute el mismo comando.

## okf.config.json

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
| `tipos`, `tipoDefecto` | Valores válidos de `type`; el defecto permite `okf guardar "Título"` sin tipo. |
| `campoNombre` | Clave de la ficha que es el nombre de la nota (`title` por defecto). |
| `pesosTipo` | Peso de cada `type` en el ranking de `buscar`. |
| `borradoresDir` | Dónde caen los borradores. |
| `caducables` | Etiquetas `source` que mira `okf caducados`. |
| `fuentes` | Qué carpetas/ficheros indexa `buscar`. Por fuente: `dir` o `archivo`, `source` (etiqueta), `depth`, `indiceFile` + `indiceFormato` (`estrella`: `* [t](r) - d`, o `guion`: `- [t](r) — d`), `indicePorCarpeta`, `soloIndice`, `exclude`, `ignorarFicheros`, `contiene`. |
| `leer` | Carpetas donde `okf_leer`/`okf_listar` buscan. |
| `revisor` | `destinos` (carpeta por `type`), `datados` (types con prefijo de fecha), `carpetaDefecto`, `log`, `rutasSincronizadas` (lo único que viaja en el commit). |
| `guardar` | `modo: "borrador"` (defecto) o `"indice"` (el CLI escribe la nota directa y añade su línea a un índice; requiere `destinos` y `defecto`). El MCP y el revisor siempre usan borradores. |

Un fichero con JSON roto, un preset desconocido o una ruta fuera de la raíz da un error claro.

## Plugin de Hermes (`hermes-enchufe/`)

Conecta la memoria de Hermes con okf: en el primer turno de cada sesión busca en okf y se lo
presta al modelo; expone las tools `okf_buscar` y `okf_guardar`; y espeja la libreta integrada de
Hermes a borradores. Si okf no responde, avisa una vez y encola lo pendiente en
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
| `OKF_ROOT` | Raíz de tu cerebro (la lee okf). |
| `ENCHUFE_OKF_PATH` | Ruta a `okf.mjs` o a la carpeta `okf/`. Sin ella: `okf/` junto a `hermes-enchufe/`. |
| `ENCHUFE_OKF_CMD` | Comando completo para invocar okf (gana a lo anterior), p. ej. `node /ruta/okf/okf.mjs`. |
| `ENCHUFE_OKF_MCP_CMD` | Comando de `okf-mcp.mjs` (por defecto, el de arriba con `okf-mcp.mjs`). |
| `ENCHUFE_TIPOS` | Tipos de nota admitidos, separados por comas (por defecto los de MiCerebro). |
| `ENCHUFE_PERFIL` | Nombre del perfil (por defecto, deducido de `HERMES_HOME`). |
| `ENCHUFE_GBRAIN_URL`, `ENCHUFE_GBRAIN_TOKEN` | Opcionales: activan la tool `gbrain_query`, una búsqueda semántica contra un servidor MCP HTTP compatible. |

**Windows con Hermes en Windows y okf dentro de WSL:** si el plugin está bajo
`\\wsl.localhost\<distro>\…`, okf se lanza con `wsl.exe -d <distro> -e node …` y se le pasa
`OKF_ROOT` (que debe ser una ruta de Linux). Si no, define `ENCHUFE_OKF_CMD` a mano.

Los secretos (token de gbrain, etc.) van en el entorno del servicio, nunca en el repo.

## Tests

```bash
node --test                                  # okf (CLI, MCP, config, revisor, sync git)
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
