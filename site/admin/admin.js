/* Panorama Manager: creates projects and uploads panoramas straight to your GitHub repo.
   Everything runs in your browser; your token is only ever sent to api.github.com. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- state
  var LS = "panoMgr.v1";
  var params = new URLSearchParams(location.search);
  var API = (params.get("api") || safeGet("panoMgr.api") || "https://api.github.com").replace(/\/$/, "");
  if (params.get("api")) safeSet("panoMgr.api", params.get("api"));
  var IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var cfg = loadCfg();
  var repo = null;          // { defaultBranch, htmlUrl, private }
  var projects = [];        // [{ slug, meta, files:[name], jsonSha, exists }]
  var siteCfg = null;       // { data, sha }
  var draft = null;         // project being edited
  var localThumbs = {};     // previews for just-uploaded images until the site rebuilds
  var busy = false;
  var app = document.getElementById("app");

  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(LS) || sessionStorage.getItem(LS) || "{}"); } catch (e) {}
    if (!c.owner || !c.repo) {
      var host = location.hostname, m = host.match(/^([^.]+)\.github\.io$/i);
      if (m) {
        c.owner = c.owner || m[1];
        var seg = location.pathname.split("/").filter(Boolean);
        c.repo = c.repo || (seg.length > 1 ? seg[0] : host);
      }
    }
    c.maxWidth = c.maxWidth || (IS_IOS ? 5760 : 8192);
    return c;
  }
  function saveCfg() {
    var s = JSON.stringify(cfg);
    try {
      if (cfg.remember) { localStorage.setItem(LS, s); sessionStorage.removeItem(LS); }
      else { sessionStorage.setItem(LS, s); var keep = Object.assign({}, cfg, { token: "" }); localStorage.setItem(LS, JSON.stringify(keep)); }
    } catch (e) {}
  }
  function siteBase() {
    if (cfg.siteUrl) return cfg.siteUrl.replace(/\/?$/, "/");
    return new URL("../", location.href).href.split(/[?#]/)[0];
  }

  // ---------------------------------------------------------------- GitHub API
  function gh(path, opts) {
    opts = opts || {};
    var headers = { Accept: "application/vnd.github+json" };
    if (cfg.token) headers.Authorization = "Bearer " + cfg.token;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: opts.method || "GET", headers: headers, cache: "no-store",
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.message || res.statusText || "Request failed"); e.status = res.status; throw e;
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }
  function R(p) { return "/repos/" + enc(cfg.owner) + "/" + enc(cfg.repo) + p; }
  function enc(s) { return encodeURIComponent(s); }

  function b64ToText(b64) {
    var bin = atob(b64.replace(/\s/g, "")), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function textToB64(text) {
    var bytes = new TextEncoder().encode(text), bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function blobToB64(blob) {
    return new Promise(function (ok, fail) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(",")[1]); };
      r.onerror = function () { fail(r.error); };
      r.readAsDataURL(blob);
    });
  }

  /* changes: [{ path, b64 } | { path, blob } | { path, delete: true }]
     Writes everything as ONE commit, so one upload = one site rebuild. */
  function commit(message, changes, onProgress) {
    var branch = cfg.branch;
    var uploads = changes.filter(function (c) { return !c.delete; });
    var done = 0, total = uploads.length;
    var shas = {};
    function makeBlob(c) {
      var p = c.b64 != null ? Promise.resolve(c.b64) : blobToB64(c.blob);
      return p.then(function (b64) {
        return gh(R("/git/blobs"), { method: "POST", body: { content: b64, encoding: "base64" } });
      }).then(function (r) {
        shas[c.path] = r.sha; done++;
        if (onProgress) onProgress(done, total, c);
      });
    }
    return pool(uploads, 2, makeBlob).then(function () {
      var tree = changes.map(function (c) {
        return { path: c.path, mode: "100644", type: "blob", sha: c.delete ? null : shas[c.path] };
      });
      return attempt(3);
      function attempt(left) {
        var head;
        return gh(R("/git/ref/heads/" + enc(branch))).then(function (ref) {
          head = ref.object.sha;
          return gh(R("/git/commits/" + head));
        }).then(function (c) {
          return gh(R("/git/trees"), { method: "POST", body: { base_tree: c.tree.sha, tree: tree } });
        }).then(function (t) {
          return gh(R("/git/commits"), { method: "POST", body: { message: message, tree: t.sha, parents: [head] } });
        }).then(function (c) {
          return gh(R("/git/refs/heads/" + enc(branch)), { method: "PATCH", body: { sha: c.sha } });
        }).catch(function (e) {
          if (left > 1 && (e.status === 422 || e.status === 409)) return attempt(left - 1);
          throw e;
        });
      }
    });
  }
  function pool(items, n, fn) {
    var i = 0;
    function next() { if (i >= items.length) return Promise.resolve(); var it = items[i++]; return fn(it).then(next); }
    var workers = [];
    for (var k = 0; k < Math.min(n, items.length); k++) workers.push(next());
    return Promise.all(workers);
  }

  // ---------------------------------------------------------------- load repo
  function loadAll() {
    return gh(R("")).then(function (r) {
      if (r.permissions && !r.permissions.push) {
        var e = new Error("This token can read the repo but can't write to it. Give it “Contents: Read and write”.");
        e.status = 403; throw e;
      }
      repo = { defaultBranch: r.default_branch, htmlUrl: r.html_url, private: r.private };
      cfg.branch = cfg.branch || r.default_branch;
      return gh(R("/git/trees/" + enc(cfg.branch) + "?recursive=1"));
    }).then(function (t) {
      var map = {}, siteSha = null;
      (t.tree || []).forEach(function (e) {
        if (e.type !== "blob") return;
        if (e.path === "site.json") siteSha = e.sha;
        var m = e.path.match(/^projects\/([^/]+)\/([^/]+)$/);
        if (!m) return;
        var p = map[m[1]] || (map[m[1]] = { slug: m[1], files: [], jsonSha: null, exists: true, meta: {} });
        if (m[2] === "project.json") p.jsonSha = e.sha;
        else if (/\.(jpe?g|png|webp)$/i.test(m[2])) p.files.push(m[2]);
      });
      projects = Object.keys(map).map(function (k) { return map[k]; });
      var jobs = projects.filter(function (p) { return p.jsonSha; });
      var tasks = [pool(jobs, 6, function (p) {
        return gh(R("/git/blobs/" + p.jsonSha)).then(function (b) {
          try { p.meta = JSON.parse(b64ToText(b.content)); } catch (e) { p.meta = {}; p.badJson = true; }
        });
      })];
      if (siteSha) tasks.push(gh(R("/git/blobs/" + siteSha)).then(function (b) {
        siteCfg = { sha: siteSha, data: JSON.parse(b64ToText(b.content)) };
      }));
      else siteCfg = { sha: null, data: {} };
      return Promise.all(tasks);
    }).then(function () {
      projects.sort(function (a, b) {
        return String(b.meta.date || "").localeCompare(String(a.meta.date || "")) || title(a).localeCompare(title(b));
      });
      document.getElementById("nav-settings").hidden = false;
      pollDeploy();
    });
  }
  function title(p) { return p.meta.title || titleFromName(p.slug); }

  // ---------------------------------------------------------------- deploy status
  var pollTimer = null, deployHidden = false;
  function pollDeploy(soon) {
    clearTimeout(pollTimer);
    if (deployHidden) return;
    var pill = document.getElementById("deploy");
    var go = function () {
      gh(R("/actions/runs?per_page=1&branch=" + enc(cfg.branch))).then(function (r) {
        var run = (r.workflow_runs || [])[0];
        if (!run) { pill.hidden = true; return; }
        pill.hidden = false;
        pill.href = run.html_url;
        pill.className = "deploy-pill";
        if (run.status !== "completed") {
          pill.classList.add("working"); pill.textContent = "Publishing…";
          pollTimer = setTimeout(go, 8000);
        } else if (run.conclusion === "success") {
          pill.classList.add("ok"); pill.textContent = "Live";
          if (draft) refreshLiveBadges();
        } else {
          pill.classList.add("bad"); pill.textContent = "Publish failed";
        }
      }).catch(function () { deployHidden = true; pill.hidden = true; });
    };
    pollTimer = setTimeout(go, soon ? 4000 : 0);
  }

  // ---------------------------------------------------------------- router
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", function (e) {
    if (draft && draft.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  function route() {
    var h = location.hash.replace(/^#\/?/, "");
    if (!cfg.token || !cfg.owner || !cfg.repo) return viewConnect();
    if (!repo) {
      app.innerHTML = '<p class="loading">Connecting to GitHub…</p>';
      return loadAll().then(route, function (e) { viewConnect(e); });
    }
    if (draft && draft.dirty && !h.startsWith("p/" + draft.slug)) {
      if (!confirm("You have unsaved changes in “" + draft.meta.title + "”. Leave without saving?")) {
        history.replaceState(null, "", "#/p/" + draft.slug); return;
      }
    }
    if (h.startsWith("p/")) return viewProject(decodeURIComponent(h.slice(2)));
    draft = null;
    if (h === "settings") return viewSettings();
    return viewList();
  }

  // ---------------------------------------------------------------- views: connect
  function viewConnect(err) {
    draft = null;
    var guess = cfg.owner && cfg.repo;
    app.innerHTML =
      '<section class="panel narrow">' +
      "<h1>Connect your GitHub repo</h1>" +
      '<p class="sub">This page uploads your panoramas straight into your GitHub repository. GitHub then rebuilds the site automatically (about a minute).</p>' +
      (err ? '<div class="alert">' + h(errText(err)) + "</div>" : "") +
      '<form id="f" class="form">' +
      '<div class="row2"><label>GitHub username or org<input name="owner" required autocomplete="username" value="' + h(cfg.owner || "") + '"></label>' +
      '<label>Repository name<input name="repo" required value="' + h(cfg.repo || "") + '"></label></div>' +
      '<label>Access token<input name="token" type="password" required autocomplete="current-password" placeholder="github_pat_…" value="' + h(cfg.token || "") + '"></label>' +
      '<label class="inline"><input type="checkbox" name="remember"' + (cfg.remember !== false ? " checked" : "") + "> Remember on this device</label>" +
      '<button class="btn primary big" type="submit">Connect</button>' +
      "</form>" +
      '<details class="help"' + (guess ? "" : " open") + "><summary>How to get a token (2 minutes, one time)</summary><ol>" +
      '<li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → New fine-grained token</a>.</li>' +
      "<li>Name it <b>Panorama Manager</b>. Pick an expiration (you can choose up to a year, or no expiration).</li>" +
      "<li>Repository access: <b>Only select repositories</b> → choose <b>" + h(cfg.repo || "your panorama repo") + "</b>.</li>" +
      "<li>Permissions → Repository permissions: <b>Contents: Read and write</b>. Optional: <b>Actions: Read-only</b> to see publishing status here.</li>" +
      "<li>Generate, copy, and paste it above.</li></ol>" +
      "<p>The token stays in this browser and is only sent to GitHub. Don't share this page while signed in on a shared computer — or untick “Remember”.</p></details>" +
      "</section>";
    document.getElementById("f").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target;
      cfg.owner = f.owner.value.trim(); cfg.repo = f.repo.value.trim().replace(/\.git$/, "");
      cfg.token = f.token.value.trim(); cfg.remember = f.remember.checked; cfg.branch = "";
      repo = null; saveCfg();
      if (location.hash === "#/") route(); else location.hash = "#/";
    });
  }
  function errText(e) {
    if (e.status === 401) return "GitHub didn't accept that token. It may be mistyped or expired.";
    if (e.status === 404) return "Couldn't find that repository with this token. Check the names, and that the token has access to this repo.";
    if (e.status === 403 && /rate limit/i.test(e.message)) return "GitHub rate limit reached. Wait a few minutes and try again.";
    return e.message || String(e);
  }

  // ---------------------------------------------------------------- views: list
  function viewList() {
    var visible = projects;
    app.innerHTML =
      '<div class="list-head"><div><h1>Projects</h1><p class="sub">' + projects.length + " project" + (projects.length === 1 ? "" : "s") +
      ' · <a href="' + h(siteBase()) + '" target="_blank" rel="noopener">open site</a></p></div>' +
      '<button class="btn primary" id="new">+ New project</button></div>' +
      (projects.length > 6 ? '<input class="search" id="q" placeholder="Search projects or clients">' : "") +
      '<div class="plist" id="plist"></div>';
    function draw(q) {
      q = (q || "").toLowerCase();
      var list = document.getElementById("plist");
      var items = visible.filter(function (p) {
        return !q || (title(p) + " " + (p.meta.client || "") + " " + p.slug).toLowerCase().indexOf(q) >= 0;
      });
      if (!items.length) {
        list.innerHTML = '<div class="empty">' + (projects.length ? "No matches." :
          "<b>No projects yet.</b><br>Create one, then drop in your 360° panoramas.") + "</div>";
        return;
      }
      list.innerHTML = items.map(function (p) {
        var cover = coverFile(p);
        var thumb = cover ? siteBase() + "p/" + p.slug + "/thumb/" + slugify(stem(cover)) + ".jpg" : "";
        return '<a class="pitem" href="#/p/' + enc(p.slug) + '">' +
          '<div class="pthumb">' + (thumb ? '<img loading="lazy" src="' + h(thumb) + '" alt="" onerror="this.remove()">' : "") + "<span>360°</span></div>" +
          '<div class="pinfo"><h3>' + h(title(p)) + (p.meta.hidden ? ' <em class="tag">hidden</em>' : "") + "</h3>" +
          "<p>" + h([p.meta.client, p.files.length + " panorama" + (p.files.length === 1 ? "" : "s")].filter(Boolean).join(" · ")) + "</p></div>" +
          '<span class="chev">›</span></a>';
      }).join("");
    }
    draw();
    var q = document.getElementById("q");
    if (q) q.addEventListener("input", function () { draw(q.value); });
    document.getElementById("new").addEventListener("click", newProjectModal);
  }
  function coverFile(p) {
    var listed = (p.meta.panoramas || []).map(function (x) { return x.file; }).filter(function (f) { return p.files.indexOf(f) >= 0; });
    return listed[0] || p.files.slice().sort()[0];
  }

  function newProjectModal() {
    modal(
      "<h2>New project</h2>" +
      '<form id="np" class="form">' +
      '<label>Project name<input name="title" required placeholder="e.g. Smith Residence – Framing" autofocus></label>' +
      '<label>Client <span class="opt">(optional)</span><input name="client" placeholder="e.g. John Smith"></label>' +
      '<label class="inline"><input type="checkbox" name="secret" checked> Hard-to-guess link <span class="opt">(recommended)</span></label>' +
      '<p class="hint-text" id="slug-preview"></p>' +
      '<div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Create</button></div>' +
      "</form>"
    );
    var f = document.getElementById("np"), rnd = randomId(5);
    function slugOf() {
      var base = slugify(f.title.value || "project").slice(0, 48).replace(/-$/, "");
      return f.secret.checked ? base + "-" + rnd : base;
    }
    function preview() { document.getElementById("slug-preview").textContent = "Link: " + siteBase() + "p/" + slugOf() + "/"; }
    f.addEventListener("input", preview); preview();
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var slug = slugOf(), n = 2;
      while (projects.some(function (p) { return p.slug === slug; })) slug = slugOf() + "-" + n++;
      var p = {
        slug: slug, files: [], jsonSha: null, exists: false,
        meta: { title: f.title.value.trim(), client: f.client.value.trim(), description: "", date: today(), panoramas: [] }
      };
      projects.unshift(p);
      closeModal();
      location.hash = "#/p/" + enc(slug);
    });
  }

  // ---------------------------------------------------------------- views: project
  function viewProject(slug) {
    var p = projects.filter(function (x) { return x.slug === slug; })[0];
    if (!p) { app.innerHTML = '<section class="panel narrow"><h1>Project not found</h1><p><a href="#/">Back to projects</a></p></section>'; return; }
    if (!draft || draft.slug !== slug) draft = makeDraft(p);
    var d = draft, url = siteBase() + "p/" + slug + "/";

    app.innerHTML =
      '<a class="back" href="#/">← All projects</a>' +
      '<div class="proj-grid">' +
      '<section class="panel">' +
      '<div class="ptitle-row"><input class="ptitle" id="m-title" value="' + h(d.meta.title || "") + '" placeholder="Project name" aria-label="Project name"></div>' +
      '<div class="row2"><label>Client<input id="m-client" value="' + h(d.meta.client || "") + '"></label>' +
      '<label>Date<input id="m-date" type="date" value="' + h(d.meta.date || "") + '"></label></div>' +
      '<label>Description <span class="opt">(shown to your client)</span><textarea id="m-desc" rows="2">' + h(d.meta.description || "") + "</textarea></label>" +
      '<div class="pano-head"><h2>Panoramas <span class="count" id="count"></span></h2></div>' +
      '<label class="drop" id="drop"><input type="file" id="files" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple>' +
      '<span class="drop-icon">＋</span><b>Add 360° panoramas</b><span>Tap to choose, or drag & drop. Equirectangular (2:1) JPGs from your 360 camera work best.</span></label>' +
      '<ul class="panos" id="panos"></ul>' +
      "</section>" +
      '<aside class="side">' +
      '<section class="panel share-panel">' +
      '<div class="qr-mini" id="qrbox"><canvas id="qr"></canvas></div>' +
      '<div class="share-info"><div class="live-badge" id="live">Checking…</div>' +
      '<input class="url" readonly value="' + h(url) + '" id="url">' +
      '<div class="btn-row"><button class="btn" id="copy">Copy link</button><a class="btn" href="' + h(url) + '" target="_blank" rel="noopener">Open</a>' +
      '<a class="btn" href="' + h(url) + 'qr/" target="_blank" rel="noopener">QR card</a></div>' +
      '<p class="hint-text">The link stays the same forever, even if you rename the project or change panoramas — printed QR codes keep working.</p></div>' +
      "</section>" +
      '<section class="panel slim">' +
      '<label class="inline"><input type="checkbox" id="m-hidden"' + (d.meta.hidden ? " checked" : "") + "> Hide this project (link stops working until you un-hide it)</label>" +
      '<label class="inline"><input type="checkbox" id="m-rotate"' + (d.meta.autoRotate === false ? "" : " checked") + "> Slowly spin when it opens</label>" +
      '<button class="btn danger" id="del">Delete project…</button>' +
      "</section></aside></div>" +
      '<div class="savebar" id="savebar" hidden><span id="save-msg">Unsaved changes</span>' +
      '<div><button class="btn" id="discard">Discard</button><button class="btn primary" id="save">Save & publish</button></div></div>';

    QR.draw(document.getElementById("qr"), url, 132, { margin: 1 });
    bindMeta("m-title", "title"); bindMeta("m-client", "client"); bindMeta("m-date", "date"); bindMeta("m-desc", "description");
    document.getElementById("m-hidden").addEventListener("change", function (e) { setMeta("hidden", e.target.checked || undefined); });
    document.getElementById("m-rotate").addEventListener("change", function (e) { setMeta("autoRotate", e.target.checked ? undefined : false); });
    document.getElementById("copy").addEventListener("click", function () { copyText(url).then(function () { toast("Link copied"); }); });
    document.getElementById("files").addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });
    var drop = document.getElementById("drop");
    ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("over"); }); });
    drop.addEventListener("drop", function (e) { e.preventDefault(); addFiles(e.dataTransfer.files); });
    document.getElementById("save").addEventListener("click", save);
    document.getElementById("discard").addEventListener("click", function () {
      if (!confirm("Discard your unsaved changes?")) return;
      if (!p.exists) { projects = projects.filter(function (x) { return x !== p; }); draft = null; location.hash = "#/"; return; }
      draft = makeDraft(p); viewProject(slug);
    });
    document.getElementById("del").addEventListener("click", function () { deleteProject(p); });
    drawPanos();
    updateSavebar();
    refreshLiveBadges();
    if (!p.exists) document.getElementById("drop").classList.add("pulse");
  }

  function makeDraft(p) {
    var meta = JSON.parse(JSON.stringify(p.meta || {}));
    var listed = (meta.panoramas || []).filter(function (x) { return x && p.files.indexOf(x.file) >= 0; });
    var names = listed.map(function (x) { return x.file; });
    p.files.slice().sort().forEach(function (f) { if (names.indexOf(f) < 0) listed.push({ file: f }); });
    return {
      slug: p.slug, project: p, meta: meta,
      items: listed.map(function (x) { return { entry: x, file: x.file, title: x.title || titleFromName(stem(x.file)) }; }),
      removed: [], dirty: !p.exists
    };
  }
  function bindMeta(id, key) {
    document.getElementById(id).addEventListener("input", function (e) { setMeta(key, e.target.value); });
  }
  function setMeta(key, value) {
    if (value === undefined || value === "") delete draft.meta[key]; else draft.meta[key] = value;
    markDirty();
  }
  function markDirty() { draft.dirty = true; updateSavebar(); }
  function updateSavebar() {
    var bar = document.getElementById("savebar");
    if (!bar) return;
    bar.hidden = !draft.dirty;
    var adds = draft.items.filter(function (i) { return i.upload; }).length;
    var pending = draft.items.filter(function (i) { return i.upload && i.upload.state === "processing"; }).length;
    var parts = [];
    if (adds) parts.push(adds + " new panorama" + (adds === 1 ? "" : "s"));
    if (draft.removed.length) parts.push(draft.removed.length + " to delete");
    document.getElementById("save-msg").textContent = pending ? "Preparing " + pending + " image" + (pending === 1 ? "" : "s") + "…" :
      (parts.length ? parts.join(", ") : "Unsaved changes");
    document.getElementById("save").disabled = busy || pending > 0;
    var c = document.getElementById("count");
    if (c) c.textContent = draft.items.length ? "(" + draft.items.length + ")" : "";
  }

  function drawPanos() {
    var ul = document.getElementById("panos");
    if (!ul) return;
    ul.innerHTML = "";
    draft.items.forEach(function (it, idx) {
      var li = document.createElement("li");
      li.className = "pano" + (it.upload ? " new" : "");
      var thumb = it.upload ? it.upload.thumbUrl : localThumbs[draft.slug + "/" + it.file] ||
        siteBase() + "p/" + draft.slug + "/thumb/" + slugify(stem(it.file)) + ".jpg";
      var status = it.upload ? uploadStatus(it.upload) : "";
      li.innerHTML =
        '<div class="pt">' + (thumb ? '<img alt="" src="' + h(thumb) + '" onerror="this.remove()">' : "") +
        (idx === 0 ? '<span class="cover">Opens first</span>' : "") + "</div>" +
        '<div class="pbody"><input class="ptitle-in" value="' + h(it.title) + '" aria-label="Panorama title">' +
        '<div class="pmeta">' + h(it.file) + (status ? " · " + status : "") + "</div></div>" +
        '<div class="pact">' +
        '<button class="mini" data-a="up" title="Move up" ' + (idx === 0 ? "disabled" : "") + ">↑</button>" +
        '<button class="mini" data-a="down" title="Move down" ' + (idx === draft.items.length - 1 ? "disabled" : "") + ">↓</button>" +
        '<button class="mini del" data-a="rm" title="Remove">✕</button></div>';
      li.querySelector(".ptitle-in").addEventListener("input", function (e) { it.title = e.target.value; markDirty(); });
      li.querySelectorAll("[data-a]").forEach(function (b) {
        b.addEventListener("click", function () {
          var a = b.dataset.a, arr = draft.items;
          if (a === "up" && idx > 0) { arr.splice(idx - 1, 0, arr.splice(idx, 1)[0]); }
          else if (a === "down" && idx < arr.length - 1) { arr.splice(idx + 1, 0, arr.splice(idx, 1)[0]); }
          else if (a === "rm") {
            if (!it.upload && !confirm("Delete “" + it.title + "” from this project?")) return;
            arr.splice(idx, 1);
            if (!it.upload) draft.removed.push(it.file);
            else if (it.upload.thumbUrl) URL.revokeObjectURL(it.upload.thumbUrl);
          }
          markDirty(); drawPanos();
        });
      });
      ul.appendChild(li);
    });
    if (!draft.items.length) ul.innerHTML = '<li class="empty small">No panoramas yet.</li>';
    updateSavebar();
  }
  function uploadStatus(u) {
    if (u.state === "processing") return "preparing…";
    if (u.state === "error") return '<span class="err">' + h(u.error) + "</span>";
    if (u.state === "uploading") return "uploading " + (u.pct || 0) + "%";
    return "ready · " + fmtBytes(u.blob.size) + (u.note ? " · " + h(u.note) : "");
  }

  // ---------------------------------------------------------------- adding files
  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name);
    });
    if (!files.length) return;
    var taken = {};
    draft.items.forEach(function (i) { taken[stem(i.file).toLowerCase()] = 1; });
    draft.removed.forEach(function (f) { taken[stem(f).toLowerCase()] = 1; });
    var newItems = files.map(function (f) {
      var base = slugify(stem(f.name)).slice(0, 60) || "panorama", name = base, n = 2;
      while (taken[name]) name = base + "-" + n++;
      taken[name] = 1;
      var it = { file: name + ".jpg", title: titleFromName(stem(f.name)), upload: { state: "processing", source: f } };
      draft.items.push(it);
      return it;
    });
    markDirty(); drawPanos();
    // prepare one at a time (big panoramas use a lot of memory)
    newItems.reduce(function (chain, it) {
      return chain.then(function () {
        return prepareImage(it.upload.source, cfg.maxWidth).then(function (r) {
          it.upload.blob = r.blob; it.upload.thumbUrl = r.thumbUrl; it.upload.note = r.note;
          it.upload.state = "ready";
          if (r.ext !== ".jpg") it.file = it.file.replace(/\.jpg$/, r.ext);
        }, function (err) {
          it.upload.state = "error"; it.upload.error = err.message || "Couldn't read this image";
        }).then(function () { if (draft && draft.items.indexOf(it) >= 0) drawPanos(); });
      });
    }, Promise.resolve());
  }

  function prepareImage(file, maxW) {
    return loadImage(file).then(function (img) {
      var w = img.naturalWidth, hgt = img.naturalHeight;
      var ratio = w / hgt;
      var note = ratio < 1.9 || ratio > 2.1 ? "not 2:1 — may look stretched" : "";
      var thumbUrl = makeThumb(img);
      var isJpg = /jpe?g$/i.test(file.type || file.name);
      var keep = isJpg && (maxW === 0 ? file.size < 95e6 : w <= maxW && file.size < 25e6);
      if (keep) {
        return thumbUrl.then(function (t) { return { blob: file, thumbUrl: t, ext: ".jpg", note: note || (w + "×" + hgt) }; });
      }
      var tw = Math.min(w, maxW || w), th = Math.round(hgt * tw / w);
      var c = document.createElement("canvas");
      c.width = tw; c.height = th;
      var g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, tw, th);
      return Promise.all([toBlob(c, 0.86), thumbUrl]).then(function (r) {
        c.width = c.height = 1;
        if (!r[0]) {
          if (file.size < 95e6 && /jpe?g$/i.test(file.type || file.name)) return { blob: file, thumbUrl: r[1], ext: ".jpg", note: "uploaded at full size" };
          throw new Error("Too large for this browser to resize — try a computer");
        }
        return { blob: r[0], thumbUrl: r[1], ext: ".jpg", note: note || (tw + "×" + th) };
      });
    }).catch(function (e) {
      if (/jpe?g$/i.test(file.type || file.name) && file.size < 95e6)
        return { blob: file, thumbUrl: "", ext: ".jpg", note: "uploaded as-is" };
      throw e.message ? e : new Error("This file type isn't supported here — export it as JPG");
    });
  }
  function loadImage(file) {
    return new Promise(function (ok, fail) {
      var img = new Image(), u = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(u); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(u); fail(new Error("Couldn't open this image")); };
      img.src = u;
    });
  }
  function makeThumb(img) {
    var c = document.createElement("canvas"); c.width = 320; c.height = 160;
    c.getContext("2d").drawImage(img, 0, 0, 320, 160);
    return toBlob(c, 0.75).then(function (b) { return b ? URL.createObjectURL(b) : ""; });
  }
  function toBlob(c, q) {
    return new Promise(function (ok) { try { c.toBlob(ok, "image/jpeg", q); } catch (e) { ok(null); } });
  }

  // ---------------------------------------------------------------- save
  function save() {
    if (busy) return;
    var d = draft, p = d.project;
    var title = (d.meta.title || "").trim();
    if (!title) { toast("Give the project a name first"); document.getElementById("m-title").focus(); return; }
    var bad = d.items.filter(function (i) { return i.upload && i.upload.state === "error"; });
    if (bad.length && !confirm(bad.length + " image(s) couldn't be prepared and will be skipped. Continue?")) return;
    d.items = d.items.filter(function (i) { return !(i.upload && i.upload.state === "error"); });

    var meta = JSON.parse(JSON.stringify(d.meta));
    meta.title = title;
    meta.panoramas = d.items.map(function (i) {
      var e = Object.assign({}, i.entry || {}, { file: i.file, title: i.title.trim() || titleFromName(stem(i.file)) });
      return e;
    });
    var dir = "projects/" + p.slug + "/";
    var changes = [], adds = d.items.filter(function (i) { return i.upload; });
    adds.forEach(function (i) { changes.push({ path: dir + i.file, blob: i.upload.blob, item: i }); });
    changes.push({ path: dir + "project.json", b64: textToB64(JSON.stringify(meta, null, 2) + "\n") });
    d.removed.forEach(function (f) { changes.push({ path: dir + f, delete: true }); });

    var msg = !p.exists ? "Create project " + p.slug + (adds.length ? " with " + adds.length + " panorama(s)" : "") :
      adds.length ? "Add " + adds.length + " panorama(s) to " + p.slug : "Update " + p.slug;

    busy = true; updateSavebar();
    var saveBtn = document.getElementById("save");
    saveBtn.textContent = "Uploading…";
    adds.forEach(function (i) { i.upload.state = "uploading"; i.upload.pct = 0; });
    drawPanos();
    commit(msg, changes, function (done, total, c) {
      if (c.item) { c.item.upload.pct = 100; }
      document.getElementById("save-msg").textContent = "Uploading " + done + " of " + total + "…";
      drawPanosQuiet();
    }).then(function () {
      p.exists = true; p.meta = meta;
      p.files = d.items.map(function (i) { return i.file; });
      adds.forEach(function (i) { if (i.upload.thumbUrl) localThumbs[p.slug + "/" + i.file] = i.upload.thumbUrl; delete i.upload; });
      busy = false;
      draft = makeDraft(p); draft.dirty = false;
      toast("Saved. Your site updates in about a minute.");
      viewProject(p.slug);
      pollDeploy(true);
    }, function (e) {
      busy = false;
      adds.forEach(function (i) { if (i.upload) i.upload.state = "ready"; });
      saveBtn.textContent = "Save & publish";
      drawPanos();
      alert("Upload failed: " + errText(e) + "\n\nNothing was published. Your changes are still here — try again.");
    });
  }
  var quietTimer;
  function drawPanosQuiet() { clearTimeout(quietTimer); quietTimer = setTimeout(drawPanos, 150); }

  function deleteProject(p) {
    modal(
      "<h2>Delete “" + h(title(p)) + "”?</h2>" +
      "<p>This removes the project and its " + p.files.length + " panorama(s) from the site. Anyone with the link or QR code will no longer be able to open it.</p>" +
      "<p class=\"hint-text\">Want to keep it but make the link stop working for now? Use “Hide this project” instead.</p>" +
      '<form id="dp" class="form"><label>Type <b>' + h(p.slug) + '</b> to confirm<input name="c" autocomplete="off"></label>' +
      '<div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn danger" type="submit">Delete forever</button></div></form>'
    );
    document.getElementById("dp").addEventListener("submit", function (e) {
      e.preventDefault();
      if (e.target.c.value.trim() !== p.slug) { toast("That doesn't match"); return; }
      if (!p.exists) { projects = projects.filter(function (x) { return x !== p; }); closeModal(); draft = null; location.hash = "#/"; return; }
      var dir = "projects/" + p.slug + "/";
      var changes = p.files.map(function (f) { return { path: dir + f, delete: true }; });
      if (p.jsonSha) changes.push({ path: dir + "project.json", delete: true });
      e.target.querySelector("[type=submit]").textContent = "Deleting…";
      commit("Delete project " + p.slug, changes).then(function () {
        projects = projects.filter(function (x) { return x !== p; });
        closeModal(); draft = null; toast("Project deleted"); location.hash = "#/"; pollDeploy(true);
      }, function (err) { closeModal(); alert("Couldn't delete: " + errText(err)); });
    });
  }

  function refreshLiveBadges() {
    var b = document.getElementById("live");
    if (!b || !draft) return;
    var url = siteBase() + "p/" + draft.slug + "/";
    if (!draft.project.exists) { b.className = "live-badge pending"; b.textContent = "Not published yet — add panoramas and save"; return; }
    fetch(url, { method: "HEAD", cache: "no-store" }).then(function (r) {
      if (r.ok) {
        b.className = "live-badge ok";
        b.textContent = "Live";
      } else throw 0;
    }).catch(function () {
      b.className = "live-badge pending";
      b.textContent = draft.meta.hidden ? "Hidden" : draft.items.length ? "Publishing… (about a minute)" : "Add panoramas to publish";
    });
  }

  // ---------------------------------------------------------------- settings
  function viewSettings() {
    var s = (siteCfg && siteCfg.data) || {};
    var c = s.contact || {};
    app.innerHTML =
      '<a class="back" href="#/">← All projects</a>' +
      '<section class="panel narrow"><h1>Site settings</h1><p class="sub">Your branding on every client page.</p>' +
      '<form id="sf" class="form">' +
      '<label>Company name<input name="name" value="' + h(s.name || "") + '"></label>' +
      '<label>Tagline<input name="tagline" value="' + h(s.tagline || "") + '"></label>' +
      '<div class="row2"><label>Accent color<input name="accent" type="color" value="' + h(s.accent || "#f2994a") + '"></label>' +
      '<label>Logo <span class="opt">(square PNG/SVG)</span><input name="logo" type="file" accept="image/png,image/svg+xml,image/jpeg"></label></div>' +
      (s.logo ? '<p class="hint-text">Current logo: ' + h(s.logo) + ' <button type="button" class="linkish" id="rmlogo">remove</button></p>' : "") +
      '<div class="row2"><label>Phone<input name="phone" value="' + h(c.phone || "") + '"></label>' +
      '<label>Email<input name="email" type="email" value="' + h(c.email || "") + '"></label></div>' +
      '<label>Website<input name="website" value="' + h(c.website || "") + '"></label>' +
      '<label class="inline"><input type="checkbox" name="listProjects"' + (s.listProjects ? " checked" : "") + "> Show all projects on the home page <span class=\"opt\">(off = clients only see the project they were sent)</span></label>" +
      '<label>Max panorama width when uploading from this device' +
      '<select name="maxWidth">' + [[4096, "4096 px (smallest files)"], [5760, "5760 px (best for iPhone uploads)"], [8192, "8192 px (sharpest, recommended)"], [0, "Keep original size"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (Number(cfg.maxWidth) === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") + "</select></label>" +
      '<button class="btn primary big" type="submit">Save settings</button></form></section>' +
      '<section class="panel narrow slim"><h2>Connection</h2><p class="sub">' + h(cfg.owner + "/" + cfg.repo) + " · branch " + h(cfg.branch) +
      (repo && repo.private ? " · private repo" : "") + '</p><div class="btn-row">' +
      '<a class="btn" href="' + h(repo ? repo.htmlUrl : "#") + '" target="_blank" rel="noopener">Open repo on GitHub</a>' +
      '<button class="btn" id="signout">Sign out on this device</button></div></section>';

    var rmLogo = false;
    var rl = document.getElementById("rmlogo");
    if (rl) rl.addEventListener("click", function () { rmLogo = true; rl.parentNode.textContent = "Logo will be removed when you save."; });
    document.getElementById("signout").addEventListener("click", function () {
      cfg.token = ""; saveCfg(); try { localStorage.removeItem(LS); sessionStorage.removeItem(LS); } catch (e) {}
      repo = null; location.hash = "#/"; route();
    });
    document.getElementById("sf").addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target, data = JSON.parse(JSON.stringify(s));
      cfg.maxWidth = Number(f.maxWidth.value); saveCfg();
      data.name = f.name.value.trim(); data.tagline = f.tagline.value.trim(); data.accent = f.accent.value;
      data.contact = { phone: f.phone.value.trim(), email: f.email.value.trim(), website: f.website.value.trim() };
      data.listProjects = f.listProjects.checked;
      var changes = [];
      var logo = f.logo.files[0];
      if (logo) {
        var ext = (logo.name.match(/\.(png|svg|jpe?g)$/i) || [".png"])[0].toLowerCase();
        data.logo = "assets/logo" + ext;
        changes.push({ path: "site/assets/logo" + ext, blob: logo });
      } else if (rmLogo) { data.logo = ""; }
      changes.push({ path: "site.json", b64: textToB64(JSON.stringify(data, null, 2) + "\n") });
      var btn = f.querySelector("[type=submit]"); btn.textContent = "Saving…"; btn.disabled = true;
      commit("Update site settings", changes).then(function () {
        siteCfg.data = data; toast("Settings saved. Site updates in about a minute."); pollDeploy(true); viewSettings();
      }, function (err) { btn.textContent = "Save settings"; btn.disabled = false; alert("Couldn't save: " + errText(err)); });
    });
  }

  // ---------------------------------------------------------------- ui utils
  function modal(html) {
    var m = document.getElementById("modal");
    m.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + "</div>";
    m.hidden = false;
    m.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", closeModal); });
    m.addEventListener("click", function (e) { if (e.target === m) closeModal(); }, { once: true });
    var first = m.querySelector("input:not([type=checkbox])"); if (first) first.focus();
  }
  function closeModal() { var m = document.getElementById("modal"); m.hidden = true; m.innerHTML = ""; }
  var toastT;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.hidden = false;
    requestAnimationFrame(function () { t.classList.add("show"); });
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.hidden = true; }, 250); }, 2600);
  }
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove(); return Promise.resolve();
  }
  function h(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"; }
  function stem(f) { return String(f).replace(/\.[^.]+$/, ""); }
  function titleFromName(s) { var w = String(s).replace(/[-_]+/g, " ").trim(); return w ? w[0].toUpperCase() + w.slice(1) : "Panorama"; }
  function randomId(n) {
    var a = "abcdefghjkmnpqrstuvwxyz23456789", out = "", r = new Uint32Array(n);
    crypto.getRandomValues(r);
    for (var i = 0; i < n; i++) out += a[r[i] % a.length];
    return out;
  }
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fmtBytes(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB"; }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  route();
})();
