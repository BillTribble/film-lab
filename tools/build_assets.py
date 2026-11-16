#!/usr/bin/env python3
"""Build Film lab's static assets with G'MIC.

    brew install gmic && pip install numpy pillow
    python3 tools/build_assets.py

Writes:
  web/assets/luts/<stock>.png  64x64x64 film-stock colour cube, packed as an
                               8x8 grid of 64x64 tiles (tile index = blue,
                               x = red, y = green)
  web/assets/grain.png         2048x2048 scanned film grain (Kodak TMax 400
                               sample), centred on 128 = no change
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "web" / "assets"
GMIC = shutil.which("gmic") or "gmic"

# key -> G'MIC built-in CLUT name (slide / reversal stocks)
STOCKS = {
    "kodachrome64": "kodak_kodachrome_64",
    "velvia50": "fuji_velvia_50",
    "ektachrome100vs": "kodak_ektachrome_100_vs",
    "provia100f": "fuji_provia_100f",
}
N = 64
GRAIN_PX = 2048


def gmic(cwd: Path, *args: str) -> None:
    subprocess.run([GMIC, "-v", "-1", *args], cwd=cwd, check=True)


def build_lut(tmp: Path, key: str, name: str) -> None:
    gmic(tmp, "clut", f"{name},{N}", "o", f"raw:{key}.raw,uint8")
    # G'MIC raw is planar: [channel][z=blue][y=green][x=red]
    cube = np.fromfile(tmp / f"{key}.raw", dtype=np.uint8).reshape(3, N, N, N)
    tiles = int(np.sqrt(N))  # 8 x 8 tiles of 64 x 64
    sheet = np.zeros((tiles * N, tiles * N, 3), dtype=np.uint8)
    for b in range(N):
        ty, tx = divmod(b, tiles)
        sheet[ty * N:(ty + 1) * N, tx * N:(tx + 1) * N] = cube[:, b].transpose(1, 2, 0)
    out = ASSETS / "luts" / f"{key}.png"
    Image.fromarray(sheet).save(out, optimize=True)
    print("wrote", out.relative_to(ROOT))


def build_grain(tmp: Path) -> None:
    gmic(
        tmp, f"{GRAIN_PX},{GRAIN_PX},1,1,128",
        "__fx_simulate_grain", "kodak_tmax400,1,1,100,0,0,0,0,0,0,0,0,1",
        "sub", "{ia}", "add", "128", "c", "0,255", "o", "grain.png",
    )
    out = ASSETS / "grain.png"
    Image.open(tmp / "grain.png").convert("L").save(out, optimize=True)
    print("wrote", out.relative_to(ROOT))


def main() -> None:
    (ASSETS / "luts").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        for key, name in STOCKS.items():
            build_lut(tmp, key, name)
        build_grain(tmp)


if __name__ == "__main__":
    main()
