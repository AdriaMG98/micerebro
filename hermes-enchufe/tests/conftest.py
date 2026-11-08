"""Carga el plugin (carpeta con guion) y, si Hermes no es importable, un stub mínimo del contrato."""
import importlib.util
import re
import sys
import threading
import types
from pathlib import Path

import pytest

try:  # Hermes real (p. ej. PYTHONPATH=~/.hermes/hermes-agent)
    import agent.memory_provider  # noqa: F401
except ImportError:
    mod = types.ModuleType("agent.memory_provider")

    class MemoryProvider:  # solo lo que usa el plugin
        pass

    _TRIV = re.compile(r"^(yes|no|ok|okay|thanks|hi|hey|hello|done|next)[\s!?.]*$", re.I)

    def is_trivial_prompt(text):
        s = (text or "").strip()
        return not s or s.startswith("/") or bool(_TRIV.match(s))

    def spawn_context_thread(target, *, name, daemon=True, args=(), kwargs=None):
        return threading.Thread(target=target, args=args, kwargs=kwargs, name=name, daemon=daemon)

    from dataclasses import dataclass

    @dataclass(frozen=True)
    class RecallStatus:
        provider_label: str
        count: int
        glyph: str = "🧠"

    mod.RecallStatus = RecallStatus
    mod.MemoryProvider, mod.is_trivial_prompt, mod.spawn_context_thread = MemoryProvider, is_trivial_prompt, spawn_context_thread
    pkg = types.ModuleType("agent")
    pkg.memory_provider = mod
    sys.modules.update({"agent": pkg, "agent.memory_provider": mod})

RAIZ = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def enchufe():
    spec = importlib.util.spec_from_file_location("enchufe_plugin", RAIZ / "__init__.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
