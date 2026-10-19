#!/usr/bin/env python3
"""
Builds the static 360° panorama site into ./_site

  projects/<project-folder>/*.jpg|png|webp   -> one viewer page per folder
  projects/<project-folder>/project.json      -> optional titles, order, start view
  site.json                                   -> branding + site options

Run locally:   python3 scripts/build.py && python3 -m http.server -d _site 8000
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None  # big panoramas are expected

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = ROOT / "projects"
STATIC = ROOT / "site"
TEMPLATES = ROOT / "scripts" / "templates"
OUT = ROOT / os.environ.get("OUT_DIR", "_site")
CACHE = ROOT / ".cache" / "images"
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
THUMB_W, THUMB_H = 640, 320
JPEG_Q = 85
CACHE_VERSION = "v2"


def log(msg: str) -> None:
    print(msg, flush=True)


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "item"


def title_from_name(stem: str) -> str:
    words = re.sub(r"[-_]+", " ", stem).strip()
    return words[:1].upper() + words[1:] if words else "Panorama"


def esc(s) -> str:
    return html.escape(str(s or ""), quote=True)


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        log(f"  ! Could not read {path.relative_to(ROOT)}: {e} (using defaults)")
        return default


def render(template: str, **values) -> str:
    text = (TEMPLATES / template).read_text(encoding="utf-8")
    for k, v in values.items():
        text = text.replace("{{" + k + "}}", str(v))
    return text


def sha1(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def process_image(src: Path, max_w: int) -> dict:
    """Returns {'web': Path, 'thumb': Path, 'w': int, 'h': int}, cached by content hash."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = f"{sha1(src)}-{max_w}-{CACHE_VERSION}"
    web, thumb, meta = CACHE / f"{key}.jpg", CACHE / f"{key}.thumb.jpg", CACHE / f"{key}.json"
    if web.exists() and thumb.exists() and meta.exists():
        info = json.loads(meta.read_text())
        return {"web": web, "thumb": thumb, **info}

    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode != "RGB":
            im = im.convert("RGB")
        w, h = im.size
        resized = False
        if w > max_w:
            h = round(h * max_w / w)
            w = max_w
            im = im.resize((w, h), Image.LANCZOS)
            resized = True
        im.save(web, "JPEG", quality=JPEG_Q, optimize=True, progressive=True)
        # keep the original jpeg if re-encoding didn't help
        if not resized and src.suffix.lower() in {".jpg", ".jpeg"} and src.stat().st_size <= web.stat().st_size:
            shutil.copyfile(src, web)
        ImageOps.fit(im, (THUMB_W, THUMB_H), Image.LANCZOS).save(
            thumb, "JPEG", quality=78, optimize=True, progressive=True
        )
    info = {"w": w, "h": h}
    meta.write_text(json.dumps(info))
    return {"web": web, "thumb": thumb, **info}


def scene_geometry(w: int, h: int, entry: dict) -> dict:
    """Full 360x180 for 2:1 images; wider images are treated as 360° cylinders."""
    if "haov" in entry or "vaov" in entry:
        g = {k: entry[k] for k in ("haov", "vaov", "vOffset") if k in entry}
    else:
        ratio = w / h
        g = {"haov": 360, "vaov": 180} if ratio <= 2.05 else {"haov": 360, "vaov": round(360 / ratio, 2)}
    if g.get("vaov", 180) < 180:
        half = g["vaov"] / 2
        g.update({"minPitch": -half, "maxPitch": half})
    return g


def build_project(folder: Path, site: dict) -> dict | None:
    meta = load_json(folder / "project.json", {})
    if meta.get("hidden"):
        log(f"- {folder.name}: hidden, skipped")
        return None

    images = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT)
    if not images:
        log(f"- {folder.name}: no images yet, skipped")
        return None

    slug = slugify(folder.name)
    if slug != folder.name:
        log(f"  ! Folder '{folder.name}' published as '{slug}' (URLs use lowercase letters, numbers, dashes)")

    by_name = {p.name: p for p in images}
    listed = [e for e in meta.get("panoramas", []) if isinstance(e, dict) and e.get("file") in by_name]
    listed_names = {e["file"] for e in listed}
    entries = listed + [{"file": p.name} for p in images if p.name not in listed_names]

    out = OUT / "p" / slug
    (out / "img").mkdir(parents=True, exist_ok=True)
    (out / "thumb").mkdir(parents=True, exist_ok=True)

    max_w = int(meta.get("maxImageWidth") or site.get("maxImageWidth") or 8192)
    scenes, used_ids = [], set()
    for e in entries:
        src = by_name[e["file"]]
        sid = slugify(src.stem)
        n = 2
        while sid in used_ids:
            sid, n = f"{slugify(src.stem)}-{n}", n + 1
        used_ids.add(sid)

        r = process_image(src, max_w)
        shutil.copyfile(r["web"], out / "img" / f"{sid}.jpg")
        shutil.copyfile(r["thumb"], out / "thumb" / f"{sid}.jpg")

        scene = {
            "id": sid,
            "title": e.get("title") or title_from_name(src.stem),
            "panorama": f"img/{sid}.jpg",
            "thumb": f"thumb/{sid}.jpg",
            "yaw": e.get("yaw", 0),
            "pitch": e.get("pitch", 0),
            "hfov": e.get("hfov", 100),
            **scene_geometry(r["w"], r["h"], e),
        }
        if e.get("northOffset") is not None:
            scene["northOffset"] = e["northOffset"]
        if isinstance(e.get("hotSpots"), list):
            scene["hotSpots"] = e["hotSpots"]
        scenes.append(scene)
        log(f"    {sid}: {r['w']}x{r['h']}")

    project = {
        "slug": slug,
        "title": meta.get("title") or title_from_name(folder.name),
        "client": meta.get("client", ""),
        "description": meta.get("description", ""),
        "date": meta.get("date", ""),
        "autoRotate": meta.get("autoRotate", site.get("autoRotate", True)),
        "scenes": scenes,
    }

    page_url = f"{BASE_URL}/p/{slug}/" if BASE_URL else ""
    og = ""
    if BASE_URL:
        og = (
            f'<meta property="og:url" content="{esc(page_url)}">\n'
            f'<meta property="og:image" content="{esc(page_url + scenes[0]["thumb"])}">\n'
            f'<meta name="twitter:card" content="summary_large_image">'
        )
    desc = project["description"] or f"{len(scenes)} interactive 360° view{'s' if len(scenes) != 1 else ''}"
    common = dict(
        TITLE=esc(project["title"]),
        COMPANY=esc(site.get("name", "")),
        DESCRIPTION=esc(desc),
        ACCENT=esc(site.get("accent", "#f2994a")),
        ROBOTS='<meta name="robots" content="noindex, nofollow">' if site.get("noindex", True) else "",
        OG=og,
    )
    public_site = {k: site.get(k) for k in ("name", "tagline", "accent", "logo", "contact")}
    data = json.dumps({"project": project, "site": public_site}, ensure_ascii=False).replace("</", "<\\/")
    (out / "index.html").write_text(render("viewer.html", ASSETS="../../assets", DATA=data, **common), encoding="utf-8")
    (out / "qr").mkdir(exist_ok=True)
    (out / "qr" / "index.html").write_text(
        render("qr.html", ASSETS="../../../assets", DATA=data, **common), encoding="utf-8"
    )
    log(f"- {slug}: {len(scenes)} panorama(s)")
    return project


def main() -> int:
    site = load_json(ROOT / "site.json", {})
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT)
    (OUT / ".nojekyll").write_text("")

    projects = []
    if PROJECTS.exists():
        for folder in sorted(p for p in PROJECTS.iterdir() if p.is_dir() and not p.name.startswith(".")):
            p = build_project(folder, site)
            if p:
                projects.append(p)

    projects.sort(key=lambda p: (p["date"] or "", p["title"]), reverse=True)
    listing = []
    if site.get("listProjects"):
        listing = [
            {"slug": p["slug"], "title": p["title"], "client": p["client"], "date": p["date"],
             "count": len(p["scenes"]), "thumb": f"p/{p['slug']}/{p['scenes'][0]['thumb']}"}
            for p in projects
        ]
    public_site = {k: site.get(k) for k in ("name", "tagline", "accent", "logo", "contact")}
    home_data = json.dumps({"site": public_site, "projects": listing}, ensure_ascii=False).replace("</", "<\\/")
    (OUT / "index.html").write_text(
        render("home.html", ASSETS="assets", DATA=home_data, COMPANY=esc(site.get("name", "")),
               TAGLINE=esc(site.get("tagline", "")), ACCENT=esc(site.get("accent", "#f2994a")),
               ROBOTS='<meta name="robots" content="noindex, nofollow">' if site.get("noindex", True) else ""),
        encoding="utf-8",
    )
    (OUT / "404.html").write_text(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>Not found</title><body style='margin:0;min-height:100vh;display:grid;place-items:center;"
        "font:16px system-ui,sans-serif;background:#111418;color:#e8eaed;text-align:center;padding:24px'>"
        f"<div><h1 style='font-weight:600'>This view isn't available</h1><p style='opacity:.7'>"
        f"The link may have changed. Please contact {esc(site.get('name', 'us'))} for an updated QR code.</p></div>",
        encoding="utf-8",
    )
    if site.get("noindex", True):
        (OUT / "robots.txt").write_text("User-agent: *\nDisallow: /\n")

    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    log(f"\nBuilt {len(projects)} project(s), site size {total / 1e6:.1f} MB")
    if total > 900e6:
        log("! Warning: GitHub Pages sites are limited to 1 GB. Remove or hide old projects.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
