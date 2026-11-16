# Film lab

Turn digital JPEGs into classic slide film: Kodachrome, Velvia, Ektachrome or Provia
colour, scanned film grain, halation, vignette, and re-rollable light leaks.

**Use it online:** https://billtribble.github.io/film-lab/. Import or drop your
photos. Everything runs in your browser, and photos never leave your device.

## Features

- **Four slide stocks:** Kodachrome 64, Velvia 50, Ektachrome 100VS and Provia 100F,
  with a strength slider.
- **Grain per stock:** real scanned grain, sized and coloured to suit each stock.
  Provia is finest, Kodachrome is crispest.
- **Light leaks:** Off, Generated, Scans (your own leak images) or Mix. Re-roll one
  photo or all of them, and undo with ⌘Z.
- **Follow the light:** leaks come in from the edge nearest the brightest part of the
  photo and take on its colour.
- **Full-resolution export:** keeps the camera EXIF (date, camera, exposure).

For leak scans, a free pack is available from
[Spoon Graphics](https://blog.spoongraphics.co.uk/freebies/download-my-free-light-leaks-photo-overlays-to-add-retro-effects-to-your-photos).
Their terms don't allow re-hosting, so it isn't bundled here. Download it and use
**Add leak scans**.

Keys: `R` re-roll, `Shift+R` re-roll all, `⌘Z` undo, arrow keys move between photos,
hold `\` to compare with the original.

## Local folder mode

Point it at a folder and the photos load automatically. Exports are saved to
`~/Downloads`. Needs Python 3 only.

```bash
python3 server.py --in ~/Pictures/roll-01 --leaks ~/Pictures/light-leaks
```

## How it works

The look is one WebGL2 shader: film-stock colour cube → vignette → halation → light
leak → grain. Grain comes last, because a leak exposes the film and the grain sits
over everything.

The colour cubes and grain tile are pre-built with [G'MIC](https://gmic.eu):

```bash
brew install gmic && pip install numpy pillow
python3 tools/build_assets.py
```

## Credits and licences

- Code: MIT (see `LICENSE`).
- `web/assets/luts/`: film emulation CLUTs from G'MIC's collection, derived from the
  RawTherapee film simulation set by Pat David and contributors, CC BY-SA 4.0.
- `web/assets/grain.png`: rendered from G'MIC's scanned grain samples
  (G'MIC by David Tschumperlé / GREYC, CeCILL).
