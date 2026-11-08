#!/usr/bin/env python3
"""Instala el enchufe en el perfil raíz de Hermes y en cada perfil. Dry-run por defecto.

Por cada HERMES_HOME (raíz + profiles/*):
  1. symlink  <home>/plugins/enchufe -> carpeta de este plugin
  2. config.yaml: `provider: enchufe` dentro del bloque `memory:` (backup previo)

No reinicia servicios. Uso:
  python3 instalar-enchufe.py                     # dry-run
  python3 instalar-enchufe.py --aplicar           # backup tar.gz + instala
  python3 instalar-enchufe.py --deshacer <backup> # restaura configs y quita symlinks
"""
import argparse
import datetime as dt
import os
import re
import sys
import tarfile
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent
NOMBRE = "enchufe"


def homes(raiz: Path):
    yield raiz
    perfiles = raiz / "profiles"
    if perfiles.is_dir():
        for p in sorted(perfiles.iterdir()):
            if p.is_dir() and (p / "config.yaml").is_file():
                yield p


def nuevo_config(texto: str):
    """Devuelve (texto_nuevo, cambio). Sin bloque `memory:` lo añade al final (Hermes
    fusiona con los valores por defecto: hermes_cli/config.py `_deep_merge`)."""
    lineas = texto.splitlines(keepends=True)
    if any(re.match(r"^memory:\s*\S", l) and not re.match(r"^memory:\s*#", l) for l in lineas):
        raise ValueError("`memory:` en línea (flow style): editar a mano")
    try:
        i = next(n for n, l in enumerate(lineas) if re.match(r"^memory:\s*(#.*)?$", l))
    except StopIteration:
        sep = "" if not texto or texto.endswith("\n") else "\n"
        return f"{texto}{sep}memory:\n  provider: {NOMBRE}\n", "añade bloque memory con provider"
    j = i + 1
    while j < len(lineas) and (lineas[j].startswith((" ", "\t")) or not lineas[j].strip()):
        m = re.match(r"^(\s+)provider:\s*(.*?)\s*$", lineas[j])
        if m and len(m.group(1)) == 2:
            actual = m.group(2).strip("'\"")
            if actual == NOMBRE:
                return texto, "ya estaba"
            lineas[j] = f"  provider: {NOMBRE}\n"
            return "".join(lineas), f"provider {actual or '(vacío)'} -> {NOMBRE}"
        j += 1
    lineas.insert(i + 1, f"  provider: {NOMBRE}\n")
    return "".join(lineas), f"añade provider: {NOMBRE}"


def plan(raiz: Path):
    acciones = []
    for h in homes(raiz):
        enlace = h / "plugins" / NOMBRE
        if enlace.is_symlink() and enlace.resolve() == PLUGIN:
            s = "symlink ya estaba"
        elif enlace.exists() or enlace.is_symlink():
            s = "CONFLICTO: existe y no apunta al plugin"
        else:
            s = "crea symlink"
        cfg = h / "config.yaml"
        try:
            texto, c = nuevo_config(cfg.read_text())
        except ValueError as e:
            texto, c = None, f"CONFLICTO: {e}"
        acciones.append((h, enlace, s, cfg, texto, c))
    return acciones


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hermes-home", default=os.path.expanduser("~/.hermes"))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--aplicar", action="store_true")
    g.add_argument("--deshacer", metavar="BACKUP")
    a = ap.parse_args()
    raiz = Path(a.hermes_home)

    if a.deshacer:
        with tarfile.open(a.deshacer) as t:
            t.extractall(raiz, filter="data")
        for h in homes(raiz):
            e = h / "plugins" / NOMBRE
            if e.is_symlink():
                e.unlink()
        print("configs restaurados y symlinks quitados")
        return 0

    acciones = plan(raiz)
    conflictos = [x for x in acciones if "CONFLICTO" in x[2] or "CONFLICTO" in x[5]]
    for h, _, s, _, _, c in acciones:
        print(f"{h}: {s}; config: {c}")
    if conflictos:
        print(f"\n{len(conflictos)} conflicto(s): no se toca nada.", file=sys.stderr)
        return 1
    if not a.aplicar:
        print("\nDry-run. Repite con --aplicar.")
        return 0

    bk_dir = raiz / "backups"
    bk_dir.mkdir(exist_ok=True)
    bk = bk_dir / f"enchufe-{dt.datetime.now():%Y%m%d-%H%M%S}.tar.gz"
    with tarfile.open(bk, "w:gz") as t:
        for h, *_ in acciones:
            t.add(h / "config.yaml", arcname=str((h / "config.yaml").relative_to(raiz)))
    print(f"backup: {bk}")
    for h, enlace, s, cfg, texto, c in acciones:
        if s == "crea symlink":
            enlace.parent.mkdir(exist_ok=True)
            enlace.symlink_to(PLUGIN, target_is_directory=True)
        if c != "ya estaba":
            tmp = cfg.with_suffix(".yaml.enchufe-tmp")
            tmp.write_text(texto)
            os.chmod(tmp, cfg.stat().st_mode)
            os.replace(tmp, cfg)
    print("Hecho. Reinicia Hermes (gateway y serve, si los usas) para que cargue el plugin.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
