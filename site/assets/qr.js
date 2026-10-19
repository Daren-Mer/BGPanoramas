/* Small helpers on top of qrcode-generator (MIT) */
(function () {
  function make(text, ecl) {
    var qr = qrcode(0, ecl || "M");
    qr.addData(text);
    qr.make();
    return qr;
  }

  // Draws a crisp QR on a canvas. size = CSS pixels; drawn at device resolution.
  function drawQR(canvas, text, size, opts) {
    opts = opts || {};
    var qr = make(text, opts.ecl);
    var n = qr.getModuleCount();
    var margin = opts.margin == null ? 2 : opts.margin;
    var cells = n + margin * 2;
    var scale = opts.pixelRatio || Math.max(1, Math.ceil(window.devicePixelRatio || 1));
    var px = Math.floor((size * scale) / cells) * cells || cells;
    var cell = px / cells;
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.bg || "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opts.fg || "#000000";
    for (var r = 0; r < n; r++)
      for (var c = 0; c < n; c++)
        if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
    return canvas;
  }

  function qrSVG(text, opts) {
    opts = opts || {};
    var qr = make(text, opts.ecl);
    var n = qr.getModuleCount();
    var m = opts.margin == null ? 2 : opts.margin;
    var size = n + m * 2;
    var d = "";
    for (var r = 0; r < n; r++)
      for (var c = 0; c < n; c++)
        if (qr.isDark(r, c)) d += "M" + (c + m) + " " + (r + m) + "h1v1h-1z";
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size +
      '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="' + (opts.bg || "#fff") +
      '"/><path fill="' + (opts.fg || "#000") + '" d="' + d + '"/></svg>'
    );
  }

  window.QR = { draw: drawQR, svg: qrSVG };
})();
