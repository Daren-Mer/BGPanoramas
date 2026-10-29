(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var project = DATA.project, site = DATA.site || {};
  var $ = function (id) { return document.getElementById(id); };
  var viewerUrl = new URL("../", location.href).href.split("#")[0];

  $("pc-sub").textContent = project.client || "";

  // targets
  var opt = new Option("Whole project (" + project.scenes.length + " view" + (project.scenes.length > 1 ? "s" : "") + ")", "");
  $("target").add(opt);
  project.scenes.forEach(function (s, i) { if (i > 0) $("target").add(new Option("Start on: " + s.title, s.id)); });
  if (project.scenes.length < 2) $("target").closest(".field").hidden = true;
  var preset = decodeURIComponent(location.hash.slice(1));
  if (preset) $("target").value = preset;

  function url() { var t = $("target").value; return t ? viewerUrl + "#" + encodeURIComponent(t) : viewerUrl; }
  function render() {
    var u = url();
    $("url").value = u;
    $("pc-url").textContent = u.replace(/^https?:\/\//, "");
    $("pc-cta").textContent = $("heading").value;
    var box = document.querySelector(".pc-qr");
    var size = Math.min(box.clientWidth, Math.max(box.clientHeight, 180), 260);
    QR.draw($("qr"), u, size, { margin: 1, ecl: "Q", fg: "#00143C" });
  }
  $("target").addEventListener("change", render);
  $("heading").addEventListener("input", render);
  window.addEventListener("resize", render);
  render();

  $("copy").addEventListener("click", function () {
    $("url").select();
    (navigator.clipboard ? navigator.clipboard.writeText(url()) : Promise.reject()).catch(function () { document.execCommand("copy"); });
    $("copy").textContent = "Copied"; setTimeout(function () { $("copy").textContent = "Copy"; }, 1500);
  });
  $("print").addEventListener("click", function () { window.print(); });

  function fileBase() { return (project.slug || "project") + ($("target").value ? "-" + $("target").value : ""); }

  $("dl-svg").addEventListener("click", function () {
    var blob = new Blob([QR.svg(url(), { margin: 2, ecl: "Q", fg: "#00143C" })], { type: "image/svg+xml" });
    download(URL.createObjectURL(blob), fileBase() + "-qr.svg");
  });
  $("dl-png").addEventListener("click", function () {
    var c = document.createElement("canvas");
    QR.draw(c, url(), 1024, { margin: 2, ecl: "Q", pixelRatio: 1, fg: "#00143C" });
    c.toBlob(function (b) { download(URL.createObjectURL(b), fileBase() + "-qr.png"); });
  });
  $("dl-card").addEventListener("click", function () { drawCard().then(function (b) { download(URL.createObjectURL(b), fileBase() + "-qr-card.png"); }); });

  function drawCard() {
    var W = 1200, H = 1600, c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var css = getComputedStyle(document.documentElement);
    var accent = css.getPropertyValue("--accent").trim() || "#0028F0";
    var NAVY = "#00143C", NAVY4 = "#002070", GRAY = "#5a6178";
    var font = getComputedStyle(document.body).fontFamily;
    // condensed display type where the browser supports it (Archivo / Sharp Grotesk)
    function display(px, weight, stretch) {
      g.font = (weight || 600) + " " + (stretch || "condensed") + " " + px + "px " + font;
    }
    function body(px, weight) {
      g.font = (weight || 400) + " " + px + "px " + font;
    }
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
    // header band
    g.fillStyle = NAVY; g.fillRect(0, 0, W, 150);
    g.fillStyle = accent; g.fillRect(0, 150, W, 10);
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    // official lockup, centered in the band (clear space kept by the band padding)
    var logo = $("pc-lockup");
    if (logo && logo.complete && logo.naturalWidth) {
      var lw = 560, lh = lw * logo.naturalHeight / logo.naturalWidth;
      g.drawImage(logo, (W - lw) / 2, (150 - lh) / 2, lw, lh);
    }
    if ("letterSpacing" in g) g.letterSpacing = "6px";
    // eyebrow
    g.fillStyle = accent; body(26, 600);
    g.fillText("PURSUIT  ·  360° WALKTHROUGH", W / 2, 232);
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    // title + client
    g.fillStyle = NAVY4; display(84, 600, "extra-condensed");
    var lines = wrap(g, project.title, W / 2, 318, W - 140, 88, 2);
    g.fillStyle = GRAY; body(38, 400);
    g.fillText(project.client || "", W / 2, 318 + (lines - 1) * 88 + 62);
    // QR in brand navy
    var qSize = lines > 1 ? 720 : 780, qTop = lines > 1 ? 520 : 460;
    var q = document.createElement("canvas");
    QR.draw(q, url(), qSize, { margin: 1, ecl: "Q", pixelRatio: 1, fg: NAVY });
    g.imageSmoothingEnabled = false;
    g.drawImage(q, (W - qSize) / 2, qTop, qSize, qSize);
    // CTA + url
    g.fillStyle = accent; display(76, 700, "ultra-condensed");
    g.fillText($("heading").value.toUpperCase(), W / 2, 1400);
    g.fillStyle = GRAY; body(30, 400);
    wrap(g, url().replace(/^https?:\/\//, ""), W / 2, 1464, W - 160, 38, 2);
    // bottom bar
    g.fillStyle = accent; g.fillRect(0, H - 24, W, 24);
    return new Promise(function (ok) { c.toBlob(ok, "image/png"); });
  }
  function wrap(g, text, x, y, maxW, lh, maxLines) {
    var words = String(text || "").split(/(?=[\/\s])/).filter(Boolean), line = "", lines = [];
    words.forEach(function (w) {
      var t = line + w;
      if (g.measureText(t).width > maxW && line) { lines.push(line.trim()); line = w.trim(); } else line = t;
    });
    if (line) lines.push(line.trim());
    lines = lines.slice(0, maxLines);
    lines.forEach(function (l, i) { g.fillText(l, x, y + i * lh); });
    return lines.length || 1;
  }
  function download(href, name) {
    var a = document.createElement("a"); a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
  }
})();
