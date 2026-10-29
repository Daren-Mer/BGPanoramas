(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var project = DATA.project, site = DATA.site || {};
  var scenes = project.scenes;
  var $ = function (id) { return document.getElementById(id); };
  var isTouch = matchMedia("(pointer: coarse)").matches;

  // ---------- viewer ----------
  var byId = {};
  scenes.forEach(function (s) { byId[s.id] = s; });
  var hashId = decodeURIComponent(location.hash.slice(1));
  var first = byId[hashId] ? hashId : scenes[0].id;

  var pScenes = {};
  scenes.forEach(function (s) {
    var cfg = {
      type: "equirectangular",
      panorama: s.panorama,
      preview: s.thumb,
      yaw: s.yaw, pitch: s.pitch, hfov: s.hfov,
      haov: s.haov, vaov: s.vaov
    };
    ["vOffset", "minPitch", "maxPitch", "northOffset", "hotSpots"].forEach(function (k) {
      if (s[k] != null) cfg[k] = s[k];
    });
    pScenes[s.id] = cfg;
  });

  var viewer = pannellum.viewer("pano", {
    default: {
      firstScene: first,
      autoLoad: true,
      sceneFadeDuration: 700,
      showControls: false,
      compass: false,
      minHfov: 35,
      maxHfov: 120,
      autoRotate: project.autoRotate ? -2.5 : 0,
      friction: 0.2,
      strings: { loadingLabel: "Loading 360° view…" }
    },
    scenes: pScenes
  });

  var current = first;
  function onScene(id) {
    current = id;
    var s = byId[id];
    $("scene-title").textContent = scenes.length > 1 ? s.title + "  ·  " + (scenes.indexOf(s) + 1) + "/" + scenes.length : s.title;
    document.title = s.title + " · " + project.title;
    history.replaceState(null, "", id === scenes[0].id ? location.pathname + location.search : "#" + encodeURIComponent(id));
    Array.prototype.forEach.call($("strip").children, function (el) {
      var on = el.dataset.id === id;
      el.classList.toggle("active", on);
      el.setAttribute("aria-current", on ? "true" : "false");
      if (on) el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    });
    $("share-scene-name").textContent = s.title;
  }
  viewer.on("scenechange", onScene);

  // ---------- scene strip ----------
  if (scenes.length > 1) {
    $("strip-wrap").hidden = false;
    $("strip-count").textContent = scenes.length + " views";
    scenes.forEach(function (s) {
      var b = document.createElement("button");
      b.className = "thumb";
      b.dataset.id = s.id;
      b.setAttribute("role", "listitem");
      b.innerHTML = '<img loading="lazy" alt=""><span></span>';
      b.querySelector("img").src = s.thumb;
      b.querySelector("span").textContent = s.title;
      b.addEventListener("click", function () { if (s.id !== current) viewer.loadScene(s.id); });
      $("strip").appendChild(b);
    });
    var collapsed = false;
    $("strip-toggle").addEventListener("click", function () {
      collapsed = !collapsed;
      $("strip-wrap").classList.toggle("collapsed", collapsed);
      $("strip-toggle").setAttribute("aria-expanded", String(!collapsed));
    });
  }
  onScene(first);

  // ---------- hint ----------
  var hint = $("hint");
  viewer.on("load", function () {
    if (safeGet("hinted")) return;
    hint.hidden = false;
    setTimeout(function () { hint.classList.add("gone"); }, 3800);
    safeSet("hinted", "1");
  });
  ["mousedown", "touchstart"].forEach(function (ev) {
    viewer.on(ev, function () { hint.classList.add("gone"); });
  });
  if (isTouch) $("hint-text").textContent = "Swipe to look around · pinch to zoom";

  // ---------- gyro ----------
  if (viewer.isOrientationSupported()) {
    $("btn-gyro").hidden = false;
    $("btn-gyro").addEventListener("click", function () {
      if (viewer.isOrientationActive()) viewer.stopOrientation();
      else { viewer.stopAutoRotate(); viewer.startOrientation(); }
      setTimeout(syncGyro, 400);
    });
  } else {
    $("howto-gyro").hidden = true;
  }
  function syncGyro() { $("btn-gyro").classList.toggle("on", viewer.isOrientationActive()); }
  viewer.on("mousedown", function () { setTimeout(syncGyro, 50); });

  // ---------- fullscreen (not available on iPhone Safari) ----------
  var el = document.documentElement;
  if (el.requestFullscreen || el.webkitRequestFullscreen) {
    $("btn-full").hidden = false;
    $("btn-full").addEventListener("click", function () {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    });
  }
  ["fullscreenchange", "webkitfullscreenchange"].forEach(function (ev) {
    document.addEventListener(ev, function () { setTimeout(function () { viewer.resize(); }, 100); });
  });

  // ---------- sheets ----------
  var openSheet = null;
  function show(id) {
    hide();
    openSheet = $(id);
    $("sheet-backdrop").hidden = false;
    openSheet.hidden = false;
    requestAnimationFrame(function () { openSheet.classList.add("open"); $("sheet-backdrop").classList.add("open"); });
  }
  function hide() {
    if (!openSheet) return;
    var s = openSheet;
    openSheet = null;
    s.classList.remove("open");
    $("sheet-backdrop").classList.remove("open");
    setTimeout(function () { s.hidden = true; if (!openSheet) $("sheet-backdrop").hidden = true; }, 220);
  }
  $("sheet-backdrop").addEventListener("click", hide);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });

  // share
  function shareUrl() {
    var base = location.origin + location.pathname;
    return $("share-scene").checked && current !== scenes[0].id ? base + "#" + encodeURIComponent(current) : base;
  }
  function renderShare() {
    var url = shareUrl();
    $("share-link").textContent = url.replace(/^https?:\/\//, "");
    QR.draw($("share-qr"), url, 200, { margin: 2 });
  }
  $("share-scene").parentNode.hidden = scenes.length < 2;
  $("share-scene").addEventListener("change", renderShare);
  $("btn-share").addEventListener("click", function () {
    $("share-scene").checked = false;
    renderShare();
    show("sheet-share");
  });
  $("btn-copy").addEventListener("click", function () {
    copy(shareUrl()).then(function () { toast("Link copied"); }, function () { toast("Couldn't copy, long-press the link instead"); });
  });
  if (navigator.share) {
    $("btn-native-share").hidden = false;
    $("btn-native-share").addEventListener("click", function () {
      navigator.share({ title: project.title, text: project.title + " (360° view)", url: shareUrl() }).catch(function () {});
    });
  }

  // info
  $("info-title").textContent = project.title;
  $("info-meta").textContent = [project.client, formatDate(project.date), scenes.length + (scenes.length === 1 ? " view" : " views")]
    .filter(Boolean).join("  ·  ");
  $("info-desc").textContent = project.description || "";
  $("info-desc").hidden = !project.description;
  var c = site.contact || {}, contact = $("info-contact");
  if (c.phone) addLink(contact, "tel:" + c.phone.replace(/[^\d+]/g, ""), c.phone);
  if (c.email) addLink(contact, "mailto:" + c.email, c.email);
  if (c.website) addLink(contact, /^https?:/.test(c.website) ? c.website : "https://" + c.website, c.website.replace(/^https?:\/\//, ""));
  $("btn-info").addEventListener("click", function () { show("sheet-info"); });

  // ---------- utils ----------
  function addLine(parent, tag, text) { var e = document.createElement(tag); e.textContent = text; parent.appendChild(e); }
  function addLink(parent, href, text) {
    var a = document.createElement("a"); a.href = href; a.textContent = text;
    if (/^https?:/.test(href)) { a.target = "_blank"; a.rel = "noopener"; }
    parent.appendChild(a);
  }
  function formatDate(d) {
    if (!d) return "";
    var t = new Date(d + "T12:00:00");
    return isNaN(t) ? d : t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? ok() : fail(); } catch (e) { fail(e); }
      ta.remove();
    });
  }
  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.hidden = true; }, 250); }, 1800);
  }
  function safeGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  window.addEventListener("hashchange", function () {
    var id = decodeURIComponent(location.hash.slice(1));
    if (byId[id] && id !== current) viewer.loadScene(id);
  });
})();
