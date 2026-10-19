# 360° Panorama Share

Host 360° panoramas on GitHub Pages and share them with clients by **link or QR code**. Unlimited projects, as many panoramas per project as you want, and a phone-friendly viewer (swipe, pinch-zoom, look around by moving the phone).

```
https://YOUR-USERNAME.github.io/panoramas/              ← home page
https://YOUR-USERNAME.github.io/panoramas/p/<project>/  ← what clients open
https://YOUR-USERNAME.github.io/panoramas/p/<project>/qr/  ← printable QR card
https://YOUR-USERNAME.github.io/panoramas/admin/        ← your upload page
```

---

## One-time setup (about 10 minutes)

1. **Create the repo.** On GitHub click **New repository**, name it e.g. `panoramas`, set it to **Public**, and create it.
   *(GitHub Pages on a free account needs a public repo — see "Privacy" below.)*
2. **Upload these files.** On the new repo page click **uploading an existing file**, drag in *everything inside this folder* (including the hidden `.github` folder — on a Mac press `Cmd+Shift+.` in Finder to show it), and click **Commit changes**.
   Or with git: `git init && git add . && git commit -m "init" && git branch -M main && git remote add origin https://github.com/YOU/panoramas.git && git push -u origin main`
3. **Turn on Pages.** Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Run the first build.** Repo → **Actions → Build & publish panoramas → Run workflow**. After ~1 minute your site is live at the URL shown in Settings → Pages. Open `/p/sample-project/` to see the demo.
5. **Make an upload token** (so the admin page can save to your repo):
   GitHub → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   - Repository access: **Only select repositories** → `panoramas`
   - Permissions: **Contents → Read and write** (optional: **Actions → Read-only** to see publish status)
6. **Open `/admin/`** on your site, paste the token, and you're in. Go to **Settings** there to set your company name, logo, colors and contact info.

## Everyday use

1. Open `https://YOU.github.io/panoramas/admin/` (works on your phone too).
2. **+ New project** → name + client.
3. **Add 360° panoramas** → select as many as you want. Reorder, rename, remove.
4. **Save & publish.** Everything goes up in one commit; the site updates in about a minute.
5. Hit **QR card** to print it, download it as an image, or text the link.

Links never change — renaming a project or swapping panoramas keeps old QR codes working. New projects get a short random suffix (e.g. `smith-residence-8afjq`) so links can't be guessed.

### Without the admin page

You can also manage everything straight in GitHub: create a folder under `projects/`, drop `.jpg` files in, commit. Optional `project.json` in the folder:

```json
{
  "title": "Smith Residence – Framing",
  "client": "John Smith",
  "description": "Week 6 walkthrough",
  "date": "2026-10-19",
  "autoRotate": true,
  "hidden": false,
  "panoramas": [
    { "file": "living-room.jpg", "title": "Living Room", "yaw": 90, "pitch": -5, "hfov": 100 },
    { "file": "kitchen.jpg", "title": "Kitchen",
      "hotSpots": [{ "type": "scene", "sceneId": "living-room", "pitch": -10, "yaw": 170, "text": "Living Room" }] }
  ]
}
```

- Images not listed still show up (alphabetically, after listed ones).
- `yaw` / `pitch` / `hfov` set the starting view. `hotSpots` follow [Pannellum's format](https://pannellum.org/documentation/reference/#hot-spot); `sceneId` is the image file name without extension, lowercased with dashes.
- `"hidden": true` takes a project offline without deleting it.
- Link to a specific view: `.../p/<project>/#kitchen`

## Images

- Best: **equirectangular 2:1 JPGs** straight from a 360 camera (Insta360, Ricoh Theta, GoPro Max, etc.) or rendered from Revit/Enscape/Twinmotion/Lumion as a 360 panorama.
- Wider images (e.g. 4:1) are shown as a 360° strip with limited up/down look.
- The admin page shrinks images to 8192 px wide before uploading (5760 px when uploading from an iPhone — Safari limit). The build also caps anything bigger, so originals of any size are fine.

## Limits to know

GitHub Pages is free, but: **site ≤ 1 GB**, files ≤ 100 MB. At 2–4 MB per optimized panorama that's roughly **250–400 panoramas live at once**. Delete or hide old projects as you go. If you outgrow it, the same site deploys unchanged to Cloudflare Pages or Netlify.

## Privacy

- Projects are **unlisted, not secret**: clients only see what you send them, the home page doesn't list projects (unless you turn that on), and search engines are told not to index. But because the repo is public, anyone who finds the repo on GitHub can see every image. Don't use it for anything confidential.
- Need real privacy? A private repo with GitHub Pages requires a paid GitHub plan; Cloudflare Pages + Access is a free alternative.
- Your token is stored only in your browser and only sent to `api.github.com`. Use "Sign out on this device" on shared computers.

## Files

```
projects/<slug>/        your panoramas (+ optional project.json)
site.json               company name, color, logo, contact, options
site/                   viewer, admin page, styles (copied to the site as-is)
scripts/build.py        builds _site/ (thumbnails, resizing, pages)
.github/workflows/      builds + deploys on every push
tests/mock_github.py    local test server with a fake GitHub API
```

Build locally: `pip install Pillow && python3 scripts/build.py && python3 -m http.server -d _site 8000`

Viewer powered by [Pannellum](https://pannellum.org) (MIT). QR codes by [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
