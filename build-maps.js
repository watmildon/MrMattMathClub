#!/usr/bin/env node
/**
 * Build script: Converts Natural Earth 50m GeoJSON country data into
 * self-contained HTML four-color map activities for each continent.
 *
 * Usage: node build-maps.js
 *
 * Source data: Natural Earth 50m admin 0 countries (public domain)
 * Projection: Mercator (clamped at ±85° latitude)
 */

const fs = require('fs');
const path = require('path');

// ===== Load GeoJSON =====
const geojson = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'ne_50m_countries.geojson'), 'utf-8')
);
console.log(`Loaded ${geojson.features.length} features from GeoJSON`);

// Build lookup by ISO A2 (lowercase)
const featuresByCode = {};
for (const f of geojson.features) {
  const code = (f.properties.iso_a2 || '').toLowerCase();
  if (code && code !== '-99') {
    featuresByCode[code] = f;
  }
}

// Register territories that have no ISO code (iso_a2 = -99) under custom codes
const unrecognized = { 'xk': 'Kosovo' };
for (const [code, admin] of Object.entries(unrecognized)) {
  const f = geojson.features.find(feat => feat.properties.admin === admin);
  if (f) featuresByCode[code] = f;
}

// Stitch two polygon rings that share a border into a single ring.
// Walks around the outside of both polygons, skipping the shared interior border.
function stitchRings(mainRing, mergeRing) {
  const threshold = 0.001;
  const mainShared = [];
  const mergeShared = [];
  for (let i = 0; i < mergeRing.length - 1; i++) { // skip closing duplicate
    for (let j = 0; j < mainRing.length - 1; j++) {
      if (Math.abs(mergeRing[i][0] - mainRing[j][0]) < threshold &&
          Math.abs(mergeRing[i][1] - mainRing[j][1]) < threshold) {
        mergeShared.push(i);
        mainShared.push(j);
        break;
      }
    }
  }
  if (mainShared.length < 2) return null;

  const mainStart = Math.min(...mainShared);
  const mainEnd = Math.max(...mainShared);
  const mergeStart = Math.min(...mergeShared);
  const mergeEnd = Math.max(...mergeShared);

  const merged = [];
  // Walk main ring's non-shared portion (from mainEnd, wrapping around to mainStart)
  for (let i = mainEnd; i !== mainStart; i = (i + 1) % (mainRing.length - 1)) {
    merged.push(mainRing[i]);
  }
  merged.push(mainRing[mainStart]);
  // Walk merge ring's non-shared portion (from mergeEnd, wrapping around to mergeStart)
  for (let i = mergeEnd; i !== mergeStart; i = (i + 1) % (mergeRing.length - 1)) {
    merged.push(mergeRing[i]);
  }
  merged.push(merged[0]); // close ring
  return merged;
}

// Natural Earth splits some territories into separate features. Stitch them back
// into their parent country so no internal border line is drawn.
// - Somaliland (no ISO code) → merge into Somalia
// - Western Sahara (ISO: EH) → merge into Morocco
// - Siachen Glacier (no ISO code) → merge into India
const merges = [
  { targetCode: 'so', findBy: f => f.properties.admin === 'Somaliland' },
  { targetCode: 'ma', findBy: f => (f.properties.iso_a2 || '').toLowerCase() === 'eh' },
  { targetCode: 'in', findBy: f => f.properties.admin === 'Siachen Glacier' },
];
for (const { targetCode, findBy } of merges) {
  const mergeFeature = geojson.features.find(findBy);
  const target = featuresByCode[targetCode];
  if (!mergeFeature || !target) continue;

  if (target.geometry.type === 'Polygon') {
    const merged = stitchRings(target.geometry.coordinates[0], mergeFeature.geometry.coordinates[0]);
    if (merged) {
      target.geometry = { type: 'Polygon', coordinates: [merged] };
    }
  } else if (target.geometry.type === 'MultiPolygon') {
    // Find which sub-polygon shares the border and stitch into it
    for (let pi = 0; pi < target.geometry.coordinates.length; pi++) {
      const merged = stitchRings(target.geometry.coordinates[pi][0], mergeFeature.geometry.coordinates[0]);
      if (merged) {
        target.geometry.coordinates[pi] = [merged];
        break;
      }
    }
  }
}

// ===== Mercator projection =====
// Projects [lon, lat] to [x, y] in SVG coordinate space.
// We define a bounding box in lon/lat for each continent, and map it
// to a target SVG viewBox.

function mercatorY(lat) {
  // Clamp to avoid infinity at poles
  const maxLat = 85;
  lat = Math.max(-maxLat, Math.min(maxLat, lat));
  const radLat = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + radLat / 2));
}

function createProjection(lonMin, lonMax, latMin, latMax, svgW, svgH, padding) {
  padding = padding || 20;
  // In Mercator, higher lat = larger y value. But in SVG, y increases downward.
  // So mercatorY(latMax) is the top (smallest SVG y) and mercatorY(latMin) is the bottom.
  const mercTop = mercatorY(latMax);   // larger Mercator value = top of map
  const mercBottom = mercatorY(latMin); // smaller Mercator value = bottom of map

  // Convert longitude range to radians to match Mercator Y units
  const geoW = (lonMax - lonMin) * Math.PI / 180;
  const geoH = mercTop - mercBottom;   // positive value (already in radians)

  // Scale to fit SVG with padding, maintaining aspect ratio
  const scaleX = (svgW - 2 * padding) / geoW;
  const scaleY = (svgH - 2 * padding) / geoH;
  const scale = Math.min(scaleX, scaleY);

  // Center the map
  const projW = geoW * scale;
  const projH = geoH * scale;
  const offsetX = padding + (svgW - 2 * padding - projW) / 2;
  const offsetY = padding + (svgH - 2 * padding - projH) / 2;

  return function(lon, lat) {
    const x = (lon - lonMin) * Math.PI / 180 * scale + offsetX;
    const y = (mercTop - mercatorY(lat)) * scale + offsetY; // flip Y: top of map = small SVG y
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  };
}

// ===== GeoJSON to SVG path =====

function ringToPath(ring, proj) {
  let d = '';
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = proj(ring[i][0], ring[i][1]);
    d += (i === 0 ? 'M' : 'L') + x + ',' + y;
  }
  d += 'Z';
  return d;
}

function geometryToPath(geometry, proj, lonBounds) {
  // lonBounds: optional {min, max} to filter polygons by centroid longitude
  let pathParts = [];

  if (geometry.type === 'Polygon') {
    // Check if polygon centroid is within lon bounds
    if (lonBounds && !polygonInBounds(geometry.coordinates[0], lonBounds)) {
      return '';
    }
    for (const ring of geometry.coordinates) {
      pathParts.push(ringToPath(ring, proj));
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      // Filter each polygon by centroid
      if (lonBounds && !polygonInBounds(polygon[0], lonBounds)) {
        continue;
      }
      for (const ring of polygon) {
        pathParts.push(ringToPath(ring, proj));
      }
    }
  }

  return pathParts.join(' ');
}

function polygonInBounds(outerRing, bounds) {
  // Check if the polygon's bounding box overlaps the visible area at all.
  // This includes polygons that partially overlap (e.g., mainland Russia
  // extending across the Europe crop boundary).
  let polyMinLon = Infinity, polyMaxLon = -Infinity;
  let polyMinLat = Infinity, polyMaxLat = -Infinity;
  for (const coord of outerRing) {
    if (coord[0] < polyMinLon) polyMinLon = coord[0];
    if (coord[0] > polyMaxLon) polyMaxLon = coord[0];
    if (coord[1] < polyMinLat) polyMinLat = coord[1];
    if (coord[1] > polyMaxLat) polyMaxLat = coord[1];
  }
  // Two rectangles overlap if they are not separated on either axis
  return polyMaxLon >= bounds.lonMin && polyMinLon <= bounds.lonMax &&
         polyMaxLat >= bounds.latMin && polyMinLat <= bounds.latMax;
}

// ===== Path geometry utilities (for precomputing border midpoints) =====

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

// ===== Continent definitions =====

const continents = {
  europe: {
    file: 'four-color-europe.html',
    svgW: 800, svgH: 700,
    // Geographic bounds (lon/lat)
    lonMin: -25, lonMax: 45, latMin: 34, latMax: 72,
    title: 'Four Color Europe',
    storagePrefix: 'fourColorEurope',
    successMsg: 'You colored all of Europe!',
    countries: [
      { id: 'is', name: 'Iceland' },
      { id: 'no', name: 'Norway' },
      { id: 'se', name: 'Sweden' },
      { id: 'fi', name: 'Finland' },
      { id: 'ru', name: 'Russia' },
      { id: 'ee', name: 'Estonia' },
      { id: 'lv', name: 'Latvia' },
      { id: 'lt', name: 'Lithuania' },
      { id: 'by', name: 'Belarus' },
      { id: 'ua', name: 'Ukraine' },
      { id: 'pl', name: 'Poland' },
      { id: 'de', name: 'Germany' },
      { id: 'cz', name: 'Czechia' },
      { id: 'sk', name: 'Slovakia' },
      { id: 'hu', name: 'Hungary' },
      { id: 'at', name: 'Austria' },
      { id: 'ch', name: 'Switzerland' },
      { id: 'fr', name: 'France' },
      { id: 'es', name: 'Spain' },
      { id: 'pt', name: 'Portugal' },
      { id: 'it', name: 'Italy' },
      { id: 'si', name: 'Slovenia' },
      { id: 'hr', name: 'Croatia' },
      { id: 'ba', name: 'Bosnia & Herzegovina' },
      { id: 'rs', name: 'Serbia' },
      { id: 'me', name: 'Montenegro' },
      { id: 'mk', name: 'North Macedonia' },
      { id: 'al', name: 'Albania' },
      { id: 'gr', name: 'Greece' },
      { id: 'bg', name: 'Bulgaria' },
      { id: 'ro', name: 'Romania' },
      { id: 'md', name: 'Moldova' },
      { id: 'nl', name: 'Netherlands' },
      { id: 'be', name: 'Belgium' },
      { id: 'lu', name: 'Luxembourg' },
      { id: 'dk', name: 'Denmark' },
      { id: 'gb', name: 'United Kingdom' },
      { id: 'ie', name: 'Ireland' },
      { id: 'tr', name: 'Turkey' },
      { id: 'xk', name: 'Kosovo' },
      { id: 'ad', name: 'Andorra' },
    ],
    adjacency: [
      ['no','se'],['no','fi'],['no','ru'],['se','fi'],['fi','ru'],
      ['ee','lv'],['ee','ru'],['lv','lt'],['lv','ru'],['lv','by'],
      ['lt','pl'],['lt','by'],['lt','ru'],['by','ru'],['by','ua'],['by','pl'],
      ['ua','ru'],['ua','pl'],['ua','sk'],['ua','hu'],['ua','ro'],['ua','md'],
      ['pl','de'],['pl','cz'],['pl','sk'],
      ['de','cz'],['de','at'],['de','ch'],['de','fr'],['de','nl'],['de','be'],['de','lu'],['de','dk'],
      ['cz','sk'],['cz','at'],['sk','hu'],['sk','at'],
      ['hu','at'],['hu','si'],['hu','hr'],['hu','rs'],['hu','ro'],
      ['at','ch'],['at','si'],['at','it'],
      ['ch','fr'],['ch','it'],
      ['fr','es'],['fr','be'],['fr','lu'],['fr','it'],['fr','ad'],
      ['es','pt'],['es','ad'],
      ['it','si'],
      ['si','hr'],
      ['hr','ba'],['hr','rs'],['hr','me'],
      ['ba','rs'],['ba','me'],
      ['rs','me'],['rs','xk'],['rs','mk'],['rs','bg'],['rs','ro'],
      ['xk','me'],['xk','al'],['xk','mk'],
      ['me','al'],['me','mk'],
      ['mk','al'],['mk','bg'],['mk','gr'],
      ['al','gr'],
      ['bg','ro'],['bg','gr'],['bg','tr'],
      ['gr','tr'],
      ['ro','md'],
      ['nl','be'],
      ['gb','ie'],
    ]
  },

  asia: {
    file: 'four-color-asia.html',
    svgW: 1000, svgH: 700,
    lonMin: 25, lonMax: 150, latMin: -10, latMax: 55,
    title: 'Four Color Asia',
    storagePrefix: 'fourColorAsia',
    successMsg: 'You colored all of Asia!',
    countries: [
      { id: 'ru', name: 'Russia' },
      { id: 'cn', name: 'China' },
      { id: 'in', name: 'India' },
      { id: 'kz', name: 'Kazakhstan' },
      { id: 'sa', name: 'Saudi Arabia' },
      { id: 'ir', name: 'Iran' },
      { id: 'mn', name: 'Mongolia' },
      { id: 'id', name: 'Indonesia' },
      { id: 'pk', name: 'Pakistan' },
      { id: 'tr', name: 'Turkey' },
      { id: 'mm', name: 'Myanmar' },
      { id: 'af', name: 'Afghanistan' },
      { id: 'ye', name: 'Yemen' },
      { id: 'th', name: 'Thailand' },
      { id: 'tm', name: 'Turkmenistan' },
      { id: 'uz', name: 'Uzbekistan' },
      { id: 'iq', name: 'Iraq' },
      { id: 'jp', name: 'Japan' },
      { id: 'vn', name: 'Vietnam' },
      { id: 'my', name: 'Malaysia' },
      { id: 'om', name: 'Oman' },
      { id: 'kg', name: 'Kyrgyzstan' },
      { id: 'tj', name: 'Tajikistan' },
      { id: 'la', name: 'Laos' },
      { id: 'kh', name: 'Cambodia' },
      { id: 'bd', name: 'Bangladesh' },
      { id: 'np', name: 'Nepal' },
      { id: 'kr', name: 'South Korea' },
      { id: 'kp', name: 'North Korea' },
      { id: 'jo', name: 'Jordan' },
      { id: 'ae', name: 'UAE' },
      { id: 'sy', name: 'Syria' },
      { id: 'lb', name: 'Lebanon' },
      { id: 'il', name: 'Israel' },
      { id: 'ge', name: 'Georgia' },
      { id: 'am', name: 'Armenia' },
      { id: 'az', name: 'Azerbaijan' },
      { id: 'ph', name: 'Philippines' },
      { id: 'tw', name: 'Taiwan' },
      { id: 'lk', name: 'Sri Lanka' },
      { id: 'bt', name: 'Bhutan' },
      { id: 'bn', name: 'Brunei' },
      { id: 'kw', name: 'Kuwait' },
      { id: 'qa', name: 'Qatar' },
      { id: 'ps', name: 'Palestine' },
    ],
    adjacency: [
      ['ru','cn'],['ru','mn'],['ru','kz'],['ru','kp'],['ru','ge'],['ru','az'],
      ['cn','mn'],['cn','kz'],['cn','kg'],['cn','tj'],['cn','af'],['cn','pk'],['cn','in'],['cn','np'],['cn','bt'],['cn','mm'],['cn','la'],['cn','vn'],['cn','kp'],
      ['in','pk'],['in','np'],['in','bt'],['in','bd'],['in','mm'],
      ['kz','kg'],['kz','uz'],['kz','tm'],
      ['sa','ye'],['sa','om'],['sa','ae'],['sa','qa'],['sa','kw'],['sa','iq'],['sa','jo'],
      ['ir','iq'],['ir','tr'],['ir','af'],['ir','pk'],['ir','tm'],['ir','az'],['ir','am'],
      ['tr','sy'],['tr','iq'],['tr','ir'],['tr','ge'],['tr','am'],['tr','az'],
      ['mm','cn'],['mm','la'],['mm','th'],['mm','bd'],
      ['af','pk'],['af','ir'],['af','tm'],['af','uz'],['af','tj'],
      ['ye','om'],
      ['th','la'],['th','kh'],['th','my'],
      ['tm','uz'],
      ['uz','af'],['uz','tj'],['uz','kg'],
      ['iq','kw'],['iq','sy'],['iq','jo'],
      ['vn','la'],['vn','kh'],
      ['la','kh'],
      ['np','cn'],
      ['kr','kp'],
      ['jo','sy'],['jo','il'],['jo','ps'],
      ['ae','om'],
      ['sy','lb'],['sy','il'],
      ['lb','il'],
      ['il','ps'],
      ['ge','am'],['ge','az'],
      ['am','az'],
      ['kg','tj'],
      ['bt','cn'],
      ['my','bn'],['my','id'],
    ]
  },

  africa: {
    file: 'four-color-africa.html',
    svgW: 700, svgH: 800,
    lonMin: -20, lonMax: 55, latMin: -36, latMax: 38,
    title: 'Four Color Africa',
    storagePrefix: 'fourColorAfrica',
    successMsg: 'You colored all of Africa!',
    countries: [
      { id: 'ma', name: 'Morocco' },
      { id: 'dz', name: 'Algeria' },
      { id: 'tn', name: 'Tunisia' },
      { id: 'ly', name: 'Libya' },
      { id: 'eg', name: 'Egypt' },
      { id: 'mr', name: 'Mauritania' },
      { id: 'ml', name: 'Mali' },
      { id: 'ne', name: 'Niger' },
      { id: 'td', name: 'Chad' },
      { id: 'sd', name: 'Sudan' },
      { id: 'ss', name: 'South Sudan' },
      { id: 'er', name: 'Eritrea' },
      { id: 'dj', name: 'Djibouti' },
      { id: 'so', name: 'Somalia' },
      { id: 'et', name: 'Ethiopia' },
      { id: 'sn', name: 'Senegal' },
      { id: 'gm', name: 'Gambia' },
      { id: 'gw', name: 'Guinea-Bissau' },
      { id: 'gn', name: 'Guinea' },
      { id: 'sl', name: 'Sierra Leone' },
      { id: 'lr', name: 'Liberia' },
      { id: 'ci', name: 'Ivory Coast' },
      { id: 'bf', name: 'Burkina Faso' },
      { id: 'gh', name: 'Ghana' },
      { id: 'tg', name: 'Togo' },
      { id: 'bj', name: 'Benin' },
      { id: 'ng', name: 'Nigeria' },
      { id: 'cm', name: 'Cameroon' },
      { id: 'cf', name: 'Central African Republic' },
      { id: 'ga', name: 'Gabon' },
      { id: 'cg', name: 'Congo' },
      { id: 'cd', name: 'DR Congo' },
      { id: 'ug', name: 'Uganda' },
      { id: 'ke', name: 'Kenya' },
      { id: 'rw', name: 'Rwanda' },
      { id: 'bi', name: 'Burundi' },
      { id: 'tz', name: 'Tanzania' },
      { id: 'ao', name: 'Angola' },
      { id: 'zm', name: 'Zambia' },
      { id: 'mw', name: 'Malawi' },
      { id: 'mz', name: 'Mozambique' },
      { id: 'zw', name: 'Zimbabwe' },
      { id: 'bw', name: 'Botswana' },
      { id: 'na', name: 'Namibia' },
      { id: 'za', name: 'South Africa' },
      { id: 'sz', name: 'Eswatini' },
      { id: 'ls', name: 'Lesotho' },
      { id: 'mg', name: 'Madagascar' },
      { id: 'gq', name: 'Equatorial Guinea' },
    ],
    adjacency: [
      ['ma','dz'],['ma','mr'],
      ['dz','tn'],['dz','ly'],['dz','ne'],['dz','ml'],['dz','mr'],
      ['tn','ly'],
      ['ly','eg'],['ly','sd'],['ly','td'],['ly','ne'],
      ['eg','sd'],
      ['mr','sn'],['mr','ml'],
      ['ml','sn'],['ml','gn'],['ml','ci'],['ml','bf'],['ml','ne'],
      ['ne','td'],['ne','ng'],['ne','bj'],['ne','bf'],
      ['td','sd'],['td','cf'],['td','cm'],['td','ng'],
      ['sd','ss'],['sd','et'],['sd','er'],['sd','eg'],['sd','cf'],
      ['ss','et'],['ss','ke'],['ss','ug'],['ss','cd'],['ss','cf'],
      ['er','et'],['er','dj'],
      ['dj','so'],['dj','et'],
      ['so','et'],['so','ke'],
      ['et','ke'],
      ['sn','gm'],['sn','gw'],['sn','gn'],
      ['gw','gn'],
      ['gn','sl'],['gn','lr'],['gn','ci'],['gn','ml'],
      ['sl','lr'],
      ['lr','ci'],
      ['ci','bf'],['ci','gh'],
      ['bf','gh'],['bf','tg'],['bf','bj'],
      ['gh','tg'],
      ['tg','bj'],
      ['bj','ng'],
      ['ng','cm'],
      ['cm','cf'],['cm','cg'],['cm','ga'],['cm','gq'],
      ['cf','cd'],['cf','cg'],
      ['ga','gq'],['ga','cg'],
      ['cg','cd'],['cg','ao'],
      ['cd','ug'],['cd','rw'],['cd','bi'],['cd','tz'],['cd','zm'],['cd','ao'],
      ['ug','ke'],['ug','tz'],['ug','rw'],
      ['ke','tz'],
      ['rw','bi'],['rw','tz'],
      ['bi','tz'],
      ['tz','mz'],['tz','mw'],['tz','zm'],
      ['ao','zm'],['ao','na'],
      ['zm','mw'],['zm','mz'],['zm','zw'],['zm','bw'],['zm','na'],
      ['mw','mz'],
      ['mz','zw'],['mz','za'],['mz','sz'],
      ['zw','bw'],['zw','za'],
      ['bw','za'],['bw','na'],
      ['na','za'],
      ['za','sz'],['za','ls'],
    ]
  },

  'north-america': {
    file: 'four-color-north-america.html',
    svgW: 800, svgH: 900,
    lonMin: -130, lonMax: -55, latMin: 7, latMax: 55,
    title: 'Four Color North America',
    storagePrefix: 'fourColorNorthAmerica',
    successMsg: 'You colored all of North America!',
    countries: [
      { id: 'ca', name: 'Canada' },
      { id: 'us', name: 'United States' },
      { id: 'mx', name: 'Mexico' },
      { id: 'gt', name: 'Guatemala' },
      { id: 'bz', name: 'Belize' },
      { id: 'sv', name: 'El Salvador' },
      { id: 'hn', name: 'Honduras' },
      { id: 'ni', name: 'Nicaragua' },
      { id: 'cr', name: 'Costa Rica' },
      { id: 'pa', name: 'Panama' },
      { id: 'cu', name: 'Cuba' },
      { id: 'jm', name: 'Jamaica' },
      { id: 'ht', name: 'Haiti' },
      { id: 'do', name: 'Dominican Republic' },
      { id: 'bs', name: 'Bahamas' },
    ],
    adjacency: [
      ['ca','us'],
      ['us','mx'],
      ['mx','gt'],['mx','bz'],
      ['gt','bz'],['gt','sv'],['gt','hn'],
      ['sv','hn'],
      ['hn','ni'],
      ['ni','cr'],
      ['cr','pa'],
      ['ht','do'],
    ]
  },

  'south-america': {
    file: 'four-color-south-america.html',
    svgW: 600, svgH: 800,
    lonMin: -82, lonMax: -34, latMin: -56, latMax: 13,
    title: 'Four Color South America',
    storagePrefix: 'fourColorSouthAmerica',
    successMsg: 'You colored all of South America!',
    countries: [
      { id: 'br', name: 'Brazil' },
      { id: 'ar', name: 'Argentina' },
      { id: 'co', name: 'Colombia' },
      { id: 'pe', name: 'Peru' },
      { id: 've', name: 'Venezuela' },
      { id: 'cl', name: 'Chile' },
      { id: 'ec', name: 'Ecuador' },
      { id: 'bo', name: 'Bolivia' },
      { id: 'py', name: 'Paraguay' },
      { id: 'uy', name: 'Uruguay' },
      { id: 'gy', name: 'Guyana' },
      { id: 'sr', name: 'Suriname' },
    ],
    adjacency: [
      ['br','ar'],['br','uy'],['br','py'],['br','bo'],['br','pe'],['br','co'],['br','ve'],['br','gy'],['br','sr'],
      ['ar','cl'],['ar','bo'],['ar','py'],['ar','uy'],
      ['co','ve'],['co','pe'],['co','ec'],
      ['pe','ec'],['pe','bo'],['pe','cl'],
      ['ve','gy'],
      ['cl','bo'],
      ['bo','py'],
      ['gy','sr'],
    ]
  }
};

// ===== Build data for each continent =====

function buildContinentData(continent) {
  const proj = createProjection(
    continent.lonMin, continent.lonMax,
    continent.latMin, continent.latMax,
    continent.svgW, continent.svgH
  );

  // Geographic bounds for filtering polygon parts (e.g., France's overseas territories)
  const lonBounds = {
    lonMin: continent.lonMin - 15,
    lonMax: continent.lonMax + 15,
    latMin: continent.latMin - 15,
    latMax: continent.latMax + 15
  };

  const countryData = [];

  for (const country of continent.countries) {
    const feature = featuresByCode[country.id];
    if (!feature) {
      console.warn(`  WARNING: No feature found for ${country.id} (${country.name})`);
      continue;
    }

    const pathD = geometryToPath(feature.geometry, proj, lonBounds);
    if (!pathD) {
      console.warn(`  WARNING: Empty path for ${country.id} (${country.name})`);
      continue;
    }

    countryData.push({
      id: country.id,
      name: country.name,
      path: pathD
    });
  }

  return countryData;
}

// ===== Generate HTML =====

for (const [continentKey, continent] of Object.entries(continents)) {
  console.log(`\nProcessing ${continent.title}...`);

  const countryData = buildContinentData(continent);
  console.log(`  Generated ${countryData.length} countries`);

  const countriesStr = countryData.map(c =>
    `    {id:'${c.id}',name:'${c.name}',path:'${c.path.replace(/'/g, "\\'")}'}`
  ).join(',\n');

  // Deduplicate adjacency and filter to existing countries
  const adjSet = new Set();
  const adjPairs = [];
  for (const pair of continent.adjacency) {
    const key = [pair[0], pair[1]].sort().join('-');
    if (!adjSet.has(key)) {
      adjSet.add(key);
      if (countryData.find(c => c.id === pair[0]) && countryData.find(c => c.id === pair[1])) {
        adjPairs.push(pair);
      }
    }
  }

  const adjacencyStr = adjPairs.map(p => `['${p[0]}','${p[1]}']`).join(',');
  const viewBox = `0 0 ${continent.svgW} ${continent.svgH}`;
  const baseVB = `{ x: 0, y: 0, w: ${continent.svgW}, h: ${continent.svgH} }`;

  // Precompute border midpoints for all adjacency pairs
  const parsedPaths = {};
  const countryIndexLookup = {};
  countryData.forEach((c, i) => {
    parsedPaths[c.id] = parsePath(c.path);
    countryIndexLookup[c.id] = i;
  });

  const midpointEntries = [];
  for (const pair of adjPairs) {
    const idxA = countryIndexLookup[pair[0]];
    const idxB = countryIndexLookup[pair[1]];
    const key = Math.min(idxA, idxB) + '-' + Math.max(idxA, idxB);
    const mid = computeBorderMidpointFromPaths(parsedPaths[pair[0]], parsedPaths[pair[1]]);
    midpointEntries.push(`'${key}':{x:${Math.round(mid.x * 10) / 10},y:${Math.round(mid.y * 10) / 10}}`);
  }
  const midpointCacheStr = midpointEntries.join(',');
  console.log(`  Precomputed ${midpointEntries.length} border midpoints`);

  const html = generateHTML(continent, viewBox, countriesStr, adjacencyStr, baseVB, countryData.length, midpointCacheStr);
  const htmlPath = path.join(__dirname, 'activities', continent.file);
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`  Wrote ${htmlPath}`);
}

function generateHTML(continent, viewBox, countriesStr, adjacencyStr, baseVB, totalCountries, midpointCacheStr) {
  const vbParts = viewBox.split(' ');
  const aspectRatio = `${vbParts[2]} / ${vbParts[3]}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${continent.title} - Mr. Matt Math Club</title>
  <link rel="stylesheet" href="../styles.css">
  <style>
    .game-card { background: white; border-radius: 16px; padding: 2rem 1.5rem; box-shadow: 0 4px 16px rgba(0,0,0,0.08); text-align: center; max-width: 900px; margin: 0 auto; }
    .instruction { font-size: 1.1rem; color: #64748b; margin-bottom: 1rem; }
    .puzzle-row { display: flex; justify-content: center; align-items: center; gap: 1rem; margin-bottom: 1rem; }
    .puzzle-container { flex: 1 1 auto; min-width: 0; }
    #puzzle-svg { width: 100%; aspect-ratio: ${aspectRatio}; display: block; border-radius: 12px; background: #dbeafe; border: 2px solid #e2e8f0; touch-action: none; user-select: none; -webkit-user-select: none; }
    #puzzle-svg path[data-index]:hover { filter: brightness(0.90); }
    .zoom-controls { display: flex; gap: 0.4rem; justify-content: center; margin-top: 0.5rem; }
    .zoom-btn { width: 40px; height: 40px; border-radius: 10px; border: 2px solid #e2e8f0; background: #f8fafc; color: #475569; font-size: 1.25rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s, transform 0.15s; padding: 0; line-height: 1; }
    .zoom-btn:hover { background: #e2e8f0; transform: translateY(-1px); }
    .zoom-btn:active { transform: translateY(0); }
    .palette { display: flex; flex-direction: column; gap: 0.75rem; flex-shrink: 0; }
    .swatch { width: 48px; height: 48px; border-radius: 50%; border: 3px solid transparent; cursor: pointer; transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s; box-shadow: 0 2px 6px rgba(0,0,0,0.15); padding: 0; outline: none; display: flex; align-items: center; justify-content: center; }
    .swatch:hover { transform: scale(1.1); }
    .swatch.selected { border-color: #1e293b; transform: scale(1.15); box-shadow: 0 3px 10px rgba(0,0,0,0.25); }
    .swatch.eraser { background: #f1f5f9 !important; border: 3px dashed #94a3b8; }
    .swatch.eraser.selected { border-color: #1e293b; border-style: solid; }
    .progress-counter { font-size: 1rem; color: #64748b; margin-bottom: 0.75rem; }
    .progress-counter .count { font-weight: 700; color: #7c3aed; }
    .btn-start-over { border: 2px solid #e2e8f0; border-radius: 12px; padding: 0.6rem 1.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; background: #f8fafc; color: #64748b; transition: transform 0.15s, box-shadow 0.15s, background 0.15s; }
    .btn-start-over:hover { background: #e2e8f0; transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,0.1); }
    .status { display: none; margin-top: 1rem; }
    .status.visible { display: block; }
    .success-msg { color: #059669; font-size: 1.4rem; font-weight: 700; animation: popIn 0.35s ease; margin-bottom: 0.5rem; }
    .btn { border: none; border-radius: 12px; padding: 0.85rem 2rem; font-size: 1.1rem; font-weight: 600; cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; color: white; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,0.15); }
    .btn:active { transform: translateY(0); }
    .btn-again { background: linear-gradient(135deg, #7c3aed, #4c6ef5); margin-top: 0.5rem; }
    @keyframes popIn { 0% { opacity: 0; transform: scale(0.8); } 100% { opacity: 1; transform: scale(1); } }
    .conflict-x line { stroke: #1e293b; stroke-linecap: round; }
    .celebration { pointer-events: none; position: absolute; inset: 0; overflow: hidden; }
    .confetti { position: absolute; width: 10px; height: 10px; border-radius: 2px; opacity: 0; }
    @keyframes confettiFall { 0% { opacity: 1; transform: translateY(0) rotate(0deg); } 100% { opacity: 0; transform: translateY(120px) rotate(360deg); } }
    .game-wrapper { position: relative; }
    .state-tooltip { position: fixed; background: #1e293b; color: white; padding: 0.3rem 0.75rem; border-radius: 8px; font-size: 0.85rem; pointer-events: none; opacity: 0; transition: opacity 0.15s; z-index: 10; white-space: nowrap; }
    .state-tooltip.visible { opacity: 1; }
    .back-row { max-width: 900px; }
  </style>
</head>
<body>
  <header><h1>Mr. Matt Math Club</h1></header>
  <main>
    <div class="back-row">
      <a href="../index.html" class="back-btn" aria-label="Back to Activities"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10H5M5 10l5-5M5 10l5 5"/></svg></a>
    </div>
    <div class="game-wrapper">
      <div class="game-card">
        <h2 class="activity-title">${continent.title}</h2>
        <p class="instruction">Color every country &mdash; no matching neighbors!</p>
        <div class="puzzle-row">
          <div class="puzzle-container">
            <svg id="puzzle-svg" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg"></svg>
            <div class="zoom-controls">
              <button class="zoom-btn" id="zoom-in-btn" aria-label="Zoom in">+</button>
              <button class="zoom-btn" id="zoom-out-btn" aria-label="Zoom out">&minus;</button>
              <button class="zoom-btn" id="zoom-reset-btn" aria-label="Reset zoom" style="font-size:1rem;">&#8962;</button>
            </div>
          </div>
          <div class="palette" id="palette"></div>
        </div>
        <p class="progress-counter">
          <span class="count" id="colored-count">0</span> / <span id="total-count">${totalCountries}</span> countries colored
        </p>
        <button class="btn-start-over" onclick="startOver()">Start Over</button>
        <div class="status" id="status"></div>
      </div>
      <div class="celebration" id="celebration"></div>
    </div>
    <div class="state-tooltip" id="state-tooltip"></div>
  </main>
<script src="../js/four-color-engine.js"></script>
<script>
  var COLORS = FourColorEngine.COLORS;
  var REGION_DEFAULT = FourColorEngine.REGION_DEFAULT;
  var REGION_STROKE = FourColorEngine.REGION_STROKE;

  var COUNTRIES = [
${countriesStr}
  ];

  var ADJACENCY = [${adjacencyStr}];

  var paletteState = { selectedColorIndex: 0, selectedEraser: false };
  var regionColors = new Array(COUNTRIES.length).fill(null);
  var solved = false;
  var borderMidpointCache = {${midpointCacheStr}};

  var countryIndex = {};
  COUNTRIES.forEach(function(c, i) { countryIndex[c.id] = i; });

  var adjacency = ADJACENCY.map(function(pair) {
    return [countryIndex[pair[0]], countryIndex[pair[1]]];
  });

  var svgEl = document.getElementById('puzzle-svg');
  var paletteEl = document.getElementById('palette');
  var statusEl = document.getElementById('status');
  var celebrationEl = document.getElementById('celebration');
  var tooltipEl = document.getElementById('state-tooltip');
  var countEl = document.getElementById('colored-count');

  var BASE_VB = ${baseVB};
  var vb = { x: BASE_VB.x, y: BASE_VB.y, w: BASE_VB.w, h: BASE_VB.h };
  var MIN_ZOOM = 1;
  var MAX_ZOOM = 5;
  var TAP_THRESHOLD = 8;

  function currentZoom() { return BASE_VB.w / vb.w; }

  function clampViewBox() {
    if (vb.w > BASE_VB.w) vb.w = BASE_VB.w;
    if (vb.h > BASE_VB.h) vb.h = BASE_VB.h;
    if (vb.w < BASE_VB.w / MAX_ZOOM) vb.w = BASE_VB.w / MAX_ZOOM;
    if (vb.h < BASE_VB.h / MAX_ZOOM) vb.h = BASE_VB.h / MAX_ZOOM;
    vb.h = vb.w * (BASE_VB.h / BASE_VB.w);
    if (vb.x < BASE_VB.x) vb.x = BASE_VB.x;
    if (vb.y < BASE_VB.y) vb.y = BASE_VB.y;
    if (vb.x + vb.w > BASE_VB.x + BASE_VB.w) vb.x = BASE_VB.x + BASE_VB.w - vb.w;
    if (vb.y + vb.h > BASE_VB.y + BASE_VB.h) vb.y = BASE_VB.y + BASE_VB.h - vb.h;
  }

  function applyViewBox() {
    svgEl.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
    FourColorEngine.drawConflictMarkers(svgEl, adjacency, regionColors, borderMidpointCache, { zoom: currentZoom() });
  }

  function clientToSVG(clientX, clientY) {
    var rect = svgEl.getBoundingClientRect();
    var sx = (clientX - rect.left) / rect.width;
    var sy = (clientY - rect.top) / rect.height;
    return { x: vb.x + sx * vb.w, y: vb.y + sy * vb.h };
  }

  function zoomAt(cx, cy, factor) {
    var minW = BASE_VB.w / MAX_ZOOM;
    if (factor > 1 && vb.w <= minW) return;
    if (factor < 1 && vb.w >= BASE_VB.w) return;
    var newW = vb.w / factor;
    var newH = vb.h / factor;
    vb.x = cx - (cx - vb.x) * (newW / vb.w);
    vb.y = cy - (cy - vb.y) * (newH / vb.h);
    vb.w = newW;
    vb.h = newH;
    clampViewBox();
    applyViewBox();
  }

  function resetZoom() {
    vb.x = BASE_VB.x; vb.y = BASE_VB.y;
    vb.w = BASE_VB.w; vb.h = BASE_VB.h;
    applyViewBox();
  }

  function initMap() {
    svgEl.innerHTML = '';
    COUNTRIES.forEach(function(country, i) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', country.path);
      path.setAttribute('fill', REGION_DEFAULT);
      path.setAttribute('stroke', REGION_STROKE);
      path.setAttribute('stroke-width', '1');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('data-index', i);
      path.style.cursor = 'pointer';
      path.style.transition = 'fill 0.15s';
      svgEl.appendChild(path);
    });
  }

  (function setupPanZoom() {
    var pointers = {};
    var isPanning = false;
    var startPt = null;
    var startVB = null;
    var startTarget = null;
    var startDist = null;
    var startVBW = null;
    var pinchCenter = null;

    function pointerCount() { return Object.keys(pointers).length; }

    function getPinchDistance() {
      var keys = Object.keys(pointers);
      if (keys.length < 2) return null;
      var a = pointers[keys[0]], b = pointers[keys[1]];
      var dx = a.x - b.x, dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getPinchCenter() {
      var keys = Object.keys(pointers);
      var a = pointers[keys[0]], b = pointers[keys[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    svgEl.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      svgEl.setPointerCapture(e.pointerId);
      if (pointerCount() === 1) {
        isPanning = false;
        startPt = { x: e.clientX, y: e.clientY };
        startVB = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
        startTarget = e.target;
      }
      if (pointerCount() === 2) {
        isPanning = true;
        startDist = getPinchDistance();
        startVBW = vb.w;
        var cc = getPinchCenter();
        pinchCenter = clientToSVG(cc.x, cc.y);
      }
    });

    svgEl.addEventListener('pointermove', function(e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pointerCount() === 2 && startDist) {
        var dist = getPinchDistance();
        if (dist && startDist) {
          var factor = dist / startDist;
          var newW = startVBW / factor;
          var minW = BASE_VB.w / MAX_ZOOM;
          if (newW < minW) newW = minW;
          if (newW > BASE_VB.w) newW = BASE_VB.w;
          var newH = newW * (BASE_VB.h / BASE_VB.w);
          vb.w = newW; vb.h = newH;
          vb.x = pinchCenter.x - (pinchCenter.x - startVB.x) * (newW / startVB.w);
          vb.y = pinchCenter.y - (pinchCenter.y - startVB.y) * (newH / startVB.h);
          clampViewBox(); applyViewBox();
        }
        return;
      }
      if (pointerCount() === 1 && startPt) {
        var dx = e.clientX - startPt.x;
        var dy = e.clientY - startPt.y;
        var dist2 = Math.sqrt(dx * dx + dy * dy);
        if (!isPanning && dist2 > TAP_THRESHOLD) isPanning = true;
        if (isPanning) {
          var rect = svgEl.getBoundingClientRect();
          var scaleX = vb.w / rect.width;
          var scaleY = vb.h / rect.height;
          vb.x = startVB.x - dx * scaleX;
          vb.y = startVB.y - dy * scaleY;
          clampViewBox(); applyViewBox();
        }
      }
    });

    function onPointerEnd(e) {
      if (!pointers[e.pointerId]) return;
      if (pointerCount() === 1 && !isPanning && startTarget) {
        var target = startTarget;
        if (target.tagName === 'path' && target.hasAttribute('data-index')) {
          paintRegion(parseInt(target.getAttribute('data-index')));
        }
      }
      delete pointers[e.pointerId];
      if (pointerCount() === 0) {
        isPanning = false; startPt = null; startVB = null; startTarget = null;
        startDist = null; startVBW = null; pinchCenter = null;
      } else if (pointerCount() === 1) {
        startDist = null; startVBW = null; pinchCenter = null;
        var keys = Object.keys(pointers);
        startPt = { x: pointers[keys[0]].x, y: pointers[keys[0]].y };
        startVB = { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
        isPanning = true;
      }
    }

    svgEl.addEventListener('pointerup', onPointerEnd);
    svgEl.addEventListener('pointercancel', onPointerEnd);

    svgEl.addEventListener('wheel', function(e) {
      e.preventDefault();
      var pt = clientToSVG(e.clientX, e.clientY);
      var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(pt.x, pt.y, factor);
    }, { passive: false });
  })();

  document.getElementById('zoom-in-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    var cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    zoomAt(cx, cy, 1.4);
  });
  document.getElementById('zoom-out-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    var cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    zoomAt(cx, cy, 1 / 1.4);
  });
  document.getElementById('zoom-reset-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    resetZoom();
  });

  function renderPalette() {
    FourColorEngine.renderPalette(paletteEl, 4, paletteState, { enableEraser: true });
  }

  function paintRegion(index) {
    if (solved) return;
    var paths = svgEl.querySelectorAll('path[data-index]');
    if (paletteState.selectedEraser) {
      regionColors[index] = null;
      paths[index].setAttribute('fill', REGION_DEFAULT);
    } else {
      regionColors[index] = paletteState.selectedColorIndex;
      paths[index].setAttribute('fill', COLORS[paletteState.selectedColorIndex]);
    }
    FourColorEngine.drawConflictMarkers(svgEl, adjacency, regionColors, borderMidpointCache, { zoom: currentZoom() });
    saveState();
    updateCounter();
    if (!paletteState.selectedEraser) checkCompletion();
  }

  function updateCounter() {
    var colored = regionColors.filter(function(c) { return c !== null; }).length;
    countEl.textContent = colored;
  }

  function checkCompletion() {
    if (!regionColors.every(function(c) { return c !== null; })) return;
    var valid = true;
    for (var e = 0; e < adjacency.length; e++) {
      if (regionColors[adjacency[e][0]] === regionColors[adjacency[e][1]]) {
        valid = false; break;
      }
    }
    if (valid) {
      solved = true;
      localStorage.setItem('${continent.storagePrefix}_completed', 'true');
      FourColorEngine.showConfetti(celebrationEl);
      statusEl.innerHTML =
        '<p class="success-msg">\\u{1F389} ${continent.successMsg}</p>' +
        '<button class="btn btn-again" onclick="startOver()">Play Again</button>';
      statusEl.classList.add('visible');
    }
  }

  function saveState() {
    var save = {};
    COUNTRIES.forEach(function(c, i) {
      if (regionColors[i] !== null) save[c.id] = regionColors[i];
    });
    localStorage.setItem('${continent.storagePrefix}_stateColors', JSON.stringify(save));
  }

  function loadState() {
    try {
      var saved = JSON.parse(localStorage.getItem('${continent.storagePrefix}_stateColors'));
      if (!saved || typeof saved !== 'object') return;
      var paths = svgEl.querySelectorAll('path[data-index]');
      COUNTRIES.forEach(function(c, i) {
        if (saved[c.id] !== undefined && saved[c.id] !== null) {
          regionColors[i] = saved[c.id];
          paths[i].setAttribute('fill', COLORS[saved[c.id]]);
        }
      });
      FourColorEngine.drawConflictMarkers(svgEl, adjacency, regionColors, borderMidpointCache, { zoom: currentZoom() });
      updateCounter();
      if (localStorage.getItem('${continent.storagePrefix}_completed') === 'true') solved = true;
    } catch(e) {}
  }

  function startOver() {
    regionColors = new Array(COUNTRIES.length).fill(null);
    solved = false;
    paletteState.selectedColorIndex = 0;
    paletteState.selectedEraser = false;
    var paths = svgEl.querySelectorAll('path[data-index]');
    paths.forEach(function(p) { p.setAttribute('fill', REGION_DEFAULT); });
    var markers = svgEl.querySelector('#conflict-markers');
    if (markers) markers.remove();
    localStorage.removeItem('${continent.storagePrefix}_stateColors');
    localStorage.removeItem('${continent.storagePrefix}_completed');
    resetZoom();
    renderPalette();
    updateCounter();
    statusEl.classList.remove('visible');
    statusEl.innerHTML = '';
  }

  svgEl.addEventListener('mousemove', function(e) {
    if (e.buttons) { tooltipEl.classList.remove('visible'); return; }
    var target = e.target;
    if (target.tagName === 'path' && target.hasAttribute('data-index')) {
      var idx = parseInt(target.getAttribute('data-index'));
      tooltipEl.textContent = COUNTRIES[idx].name;
      tooltipEl.classList.add('visible');
      tooltipEl.style.left = (e.clientX + 12) + 'px';
      tooltipEl.style.top = (e.clientY - 30) + 'px';
    } else {
      tooltipEl.classList.remove('visible');
    }
  });

  svgEl.addEventListener('mouseleave', function() {
    tooltipEl.classList.remove('visible');
  });

  initMap();
  renderPalette();
  loadState();
</script>
</body>
</html>`;
}

console.log('\nDone! All continent HTML files have been regenerated.');
console.log('Source data: Natural Earth 50m (public domain)');
