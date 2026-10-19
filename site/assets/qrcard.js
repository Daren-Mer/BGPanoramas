(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var project = DATA.project, site = DATA.site || {};
  var $ = function (id) { return document.getElementById(id); };
  var viewerUrl = new URL("../", location.href).href.split("#")[0];

  // brand
  if (site.logo) {
    var img = new Image(); img.src = "../../../" + site.logo.replace(/^\/+/, ""); $("pc-brand").appendChild(img);
    $("pc-brand").style.background = "transparent";
  } else if (site.name) {
    $("pc-brand").textContent = site.name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 3).toUpperCase();
  } else $("pc-brand").hidden = true;
  $("pc-company").textContent = site.name || "";
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
    QR.draw($("qr"), u, size, { margin: 1, ecl: "Q" });
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
    var blob = new Blob([QR.svg(url(), { margin: 2, ecl: "Q" })], { type: "image/svg+xml" });
    download(URL.createObjectURL(blob), fileBase() + "-qr.svg");
  });
  $("dl-png").addEventListener("click", function () {
    var c = document.createElement("canvas");
    QR.draw(c, url(), 1024, { margin: 2, ecl: "Q", pixelRatio: 1 });
    c.toBlob(function (b) { download(URL.createObjectURL(b), fileBase() + "-qr.png"); });
  });
  $("dl-card").addEventListener("click", function () { drawCard().then(function (b) { download(URL.createObjectURL(b), fileBase() + "-qr-card.png"); }); });

  function drawCard() {
    var W = 1200, H = 1600, c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f2994a";
    var font = getComputedStyle(document.body).fontFamily;
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
    g.fillStyle = accent; g.fillRect(0, 0, W, 22);
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillStyle = "#15171b";
    g.font = "600 40px " + font; g.fillText(site.name || "", W / 2, 120);
    g.font = "700 72px " + font;
    var lines = wrap(g, project.title, W / 2, 250, W - 160, 84, 2);
    g.fillStyle = "#5d6168"; g.font = "400 40px " + font; g.fillText(project.client || "", W / 2, 250 + (lines - 1) * 84 + 70);
    var q = document.createElement("canvas");
    QR.draw(q, url(), 820, { margin: 1, ecl: "Q", pixelRatio: 1 });
    g.imageSmoothingEnabled = false;
    g.drawImage(q, (W - 820) / 2, 450, 820, 820);
    g.fillStyle = "#15171b"; g.font = "700 54px " + font; g.fillText($("heading").value, W / 2, 1380);
    g.fillStyle = "#6b6f76"; g.font = "400 30px " + font; wrap(g, url().replace(/^https?:\/\//, ""), W / 2, 1450, W - 160, 38, 3);
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
