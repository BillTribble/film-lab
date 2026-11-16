# Film lab

Turn digital JPEGs into classic slide film: Kodachrome, Velvia, Ektachrome or Provia
colour, scanned film grain, halation, vignette, light leaks, and film artifacts such as
dust and scratches. Light leaks and artifacts can be re-rolled.

**Use it online:** https://billtribble.github.io/film-lab/. Import or drop your
photos. Everything runs in your browser, and photos never leave your device.

## Features

- **Four slide stocks:** Kodachrome 64, Velvia 50, Ektachrome 100VS and Provia 100F,
  with a strength slider.
- **Grain to match each film:** real scanned grain, sized and coloured for each stock.
  **Match grain to film** keeps them paired. Turn it off to mix and match, or turn on
  **More grain types** for black-and-white grain (T-Max 400, Orwo NP20, Tri-X 1600,
  T-Max 3200). Step through films and grains with ‹ ›, or click a name for the full
  list.
- **Light leaks:** generated glows, streaks and washes. **Follow the light** brings them
  in from the edge nearest the brightest part of the photo, in its colour.
- **Artifacts:** generated dust, scratches, hairs and water spots, with an amount
  slider. Scratches run along the film strip, as they do on a real roll.
- **Re-roll and undo:** re-roll one photo or all of them, separately for leaks and
  artifacts. One undo (⌘Z) covers both.
- **Full-resolution export:** keeps the camera EXIF (date, camera, exposure).

Keys: `R` re-roll leaks, `D` re-roll artifacts (add `Shift` for all photos), `⌘Z` undo,
arrow keys move between photos, hold `\` to compare with the original.

## Run it locally (adds scan packs)

Running locally adds **Scans** and **Mix** modes for light leaks and artifacts, using
overlay packs on your own disk. Free packs exist (for example from Spoon Graphics), but
their terms don't allow re-hosting, so the public site uses generated effects only.

On macOS, double-click **`Film Lab.command`**. It asks for a folder of photos (Cancel to
import in the app instead) and opens the app in your browser. Exports are saved to
`~/Downloads`. Scans load from `Light Leaks` and `Film Dust` folders in `~/Pictures` or
your Dropbox, or from `FILM_LAB_LEAKS` / `FILM_LAB_DUST`. Needs Python 3 only.

Or from Terminal:

```bash
python3 server.py ~/Pictures/roll-01 --leaks ~/Pictures/light-leaks --dust ~/Pictures/film-dust
```

If the port is busy (for example, another copy is running), it picks the next free one.

## How it works

The look is one WebGL2 shader: film-stock colour cube → vignette → halation → light
leak → grain → artifacts. Grain goes after the leak, because a leak exposes the film.
Dust and scratches sit on top, as on a scanned slide.

The grain tile is sampled without mipmaps. A preview shows a 24-megapixel photo at a
fraction of its pixel size, and mip filtering averages random noise down to flat grey —
the grain then only appeared in a full-resolution export. Linear sampling keeps its
contrast at any zoom.

The colour cubes and grain tiles are pre-built with [G'MIC](https://gmic.eu):

```bash
brew install gmic && pip install numpy pillow
python3 tools/build_assets.py
```

## Credits and licences

- Code: MIT (see `LICENSE`).
- `web/assets/luts/`: film emulation CLUTs from G'MIC's collection, derived from the
  RawTherapee film simulation set by Pat David and contributors, CC BY-SA 4.0.
- `web/assets/grain/`: rendered from G'MIC's scanned grain samples
  (G'MIC by David Tschumperlé / GREYC, CeCILL).
