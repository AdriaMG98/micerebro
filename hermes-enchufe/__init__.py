"""Enchufe — plugin MemoryProvider de Hermes que conecta su memoria con okf (MiCerebro).

Config SOLO por entorno (sin save_config nativo):
  OKF_ROOT               raíz del cerebro (carpeta con memoria/, planes/…); la lee okf directamente.
                         Sin ella, okf usa el okf.config.json más cercano hacia arriba desde el cwd.
  ENCHUFE_OKF_CMD        comando completo para invocar okf.mjs (gana a todo lo demás), p. ej.
                         `node /ruta/a/okf/okf.mjs` o `wsl.exe -e node /ruta/en/wsl/okf/okf.mjs`
  ENCHUFE_OKF_PATH       ruta a okf.mjs (o a la carpeta okf/ que lo contiene)
                         Si no hay ninguna de las dos: `okf/okf.mjs` junto a la carpeta de este plugin.
  ENCHUFE_OKF_MCP_CMD    comando de okf-mcp.mjs, para guardar borradores (def.: el de okf.mjs con okf-mcp.mjs)
  ENCHUFE_TIPOS          tipos de nota admitidos, separados por comas (def.: los de MiCerebro)
  ENCHUFE_PERFIL         nombre del perfil (def.: deducido del HERMES_HOME)
  ENCHUFE_GBRAIN_URL / ENCHUFE_GBRAIN_TOKEN   opcionales: activan la tool gbrain_query (integración
                         genérica con un servidor MCP HTTP de búsqueda semántica)
Los borradores van a memoria/borradores/ vía okf-mcp (los promueve el revisor).
Nunca lanza excepciones hacia Hermes.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import queue
import re
import shlex
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from agent.memory_provider import MemoryProvider, is_trivial_prompt, spawn_context_thread

try:
    import fcntl  # Windows no lo tiene: sin flock, en silencio
except ImportError:
    fcntl = None
try:
    from agent.memory_provider import RecallStatus
except ImportError:
    RecallStatus = None

logger = logging.getLogger(__name__)

_BUSCAR_TIMEOUT = 5.0  # Hermes corta el prefetch a 8,0 s (memory_manager.py)
_GUARDAR_TIMEOUT = 20.0
_SHUTDOWN_TIMEOUT = 10.0
_MAX_PREFETCH_CHARS = 6000
_TIPOS_DEFECTO = ("nota", "decision", "aprendizaje", "proyecto", "area", "recurso", "persona")
_AVISO = "⚠ Memoria okf no disponible: sigo solo con la libreta"
_STOP = object()

_BLOQUE = (
    "Memoria de largo plazo: vive en okf (MiCerebro), compartida con el resto de tus agentes. "
    "Antes de preguntarle algo al usuario sobre él o sus proyectos, busca con okf_buscar. "
    "Lo que aprendas y valga la pena conservar, guárdalo con okf_guardar: queda como borrador "
    "y lo promueve el revisor. La libreta integrada se espeja sola a okf."
)


# En Windows, lanzar wsl.exe desde el gateway (sin consola) abriría una ventana por llamada.
_SIN_VENTANA = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _wsl_cmd(ruta_unc: str) -> list[str]:
    """Windows con el plugin en \\\\wsl.localhost\\<distro>\\...: okf corre dentro del WSL.
    Devuelve [] si la ruta no es del WSL. Si hay OKF_ROOT (una ruta de Linux, la del WSL) se le pasa."""
    m = re.match(r"^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)$", ruta_unc, re.I)
    if not m:
        return []
    distro, linux = m.group(1), m.group(2).replace("\\", "/")
    raiz = os.environ.get("OKF_ROOT", "").strip()
    entorno = ["env", f"OKF_ROOT={raiz}"] if raiz else []
    return ["wsl.exe", "-d", distro, "--cd", "~", "-e", *entorno, "node", linux]


def _ruta_okf_js() -> Path:
    """okf.mjs: ENCHUFE_OKF_PATH (fichero o carpeta okf/) o la carpeta `okf/` hermana de este plugin."""
    raw = os.environ.get("ENCHUFE_OKF_PATH", "").strip()
    if raw:
        ruta = Path(raw).expanduser()
        return ruta / "okf.mjs" if ruta.is_dir() else ruta
    return Path(__file__).resolve().parents[1] / "okf" / "okf.mjs"


def _default_okf_cmd() -> list[str]:
    ruta = _ruta_okf_js()
    if os.name == "nt":
        return _wsl_cmd(str(ruta)) or ["node", str(ruta)]
    return ["node", str(ruta)]


def _tipos() -> tuple[str, ...]:
    raw = os.environ.get("ENCHUFE_TIPOS", "").strip()
    tipos = tuple(t.strip() for t in raw.split(",") if t.strip())
    return tipos or _TIPOS_DEFECTO


def _tipo_espejo(target: str) -> str:
    """Tipo del borrador que espeja una entrada de la libreta: lo del usuario es un aprendizaje, el resto una nota."""
    deseado = "aprendizaje" if target == "user" else "nota"
    tipos = _tipos()
    return deseado if deseado in tipos else tipos[0]


def _split(cmd: str) -> list[str]:
    return shlex.split(cmd, posix=True)


def _okf_cmd() -> list[str]:
    raw = os.environ.get("ENCHUFE_OKF_CMD", "").strip()
    return _split(raw) if raw else _default_okf_cmd()


def _okf_mcp_cmd() -> list[str]:
    raw = os.environ.get("ENCHUFE_OKF_MCP_CMD", "").strip()
    if raw:
        return _split(raw)
    cmd = _okf_cmd()
    if cmd and cmd[-1].endswith("okf.mjs"):
        return cmd[:-1] + [cmd[-1][: -len("okf.mjs")] + "okf-mcp.mjs"]
    return []


def _run_okf_buscar(pregunta: str, timeout: float = _BUSCAR_TIMEOUT) -> str:
    """`okf buscar`; lanza RuntimeError si okf no responde."""
    try:
        r = subprocess.run(_okf_cmd() + ["buscar", pregunta], capture_output=True, text=True,
                           encoding="utf-8", timeout=timeout, creationflags=_SIN_VENTANA)
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"okf no responde: {e}") from e
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "okf terminó con error").strip()[:300])
    return r.stdout.strip()


def _run_okf_guardar(tipo: str, titulo: str, cuerpo: str, timeout: float = _GUARDAR_TIMEOUT) -> str:
    """okf_guardar vía okf-mcp (stdio, una sola vuelta): siempre borrador. RuntimeError si falla."""
    cmd = _okf_mcp_cmd()
    if not cmd:
        raise RuntimeError("sin comando okf-mcp (define ENCHUFE_OKF_MCP_CMD)")
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "enchufe", "version": "1.0.0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "okf_guardar", "arguments": {"tipo": tipo, "titulo": titulo, "cuerpo": cuerpo}}},
    ]
    try:
        r = subprocess.run(cmd, input="\n".join(json.dumps(m) for m in msgs) + "\n", capture_output=True,
                           text=True, encoding="utf-8", timeout=timeout, creationflags=_SIN_VENTANA)
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"okf-mcp no responde: {e}") from e
    for line in r.stdout.splitlines():
        try:
            resp = json.loads(line)
        except ValueError:
            continue
        if resp.get("id") != 2:
            continue
        res = resp.get("result") or {}
        texto = " ".join(c.get("text", "") for c in res.get("content", []))
        if res.get("isError") or "error" in resp:
            raise RuntimeError(texto or str(resp.get("error")))
        return texto
    raise RuntimeError((r.stderr or "okf-mcp sin respuesta").strip()[:300])


def _gbrain_call(url: str, token: str, tool: str, args: dict, timeout: float = 20.0) -> str:
    """Llamada a una tool del MCP HTTP de gbrain (JSON-RPC por POST; acepta JSON o SSE)."""
    sid: dict[str, str] = {}

    def post(body: dict) -> dict | None:
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": f"Bearer {token}", **sid}
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.headers.get("Mcp-Session-Id"):
                sid["Mcp-Session-Id"] = resp.headers["Mcp-Session-Id"]
            raw = resp.read().decode("utf-8", "replace")
        if "id" not in body:
            return None
        for chunk in raw.splitlines():
            chunk = chunk[5:].strip() if chunk.startswith("data:") else chunk.strip()
            if chunk.startswith("{"):
                try:
                    return json.loads(chunk)
                except ValueError:
                    pass
        raise RuntimeError("respuesta MCP ilegible")

    post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "enchufe", "version": "1.0.0"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    resp = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}}) or {}
    if "error" in resp:
        raise RuntimeError(str(resp["error"])[:300])
    res = resp.get("result") or {}
    texto = " ".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise RuntimeError(texto[:300])
    return texto[:_MAX_PREFETCH_CHARS * 2]


def _titulo(content: str, perfil: str = "") -> str:
    palabras = " ".join(content.split()).split(" ")[:8]
    base = " ".join(palabras).strip(" .,:;-—") or "apunte de Hermes"
    # sufijo corto (perfil+contenido): okf-mcp sobrescribe si el slug ya existe
    return f"{base} {hashlib.sha1(f'{perfil}\0{content}'.encode('utf-8')).hexdigest()[:6]}"


class EnchufeMemoryProvider(MemoryProvider):
    """Memoria de Hermes ↔ okf. Una instancia por perfil (contrato de multiplexado)."""

    def __init__(self):
        self._session_id = ""
        self._perfil = ""
        self._home: Path | None = None
        self._primary = True
        self._lock = threading.Lock()          # cola de pendientes + estado de sesión
        self._prefetched: set[str] = set()     # sesiones que ya hicieron su prefetch
        self._avisadas: set[str] = set()       # sesiones que ya vieron el aviso Q5
        self._queue: queue.Queue = queue.Queue()
        self._writer: threading.Thread | None = None
        self._pending_mem: list[dict] = []     # respaldo si no hay hermes_home
        self._status = None                    # RecallStatus del último prefetch

    # -- identidad / disponibilidad ------------------------------------------

    @property
    def name(self) -> str:
        return "enchufe"

    def is_available(self) -> bool:
        try:
            cmd = _okf_cmd()
            if not cmd or not (len(cmd) > 1 or os.environ.get("ENCHUFE_OKF_CMD")):
                return False
            # `node <ruta>` local: el .mjs debe existir (con wsl.exe no se puede comprobar)
            if Path(cmd[0]).name in ("node", "node.exe") and len(cmd) > 1 and cmd[-1].endswith(".mjs"):
                return Path(cmd[-1]).exists()
            return True
        except Exception:
            return False

    def unavailable_reason(self) -> str:
        return "Enchufe: define ENCHUFE_OKF_CMD (comando para invocar okf.mjs)."

    def initialize(self, session_id: str, **kwargs) -> None:
        try:
            self._session_id = session_id or ""
            hh = kwargs.get("hermes_home")
            self._home = Path(hh) if hh else None
            self._primary = kwargs.get("agent_context", "primary") == "primary"
            self._perfil = (os.environ.get("ENCHUFE_PERFIL", "").strip() or self._perfil_de_home())
            if self._writer is None:
                self._writer = spawn_context_thread(self._writer_loop, name="enchufe-writer")
                self._writer.start()
        except Exception:  # nunca hacia Hermes
            logger.exception("enchufe: fallo en initialize")

    def _perfil_de_home(self) -> str:
        if self._home is None:
            return "default"
        if self._home.parent.name == "profiles":
            return self._home.name
        return "default"

    def system_prompt_block(self) -> str:
        return _BLOQUE

    # -- prefetch (solo el primer turno no trivial de cada sesión) -----------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        try:
            self._status = None
            sid = session_id or self._session_id
            if is_trivial_prompt(query):
                return ""
            with self._lock:
                if sid in self._prefetched:
                    return ""
                self._prefetched.add(sid)
            resultado: dict[str, Any] = {}

            def trabajo():
                try:
                    resultado["texto"] = _run_okf_buscar(query, _BUSCAR_TIMEOUT)
                except Exception as e:  # noqa: BLE001
                    resultado["error"] = str(e)

            t = spawn_context_thread(trabajo, name="enchufe-prefetch")
            t.start()
            t.join(_BUSCAR_TIMEOUT + 1)
            if "texto" in resultado:
                if not resultado["texto"]:
                    return ""
                self._status = self._mk_status("Memoria okf", 0)
                return f"## Memoria okf\n{resultado['texto'][:_MAX_PREFETCH_CHARS]}"
            logger.warning("enchufe: okf no disponible en prefetch: %s", resultado.get("error", "timeout"))
            with self._lock:
                if sid in self._avisadas:
                    return ""
                self._avisadas.add(sid)
            self._status = self._mk_status("Memoria okf no disponible", 0, "⚠")
            return _AVISO
        except Exception:
            logger.exception("enchufe: fallo en prefetch")
            return ""

    @staticmethod
    def _mk_status(label: str, count: int, glyph: str = ""):
        if RecallStatus is None:
            return None
        return RecallStatus(label, count, glyph) if glyph else RecallStatus(label, count)

    def recall_status(self):
        return self._status

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False,
                          rewound: bool = False, **kwargs) -> None:
        try:
            if new_session_id and new_session_id != self._session_id:
                with self._lock:
                    # compresión/branch traen parent_session_id: no cuentan como sesión nueva
                    if reset or not parent_session_id:
                        self._prefetched.discard(new_session_id)
                        self._avisadas.discard(new_session_id)
                    self._session_id = new_session_id
        except Exception:
            logger.exception("enchufe: fallo en on_session_switch")

    # -- tools ----------------------------------------------------------------

    def _gbrain(self) -> tuple[str, str] | None:
        url = os.environ.get("ENCHUFE_GBRAIN_URL", "").strip()
        tok = os.environ.get("ENCHUFE_GBRAIN_TOKEN", "").strip()
        return (url, tok) if url and tok else None

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        try:
            return self._tool_schemas()
        except Exception:
            logger.exception("enchufe: fallo en get_tool_schemas")
            return []

    def _tool_schemas(self) -> list[dict[str, Any]]:
        schemas = [
            {"name": "okf_buscar",
             "description": "Busca en la memoria curada (okf, MiCerebro). Úsala antes de preguntarle al usuario.",
             "parameters": {"type": "object", "properties": {"pregunta": {"type": "string"}},
                            "required": ["pregunta"], "additionalProperties": False}},
            {"name": "okf_guardar",
             "description": "Guarda lo aprendido en okf como borrador (lo promueve el revisor).",
             "parameters": {"type": "object", "properties": {
                 "tipo": {"type": "string", "enum": list(_tipos())}, "titulo": {"type": "string"},
                 "cuerpo": {"type": "string"}}, "required": ["tipo", "titulo", "cuerpo"],
                 "additionalProperties": False}},
        ]
        if self._gbrain():
            schemas.append({"name": "gbrain_query",
                            "description": "Búsqueda semántica en gbrain (memoria recuperable).",
                            "parameters": {"type": "object", "properties": {"pregunta": {"type": "string"}},
                                           "required": ["pregunta"], "additionalProperties": False}})
        return schemas

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        try:
            args = args or {}
            if tool_name == "okf_buscar":
                return json.dumps({"resultado": _run_okf_buscar(str(args.get("pregunta", "")))}, ensure_ascii=False)
            if tool_name == "okf_guardar":
                tipo = str(args.get("tipo", ""))
                if tipo not in _tipos():
                    return json.dumps({"error": f"tipo inválido: {tipo}"}, ensure_ascii=False)
                cuerpo = f"{str(args.get('cuerpo', '')).strip()}\n\norigen: hermes/{self._perfil or 'default'}"
                return json.dumps({"resultado": _run_okf_guardar(tipo, str(args.get("titulo", "")), cuerpo)},
                                  ensure_ascii=False)
            if tool_name == "gbrain_query":
                g = self._gbrain()
                if not g:
                    return json.dumps({"error": "gbrain no configurado"}, ensure_ascii=False)
                return json.dumps({"resultado": _gbrain_call(g[0], g[1], "query", {"query": str(args.get("pregunta", ""))})},
                                  ensure_ascii=False)
            return json.dumps({"error": f"tool desconocida: {tool_name}"}, ensure_ascii=False)
        except Exception as e:  # noqa: BLE001
            return json.dumps({"error": str(e)[:300]}, ensure_ascii=False)

    # -- espejo de la libreta -------------------------------------------------

    def on_memory_write(self, action: str, target: str, content: str, metadata: dict[str, Any] | None = None) -> None:
        try:
            if action == "remove":
                logger.info("enchufe: remove en libreta (%s), solo log: %.80s", target, content or "")
                return
            if action not in ("add", "replace") or not (content or "").strip() or not self._primary:
                return
            self._queue.put({"tipo": _tipo_espejo(target),
                             "titulo": _titulo(content, self._perfil),
                             "cuerpo": f"{content.strip()}\n\norigen: hermes/{self._perfil or 'default'}"})
        except Exception:
            logger.exception("enchufe: fallo en on_memory_write")

    def _writer_loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                return
            try:
                self._escribir(item)
            except Exception:  # noqa: BLE001
                logger.exception("enchufe: entrada a pendientes")
                self._push_pending(item)

    def _escribir(self, item: dict, timeout: float | None = None) -> None:
        _run_okf_guardar(item["tipo"], item["titulo"], item["cuerpo"], timeout or _GUARDAR_TIMEOUT)

    # -- cola de pendientes (jsonl en hermes_home; memoria si no hay home) ----

    def _pending_path(self) -> Path | None:
        return self._home / "enchufe-pendientes.jsonl" if self._home else None

    @contextlib.contextmanager
    def _flock(self):
        """flock sobre un .lock junto al jsonl (entre procesos del mismo perfil); sin fcntl, nada."""
        p = self._pending_path()
        f = None
        try:
            if fcntl is not None and p is not None:
                p.parent.mkdir(parents=True, exist_ok=True)
                f = open(p.with_suffix(".lock"), "a")
                fcntl.flock(f, fcntl.LOCK_EX)
        except Exception:
            pass
        try:
            yield
        finally:
            if f is not None:
                with contextlib.suppress(Exception):
                    f.close()

    def _push_pending(self, item: dict) -> None:
        with self._lock, self._flock():
            p = self._pending_path()
            if p is None:
                self._pending_mem.append(item)
                return
            try:
                p.parent.mkdir(parents=True, exist_ok=True)
                with p.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
            except OSError:
                self._pending_mem.append(item)

    def _flush_pending(self, deadline: float) -> None:
        with self._lock, self._flock():
            p = self._pending_path()
            items = list(self._pending_mem)
            self._pending_mem = []
            if p is not None and p.exists():
                try:
                    items += [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
                    p.unlink()
                except (OSError, ValueError):
                    logger.exception("enchufe: pendientes ilegibles")
        fallidos: list[dict] = []
        for i, it in enumerate(items):
            resto = deadline - time.monotonic()
            if resto < 1.0:  # no empezar un guardado que no cabe
                fallidos += items[i:]
                break
            try:
                self._escribir(it, min(_GUARDAR_TIMEOUT, resto))
            except Exception:  # noqa: BLE001
                # okf caído: no insistir con el resto
                fallidos += items[i:]
                break
        for it in fallidos:
            self._push_pending(it)

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:
        try:
            self._flush_pending(time.monotonic() + _SHUTDOWN_TIMEOUT)
        except Exception:
            logger.exception("enchufe: fallo en on_pre_compress")
        return ""

    def shutdown(self) -> None:
        try:
            deadline = time.monotonic() + _SHUTDOWN_TIMEOUT
            if self._writer is not None:
                self._queue.put(_STOP)
                self._writer.join(max(0.1, deadline - time.monotonic()))
                if not self._writer.is_alive():
                    self._writer = None
            stop_visto = False
            while True:  # lo que el escritor no alcanzó va a pendientes
                try:
                    it = self._queue.get_nowait()
                except queue.Empty:
                    break
                if it is _STOP:
                    stop_visto = True
                else:
                    self._push_pending(it)
            if stop_visto:  # el escritor sigue vivo: que aún reciba su señal
                self._queue.put(_STOP)
            self._flush_pending(deadline)
        except Exception:
            logger.exception("enchufe: fallo en shutdown")


def register(ctx) -> None:
    """Registra Enchufe como plugin de memoria."""
    ctx.register_memory_provider(EnchufeMemoryProvider())
