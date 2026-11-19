"""Build the cockpit mockups: one self-contained HTML file per module.

The shell (shell.html) holds everything the modules share: the styles, the icons, the sidebar frame, the brief's
masthead, settings and the behaviour. A module file (gtm.blocks.html, dev.blocks.html) holds only what that module
brings: its pinned tiles, its areas, its lanes, the brief's cards, its pages, and the words in the "New lane" palette.

A module file is a list of blocks. A line `<!-- @@ name -->` starts the block `name`; it fills the line
`@@BLOCK:name@@` in the shell. Fonts and the brief's artworks are inlined, so each output opens anywhere.

usage: python3 build.py            builds every module into ../mockups/
       python3 build.py dev        builds one
       python3 build.py share      builds a variant (see VARIANTS)
"""
import base64
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "mockups")
MODULES = {
    # id: (name shown in the product, output file)
    "gtm": ("Go-to-market", "gtm-cockpit.html"),
    "dev": ("Development", "dev-cockpit.html"),
}
# A variant is a module's mockup with extra styles and behaviour on top, for trying a proposal without touching the
# module. Its file holds the blocks `css` and `js`, which fill `@@EXTRA:css@@` and `@@EXTRA:js@@` in the shell.
VARIANTS = {
    # id: (module, output file, extra file)
    "share": ("gtm", "gtm-sharing.html", "share.extra.html"),
}
FONTS = {
    "@@FONT_SERIF@@": "newsreader.woff2",
    "@@FONT_SERIF_ITALIC@@": "newsreader-italic.woff2",
    "@@FONT_SANS@@": "schibsted-grotesk.woff2",
}
MARK = re.compile(r"^<!-- @@ ([a-z_]+) -->$")


def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def blocks(text):
    """The named blocks of a module file, each kept exactly as written."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    found, name = {}, None
    for line in lines:
        m = MARK.match(line)
        if m:
            name = m.group(1)
            assert name not in found, f"block {name} appears twice"
            found[name] = []
        else:
            assert name is not None, "text before the first block"
            found[name].append(line)
    return {k: "\n".join(v) for k, v in found.items()}


def heroes():
    out = []
    for h in json.loads(read("heroes.json")):
        entry = {"title": h["title"], "manner": h["manner"], "alt": h["alt"],
                 "src": "data:image/webp;base64," + b64(os.path.join(HERE, "heroes", h["file"] + ".webp"))}
        if h.get("pos"):
            entry["pos"] = h["pos"]
        # The glass behind the window frame: the same artwork, tiny and already blurred (see glass.sh).
        entry["glass"] = "data:image/webp;base64," + b64(os.path.join(HERE, "glass", h["file"] + ".webp"))
        out.append(entry)
    assert out, "no artworks found"
    # "</" must not appear raw inside a script element.
    return json.dumps(out, ensure_ascii=False).replace("</", "<\\/")


def build(target):
    module, filename, extra = (VARIANTS[target] if target in VARIANTS else (target, MODULES[target][1], None))
    name = MODULES[module][0]
    html = read("shell.html")
    more = blocks(read(extra)) if extra else {}
    assert set(more) <= {"css", "js"}, f"{extra}: only css and js blocks"
    for key in ("css", "js"):
        assert html.count(f"@@EXTRA:{key}@@\n") == 1, key
        html = html.replace(f"@@EXTRA:{key}@@\n", more[key] + "\n" if key in more else "")
    parts = blocks(read(module + ".blocks.html"))
    wanted = re.findall(r"^@@BLOCK:([a-z_]+)@@$", html, re.M)
    assert sorted(wanted) == sorted(parts), f"{module}: blocks differ from the shell: {sorted(set(wanted) ^ set(parts))}"
    for block in wanted:
        html = html.replace(f"@@BLOCK:{block}@@", parts[block])
    html = html.replace("@@MODULE_ID@@", module).replace("@@MODULE_NAME@@", name)
    for key, font in FONTS.items():
        assert html.count(key) == 1, key
        html = html.replace(key, b64(os.path.join(HERE, "fonts", font)))
    assert html.count("@@HEROES_JSON@@") == 1
    html = html.replace("@@HEROES_JSON@@", heroes())
    assert "@@" not in html, "a placeholder was left unfilled"
    # Every icon a page uses must be in the sprite, or it renders as an empty box.
    have = set(re.findall(r'<symbol id="([a-z-]+)"', html))
    used = set(re.findall(r'<use href="#([a-z-]+)"', html))
    assert used <= have, f"{module}: icons missing from the sprite: {sorted(used - have)}"
    os.makedirs(OUT, exist_ok=True)
    path = os.path.normpath(os.path.join(OUT, filename))
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"{filename}: {round(len(html.encode()) / 1024)} KB, {len(parts)} blocks, {len(used)} icons")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--out":
        OUT = sys.argv[2]
        del sys.argv[1:3]
    for m in sys.argv[1:] or [*MODULES, *VARIANTS]:
        build(m)
