import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

OKF_DIR = Path(__file__).resolve().parents[2] / "okf"


@pytest.fixture
def prov(enchufe, tmp_path, monkeypatch):
    monkeypatch.delenv("ENCHUFE_PERFIL", raising=False)
    monkeypatch.delenv("ENCHUFE_GBRAIN_URL", raising=False)
    monkeypatch.delenv("ENCHUFE_GBRAIN_TOKEN", raising=False)
    home = tmp_path / "profiles" / "demo"
    home.mkdir(parents=True)
    p = enchufe.EnchufeMemoryProvider()
    p.initialize("s1", hermes_home=str(home), platform="cli", agent_context="primary")
    p.calls = {"buscar": [], "guardar": []}
    p.ok = True

    def buscar(q, timeout=8.0):
        p.calls["buscar"].append(q)
        if not p.ok:
            raise RuntimeError("okf caído")
        return "nota: resultado"

    def guardar(tipo, titulo, cuerpo, timeout=20.0):
        if not p.ok:
            raise RuntimeError("okf caído")
        p.calls["guardar"].append((tipo, titulo, cuerpo))
        return "OKF: guardado memoria/x.md"

    monkeypatch.setattr(enchufe, "_run_okf_buscar", buscar)
    monkeypatch.setattr(enchufe, "_run_okf_guardar", guardar)
    yield p
    p.shutdown()


def test_perfil_deducido_del_home(prov):
    assert prov._perfil == "demo"


def test_prefetch_solo_primer_turno(prov):
    assert "resultado" in prov.prefetch("¿qué sabemos del proyecto huerto?", session_id="s1")
    assert prov.prefetch("¿y su teléfono?", session_id="s1") == ""
    assert len(prov.calls["buscar"]) == 1


def test_trivial_no_dispara_ni_gasta_el_turno(prov):
    assert prov.prefetch("ok", session_id="s1") == ""
    assert prov.prefetch("/new", session_id="s1") == ""
    assert prov.calls["buscar"] == []
    assert "resultado" in prov.prefetch("cuéntame del plan hermes", session_id="s1")


def test_sesion_nueva_reinicia(prov):
    prov.prefetch("primera pregunta real", session_id="s1")
    prov.on_session_switch("s2", reset=True)
    assert "resultado" in prov.prefetch("otra pregunta real", session_id="s2")


def test_add_y_replace_generan_borrador(prov):
    prov.on_memory_write("add", "user", "El usuario prefiere respuestas cortas y sin preámbulos")
    prov.on_memory_write("replace", "memory", "El kit de Skool sale con la serie")
    prov.shutdown()
    (t1, ti1, c1), (t2, _, c2) = prov.calls["guardar"]
    assert (t1, t2) == ("aprendizaje", "nota")
    assert ti1.startswith("El usuario prefiere respuestas cortas")
    assert c1.endswith("origen: hermes/demo") and c2.endswith("origen: hermes/demo")


def test_remove_no_guarda(prov):
    prov.on_memory_write("remove", "memory", "algo")
    prov.shutdown()
    assert prov.calls["guardar"] == []


def test_okf_caido_avisa_una_vez_sin_excepcion(prov):
    prov.ok = False
    assert "no disponible" in prov.prefetch("pregunta real uno", session_id="s1")
    assert prov.prefetch("pregunta real dos", session_id="s1") == ""
    prov.on_memory_write("add", "user", "dato que no se puede guardar ahora")
    prov.shutdown()  # no lanza
    pend = Path(prov._home) / "enchufe-pendientes.jsonl"
    assert pend.exists() and "dato que no se puede" in pend.read_text(encoding="utf-8")


def test_on_pre_compress_vacia_pendientes(prov):
    prov.ok = False
    prov.on_memory_write("add", "user", "apunte pendiente de espejar")
    prov.shutdown()
    pend = Path(prov._home) / "enchufe-pendientes.jsonl"
    assert pend.exists()
    prov.ok = True
    assert prov.on_pre_compress([]) == ""
    assert not pend.exists()
    assert len(prov.calls["guardar"]) == 1


def test_tools(prov, enchufe):
    nombres = [s["name"] for s in prov.get_tool_schemas()]
    assert nombres == ["okf_buscar", "okf_guardar"]
    assert "resultado" in json.loads(prov.handle_tool_call("okf_buscar", {"pregunta": "x"}))
    r = json.loads(prov.handle_tool_call("okf_guardar", {"tipo": "nota", "titulo": "t", "cuerpo": "c"}))
    assert "resultado" in r and prov.calls["guardar"][0][2].endswith("origen: hermes/demo")
    assert "error" in json.loads(prov.handle_tool_call("okf_guardar", {"tipo": "zzz", "titulo": "t", "cuerpo": "c"}))
    prov.ok = False
    assert "error" in json.loads(prov.handle_tool_call("okf_buscar", {"pregunta": "x"}))


def test_gbrain_query_solo_con_env(prov, monkeypatch):
    monkeypatch.setenv("ENCHUFE_GBRAIN_URL", "http://x/mcp")
    monkeypatch.setenv("ENCHUFE_GBRAIN_TOKEN", "t")
    assert "gbrain_query" in [s["name"] for s in prov.get_tool_schemas()]


def test_system_prompt_y_register(prov, enchufe):
    assert "okf_buscar" in prov.system_prompt_block() and "okf_guardar" in prov.system_prompt_block()
    got = []

    class Ctx:
        def register_memory_provider(self, p):
            got.append(p)

    enchufe.register(Ctx())
    assert got[0].name == "enchufe"


# -- integración contra okf REAL en un OKF_ROOT temporal ----------------------

@pytest.mark.skipif(not shutil.which("node"), reason="sin node")
def test_integracion_okf_real(enchufe, tmp_path, monkeypatch):
    root = tmp_path / "root"
    ctx = root / "memoria"
    ctx.mkdir(parents=True)
    monkeypatch.setenv("OKF_ROOT", str(root))
    monkeypatch.setenv("ENCHUFE_OKF_CMD", f"node {OKF_DIR / 'okf.mjs'}")
    monkeypatch.delenv("ENCHUFE_OKF_MCP_CMD", raising=False)
    monkeypatch.delenv("ENCHUFE_PERFIL", raising=False)
    home = tmp_path / "profiles" / "atencion"
    home.mkdir(parents=True)
    p = enchufe.EnchufeMemoryProvider()
    p.initialize("s1", hermes_home=str(home), agent_context="primary")
    p.on_memory_write("add", "user", "El usuario prefiere el café sin azúcar por las mañanas")
    p.shutdown()
    # guardar.modo «directo» (el del kit): la nota queda ya promovida, no en borradores/
    notas = list((ctx / "aprendizajes").glob("*.md"))
    assert len([n for n in notas if n.name != "index.md"]) == 1
    assert not (ctx / "borradores").exists()
    txt = next(n for n in notas if n.name != "index.md").read_text(encoding="utf-8")
    assert "type: aprendizaje" in txt and "origen: hermes/atencion" in txt
    assert not (home / "enchufe-pendientes.jsonl").exists()
    # y buscable al instante
    assert "café sin azúcar" in enchufe._run_okf_buscar("café sin azúcar")


# -- ronda de arreglos ---------------------------------------------------------

def test_okf_cuelga_avisa_en_menos_de_6s(enchufe, tmp_path, monkeypatch):
    import sys
    import time
    monkeypatch.setenv("ENCHUFE_OKF_CMD", f"{sys.executable} -c 'import time; time.sleep(30)'")
    monkeypatch.delenv("ENCHUFE_PERFIL", raising=False)
    p = enchufe.EnchufeMemoryProvider()
    p.initialize("s1", hermes_home=str(tmp_path))
    t0 = time.monotonic()
    out = p.prefetch("pregunta real que cuelga", session_id="s1")
    assert time.monotonic() - t0 < 6 and "no disponible" in out
    st = p.recall_status()
    assert st is not None and st.glyph == "⚠"
    p.shutdown()


def test_recall_status_solo_del_ultimo_prefetch(prov):
    assert prov.recall_status() is None
    prov.prefetch("pregunta real", session_id="s1")
    assert prov.recall_status() is not None
    prov.prefetch("otra pregunta", session_id="s1")  # ya no hace recall
    assert prov.recall_status() is None


def test_is_available_comprueba_mjs(enchufe, monkeypatch, tmp_path):
    p = enchufe.EnchufeMemoryProvider()
    monkeypatch.setenv("ENCHUFE_OKF_CMD", f"node {tmp_path}/no-existe/okf.mjs")
    assert p.is_available() is False
    f = tmp_path / "okf.mjs"
    f.write_text("")
    monkeypatch.setenv("ENCHUFE_OKF_CMD", f"node {f}")
    assert p.is_available() is True
    monkeypatch.setenv("ENCHUFE_OKF_CMD", "wsl.exe -e node /x/okf.mjs")
    assert p.is_available() is True


def test_get_tool_schemas_no_lanza(prov, monkeypatch):
    monkeypatch.setattr(prov, "_gbrain", lambda: 1 / 0)
    assert prov.get_tool_schemas() == []


def test_titulo_distinto_por_perfil(enchufe):
    assert enchufe._titulo("mismo apunte", "a") != enchufe._titulo("mismo apunte", "b")


def test_shutdown_no_se_come_el_stop(enchufe, tmp_path, monkeypatch):
    import threading
    gate = threading.Event()
    monkeypatch.setattr(enchufe, "_SHUTDOWN_TIMEOUT", 0.3)

    def lento(tipo, titulo, cuerpo, timeout=20.0):
        gate.wait(3)

    monkeypatch.setattr(enchufe, "_run_okf_guardar", lento)
    p = enchufe.EnchufeMemoryProvider()
    p.initialize("s1", hermes_home=str(tmp_path))
    p.on_memory_write("add", "user", "uno uno uno")
    p.on_memory_write("add", "user", "dos dos dos")
    p.shutdown()  # escritor atascado: drena y re-encola el STOP
    gate.set()
    p._writer.join(3)
    assert not p._writer.is_alive()
    assert (tmp_path / "enchufe-pendientes.jsonl").exists()


def test_pre_compress_respeta_deadline(prov, enchufe, monkeypatch):
    prov.ok = False
    prov.on_memory_write("add", "user", "pendiente uno")
    prov.shutdown()
    prov.ok = True
    monkeypatch.setattr(enchufe, "_SHUTDOWN_TIMEOUT", 0.5)  # < 1 s: no cabe ningún guardado
    prov.on_pre_compress([])
    assert prov.calls["guardar"] == []
    assert (Path(prov._home) / "enchufe-pendientes.jsonl").exists()


def test_wsl_cmd_desde_ruta_unc(enchufe, monkeypatch):
    unc = r"\\wsl.localhost\Ubuntu\srv\kit\okf\okf.mjs"
    monkeypatch.delenv("OKF_ROOT", raising=False)
    assert enchufe._wsl_cmd(unc) == ["wsl.exe", "-d", "Ubuntu", "--cd", "~", "-e", "node", "/srv/kit/okf/okf.mjs"]
    monkeypatch.setenv("OKF_ROOT", "/srv/MiCerebro")
    assert enchufe._wsl_cmd(unc) == ["wsl.exe", "-d", "Ubuntu", "--cd", "~", "-e", "env", "OKF_ROOT=/srv/MiCerebro",
                                     "node", "/srv/kit/okf/okf.mjs"]
    assert enchufe._wsl_cmd(r"C:\hermes\plugins\enchufe\okf.mjs") == []


def test_ruta_okf_por_env_o_hermana(enchufe, monkeypatch, tmp_path):
    monkeypatch.delenv("ENCHUFE_OKF_CMD", raising=False)
    monkeypatch.delenv("ENCHUFE_OKF_MCP_CMD", raising=False)
    monkeypatch.delenv("ENCHUFE_OKF_PATH", raising=False)
    assert enchufe._okf_cmd() == ["node", str(OKF_DIR / "okf.mjs")]  # carpeta okf/ hermana del plugin
    monkeypatch.setenv("ENCHUFE_OKF_PATH", str(tmp_path))  # carpeta
    assert enchufe._okf_cmd() == ["node", str(tmp_path / "okf.mjs")]
    assert enchufe._okf_mcp_cmd() == ["node", str(tmp_path / "okf-mcp.mjs")]
    monkeypatch.setenv("ENCHUFE_OKF_PATH", str(tmp_path / "otro.mjs"))  # fichero
    assert enchufe._okf_cmd() == ["node", str(tmp_path / "otro.mjs")]


def test_tipos_configurables(enchufe, monkeypatch):
    monkeypatch.delenv("ENCHUFE_TIPOS", raising=False)
    assert "decision" in enchufe._tipos() and enchufe._tipo_espejo("user") == "aprendizaje"
    monkeypatch.setenv("ENCHUFE_TIPOS", "idea, hecho")
    assert enchufe._tipos() == ("idea", "hecho")
    assert enchufe._tipo_espejo("user") == "idea" and enchufe._tipo_espejo("memory") == "idea"


# -- raíz deducida: el gateway arrancó sin OKF_ROOT -----------------------------

def _cerebro_con_enchufe(tmp_path):
    """<tmp>/MiCerebro con okf.config.json y .okf/{hermes-enchufe,okf} copiados del repo."""
    raiz = tmp_path / "MiCerebro"
    (raiz / ".okf").mkdir(parents=True)
    (raiz / "okf.config.json").write_text("{}", encoding="utf-8")
    shutil.copytree(OKF_DIR, raiz / ".okf" / "okf")
    shutil.copytree(OKF_DIR.parent / "hermes-enchufe", raiz / ".okf" / "hermes-enchufe",
                    ignore=shutil.ignore_patterns("tests", "__pycache__"))
    return raiz


@pytest.mark.skipif(not shutil.which("node"), reason="sin node")
def test_sin_okf_root_el_enchufe_deduce_la_raiz(enchufe, tmp_path, monkeypatch):
    raiz = _cerebro_con_enchufe(tmp_path)
    ajeno = tmp_path / "gateway-cwd"
    ajeno.mkdir()
    monkeypatch.chdir(ajeno)
    for v in ("OKF_ROOT", "ENCHUFE_OKF_CMD", "ENCHUFE_OKF_MCP_CMD", "ENCHUFE_OKF_PATH"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(enchufe, "__file__", str(raiz / ".okf" / "hermes-enchufe" / "__init__.py"))
    monkeypatch.setenv("ENCHUFE_OKF_PATH", str(raiz / ".okf" / "okf"))
    texto = enchufe._run_okf_guardar("nota", "Apunte de prueba", "cuerpo del apunte")
    notas = [n for n in (raiz / "memoria").glob("*.md") if n.name != "index.md"]
    assert len(notas) == 1
    assert str(notas[0]) in texto  # el mensaje dice dónde cayó
    assert list(ajeno.iterdir()) == []  # nada en el cwd ajeno


def test_raiz_deducida_por_ruta_okf_si_el_plugin_esta_copiado(enchufe, tmp_path, monkeypatch):
    raiz = _cerebro_con_enchufe(tmp_path)
    monkeypatch.setattr(enchufe, "__file__", str(tmp_path / "otro-sitio" / "enchufe" / "__init__.py"))
    monkeypatch.setenv("ENCHUFE_OKF_PATH", str(raiz / ".okf" / "okf" / "okf.mjs"))
    assert enchufe._raiz_deducida() == raiz
    monkeypatch.setenv("ENCHUFE_OKF_PATH", str(tmp_path / "okf"))  # fuera de .okf/: no se inventa
    assert enchufe._raiz_deducida() is None


def test_okf_root_explicito_manda_y_wsl_no_se_toca(enchufe, tmp_path, monkeypatch):
    monkeypatch.setenv("OKF_ROOT", "/srv/MiCerebro")
    assert enchufe._env_okf(["node", "x.mjs"])["OKF_ROOT"] == "/srv/MiCerebro"
    monkeypatch.delenv("OKF_ROOT")
    raiz = _cerebro_con_enchufe(tmp_path)
    monkeypatch.setattr(enchufe, "__file__", str(raiz / ".okf" / "hermes-enchufe" / "__init__.py"))
    assert "OKF_ROOT" not in enchufe._env_okf(["wsl.exe", "-e", "node"])
    assert enchufe._env_okf(["node", "x.mjs"])["OKF_ROOT"] == str(raiz)


@pytest.mark.skipif(not shutil.which("node"), reason="sin node")
def test_sin_cerebro_el_guardado_es_error_no_exito(enchufe, tmp_path, monkeypatch):
    ajeno = tmp_path / "gateway-cwd"
    ajeno.mkdir()
    monkeypatch.chdir(ajeno)
    for v in ("OKF_ROOT", "ENCHUFE_OKF_CMD", "ENCHUFE_OKF_MCP_CMD", "ENCHUFE_OKF_PATH"):
        monkeypatch.delenv(v, raising=False)
    # enchufe del repo (sin .okf/ a la vista): no hay raíz deducible, okf se niega
    monkeypatch.setattr(enchufe, "__file__", str(tmp_path / "suelto" / "__init__.py"))
    monkeypatch.setenv("ENCHUFE_OKF_PATH", str(OKF_DIR))
    with pytest.raises(RuntimeError, match="no encuentro tu cerebro"):
        enchufe._run_okf_guardar("nota", "X", "y")
    assert list(ajeno.iterdir()) == []
    p = enchufe.EnchufeMemoryProvider()
    out = json.loads(p.handle_tool_call("okf_guardar", {"tipo": "nota", "titulo": "X", "cuerpo": "y"}))
    assert "error" in out and "resultado" not in out
