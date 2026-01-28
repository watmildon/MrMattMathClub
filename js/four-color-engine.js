// ===== Four Color Engine — shared coloring mechanics =====
var FourColorEngine = (function() {

  var COLORS = ['#ef4444', '#60a5fa', '#fbbf24', '#34d399'];
  var REGION_DEFAULT = '#f1f5f9';
  var REGION_STROKE = '#64748b';

  // ---- Palette rendering ----

  function renderPalette(paletteEl, numColors, state, callbacks) {
    paletteEl.innerHTML = '';
    if (state.selectedColorIndex >= numColors) {
      state.selectedColorIndex = 0;
    }
    for (var i = 0; i < numColors; i++) {
      var swatch = document.createElement('button');
      var isSel = !state.selectedEraser && i === state.selectedColorIndex;
      swatch.className = 'swatch' + (isSel ? ' selected' : '');
      swatch.style.background = COLORS[i];
      swatch.setAttribute('aria-label', 'Color ' + (i + 1));
      (function(idx) {
        swatch.addEventListener('click', function() {
          selectColor(paletteEl, state, idx);
          if (callbacks && callbacks.onSelect) callbacks.onSelect(idx);
        });
      })(i);
      paletteEl.appendChild(swatch);
    }

    if (callbacks && callbacks.enableEraser) {
      var eraser = document.createElement('button');
      eraser.className = 'swatch eraser' + (state.selectedEraser ? ' selected' : '');
      eraser.setAttribute('aria-label', 'Eraser');
      eraser.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round"><path d="M4 4l12 12M16 4L4 16"/></svg>';
      eraser.addEventListener('click', function() {
        selectEraser(paletteEl, state);
        if (callbacks && callbacks.onEraser) callbacks.onEraser();
      });
      paletteEl.appendChild(eraser);
    }
  }

  function selectColor(paletteEl, state, index) {
    state.selectedColorIndex = index;
    state.selectedEraser = false;
    var swatches = paletteEl.querySelectorAll('.swatch');
    swatches.forEach(function(s, i) {
      s.classList.toggle('selected', i === index);
    });
  }

  function selectEraser(paletteEl, state) {
    state.selectedEraser = true;
    var swatches = paletteEl.querySelectorAll('.swatch');
    swatches.forEach(function(s) { s.classList.remove('selected'); });
    var eraser = paletteEl.querySelector('.swatch.eraser');
    if (eraser) eraser.classList.add('selected');
  }

  // ---- Conflict marker geometry ----

  function computeBorderMidpoint(svgEl, a, b) {
    var paths = svgEl.querySelectorAll('path[data-index]');
    var pathA = paths[a];
    var pathB = paths[b];
    var lenA = pathA.getTotalLength();
    var lenB = pathB.getTotalLength();
    var N = 60;
    var threshold = 4;
    var shared = [];

    for (var i = 0; i <= N; i++) {
      var ptA = pathA.getPointAtLength(lenA * i / N);
      for (var j = 0; j <= N; j++) {
        var ptB = pathB.getPointAtLength(lenB * j / N);
        var dx = ptA.x - ptB.x, dy = ptA.y - ptB.y;
        if (dx * dx + dy * dy < threshold * threshold) {
          shared.push({ x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2 });
        }
      }
    }

    if (shared.length === 0) {
      var bA = pathA.getBBox(), bB = pathB.getBBox();
      return { x: (bA.x + bA.width / 2 + bB.x + bB.width / 2) / 2,
               y: (bA.y + bA.height / 2 + bB.y + bB.height / 2) / 2 };
    }

    var sx = 0, sy = 0;
    for (var i = 0; i < shared.length; i++) { sx += shared[i].x; sy += shared[i].y; }
    var cx = sx / shared.length;
    var cy = sy / shared.length;

    var minDist = Infinity;
    var closest = shared[0];
    for (var i = 0; i < shared.length; i++) {
      var dx = shared[i].x - cx, dy = shared[i].y - cy;
      var d = dx * dx + dy * dy;
      if (d < minDist) { minDist = d; closest = shared[i]; }
    }

    if (Math.sqrt(minDist) > 15) return closest;

    return { x: cx, y: cy };
  }

  function getBorderMidpoint(cache, svgEl, a, b) {
    var key = Math.min(a, b) + '-' + Math.max(a, b);
    if (!cache[key]) {
      cache[key] = computeBorderMidpoint(svgEl, a, b);
    }
    return cache[key];
  }

  // ---- Conflict marker drawing ----

  function drawConflictMarkers(svgEl, adjacency, regionColors, cache) {
    var existing = svgEl.querySelector('#conflict-markers');
    if (existing) existing.remove();

    var conflictEdges = [];
    for (var e = 0; e < adjacency.length; e++) {
      var a = adjacency[e][0];
      var b = adjacency[e][1];
      if (regionColors[a] !== null && regionColors[b] !== null && regionColors[a] === regionColors[b]) {
        conflictEdges.push([a, b]);
      }
    }

    if (conflictEdges.length === 0) return;

    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', 'conflict-markers');
    g.setAttribute('class', 'conflict-x');
    g.style.pointerEvents = 'none';

    conflictEdges.forEach(function(pair) {
      var mid = getBorderMidpoint(cache, svgEl, pair[0], pair[1]);
      var size = 14;

      var line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line1.setAttribute('x1', mid.x - size);
      line1.setAttribute('y1', mid.y - size);
      line1.setAttribute('x2', mid.x + size);
      line1.setAttribute('y2', mid.y + size);

      var line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line2.setAttribute('x1', mid.x + size);
      line2.setAttribute('y1', mid.y - size);
      line2.setAttribute('x2', mid.x - size);
      line2.setAttribute('y2', mid.y + size);

      g.appendChild(line1);
      g.appendChild(line2);
    });

    svgEl.appendChild(g);
  }

  // ---- Confetti celebration ----

  function showConfetti(celebrationEl) {
    celebrationEl.innerHTML = '';
    var colors = ['#7c3aed', '#4c6ef5', '#10b981', '#f59e0b', '#ec4899', '#34d399'];
    for (var i = 0; i < 20; i++) {
      var dot = document.createElement('div');
      dot.className = 'confetti';
      dot.style.left = Math.random() * 100 + '%';
      dot.style.top = Math.random() * 40 + '%';
      dot.style.background = colors[Math.floor(Math.random() * colors.length)];
      dot.style.animation = 'confettiFall 0.8s ' + (Math.random() * 0.3) + 's ease-out forwards';
      celebrationEl.appendChild(dot);
    }
  }

  // ---- Public API ----
  return {
    COLORS: COLORS,
    REGION_DEFAULT: REGION_DEFAULT,
    REGION_STROKE: REGION_STROKE,
    renderPalette: renderPalette,
    selectColor: selectColor,
    selectEraser: selectEraser,
    computeBorderMidpoint: computeBorderMidpoint,
    getBorderMidpoint: getBorderMidpoint,
    drawConflictMarkers: drawConflictMarkers,
    showConfetti: showConfetti
  };

})();
