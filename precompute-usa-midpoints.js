#!/usr/bin/env node
/**
 * Precomputes border midpoints for the USA four-color map activity.
 * Reads activities/four-color-usa.html, computes midpoints for all
 * adjacency pairs, and patches the file with a pre-populated cache.
 *
 * Usage: node precompute-usa-midpoints.js
 */

const fs = require('fs');
const path = require('path');

// ===== Path geometry utilities =====

function parsePath(d) {
  const segments = [];
  let current = [];
  let startPt = null;
  let curPt = null;

  const re = /([MLCZ])\s*([-\d.,eE\s]*)/gi;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1].toUpperCase();
    const nums = m[2].trim().length > 0
      ? m[2].trim().split(/[\s,]+/).map(Number)
      : [];

    if (cmd === 'M') {
      if (current.length > 0) segments.push(current);
      curPt = { x: nums[0], y: nums[1] };
      startPt = curPt;
      current = [curPt];
    } else if (cmd === 'L') {
      curPt = { x: nums[0], y: nums[1] };
      current.push(curPt);
    } else if (cmd === 'C') {
      // Cubic Bezier: linearize with 10 samples
      const p0 = curPt;
      const p1 = { x: nums[0], y: nums[1] };
      const p2 = { x: nums[2], y: nums[3] };
      const p3 = { x: nums[4], y: nums[5] };
      for (let t = 1; t <= 10; t++) {
        const s = t / 10;
        const u = 1 - s;
        current.push({
          x: u*u*u*p0.x + 3*u*u*s*p1.x + 3*u*s*s*p2.x + s*s*s*p3.x,
          y: u*u*u*p0.y + 3*u*u*s*p1.y + 3*u*s*s*p2.y + s*s*s*p3.y
        });
      }
      curPt = p3;
    } else if (cmd === 'Z') {
      if (startPt && current.length > 0) {
        const last = current[current.length - 1];
        if (last.x !== startPt.x || last.y !== startPt.y) {
          current.push(startPt);
        }
      }
      if (current.length > 0) segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function computeTotalLength(segments) {
  let total = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const dx = seg[i].x - seg[i - 1].x;
      const dy = seg[i].y - seg[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
}

function pointAtLength(segments, totalLen, targetLen) {
  let acc = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const dx = seg[i].x - seg[i - 1].x;
      const dy = seg[i].y - seg[i - 1].y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (acc + segLen >= targetLen) {
        const t = segLen > 0 ? (targetLen - acc) / segLen : 0;
        return { x: seg[i - 1].x + t * dx, y: seg[i - 1].y + t * dy };
      }
      acc += segLen;
    }
  }
  const lastSeg = segments[segments.length - 1];
  return lastSeg[lastSeg.length - 1];
}

function computeBBox(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segments) {
    for (const pt of seg) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function computeBorderMidpointFromPaths(segmentsA, segmentsB) {
  const lenA = computeTotalLength(segmentsA);
  const lenB = computeTotalLength(segmentsB);
  const N = 200;
  const threshold = 5;

  const borderPoints = [];
  for (let i = 0; i <= N; i++) {
    const ptA = pointAtLength(segmentsA, lenA, lenA * i / N);
    let bestDist = Infinity;
    let bestPt = null;
    for (let j = 0; j <= N; j++) {
      const ptB = pointAtLength(segmentsB, lenB, lenB * j / N);
      const dx = ptA.x - ptB.x, dy = ptA.y - ptB.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestPt = ptB;
      }
    }
    if (bestDist < threshold * threshold) {
      borderPoints.push({
        x: (ptA.x + bestPt.x) / 2,
        y: (ptA.y + bestPt.y) / 2
      });
    }
  }

  if (borderPoints.length === 0) {
    const bA = computeBBox(segmentsA), bB = computeBBox(segmentsB);
    return {
      x: (bA.x + bA.width / 2 + bB.x + bB.width / 2) / 2,
      y: (bA.y + bA.height / 2 + bB.y + bB.height / 2) / 2
    };
  }

  let bestStart = 0, bestLen = 1, curStart = 0, curLen = 1;
  for (let i = 1; i < borderPoints.length; i++) {
    const dx = borderPoints[i].x - borderPoints[i - 1].x;
    const dy = borderPoints[i].y - borderPoints[i - 1].y;
    if (dx * dx + dy * dy < 40 * 40) {
      curLen++;
    } else {
      curStart = i;
      curLen = 1;
    }
    if (curLen > bestLen) {
      bestStart = curStart;
      bestLen = curLen;
    }
  }

  const midIdx = bestStart + Math.floor(bestLen / 2);
  return borderPoints[midIdx];
}

// ===== Extract data from HTML =====

const htmlPath = path.join(__dirname, 'activities', 'four-color-usa.html');
let html = fs.readFileSync(htmlPath, 'utf-8');

// Extract US_STATES array
const statesMatch = html.match(/var US_STATES = \[([\s\S]*?)\];/);
if (!statesMatch) {
  console.error('Could not find US_STATES array');
  process.exit(1);
}

// Parse state entries: {id:'XX',name:'...',path:'...'}
const stateRegex = /\{id:'([^']+)',name:'([^']+)',path:'([^']*)'\}/g;
const states = [];
let sm;
while ((sm = stateRegex.exec(statesMatch[1])) !== null) {
  states.push({ id: sm[1], name: sm[2], path: sm[3] });
}
console.log(`Found ${states.length} states`);

// Extract US_ADJACENCY array
const adjMatch = html.match(/var US_ADJACENCY = \[([\s\S]*?)\];/);
if (!adjMatch) {
  console.error('Could not find US_ADJACENCY array');
  process.exit(1);
}

const adjRegex = /\['([A-Z]{2})','([A-Z]{2})'\]/g;
const adjPairs = [];
let am;
while ((am = adjRegex.exec(adjMatch[1])) !== null) {
  adjPairs.push([am[1], am[2]]);
}
console.log(`Found ${adjPairs.length} adjacency pairs`);

// ===== Compute midpoints =====

const stateIndex = {};
const parsedPaths = {};
states.forEach((s, i) => {
  stateIndex[s.id] = i;
  parsedPaths[s.id] = parsePath(s.path);
});

const midpointEntries = [];
for (const pair of adjPairs) {
  const idxA = stateIndex[pair[0]];
  const idxB = stateIndex[pair[1]];
  const key = Math.min(idxA, idxB) + '-' + Math.max(idxA, idxB);
  const mid = computeBorderMidpointFromPaths(parsedPaths[pair[0]], parsedPaths[pair[1]]);
  midpointEntries.push(`'${key}':{x:${Math.round(mid.x * 10) / 10},y:${Math.round(mid.y * 10) / 10}}`);
  process.stdout.write('.');
}
console.log(`\nComputed ${midpointEntries.length} border midpoints`);

const midpointCacheStr = midpointEntries.join(',');

// ===== Patch HTML =====

// Replace empty cache declaration with precomputed cache
html = html.replace(
  /var borderMidpointCache = \{[^}]*\};/,
  `var borderMidpointCache = {${midpointCacheStr}};`
);

// Remove cache reset in startOver() — midpoints are geometric constants
html = html.replace(
  /(\s+paletteState\.selectedEraser = false;\s*)\r?\n\s+borderMidpointCache = \{\};\s*/,
  '$1\n'
);

fs.writeFileSync(htmlPath, html, 'utf-8');
console.log(`Wrote ${htmlPath}`);
