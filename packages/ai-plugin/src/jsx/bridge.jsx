/**
 * bridge.jsx — Illustrator ExtendScript for the Bridge CEP plugin.
 *
 * ─── How this file is loaded ────────────────────────────────────────────────
 * CEP auto-evaluates the file specified by <ScriptPath> in manifest.xml
 * when the extension panel first opens.  Every function defined at the top
 * level becomes callable from the panel's JavaScript via:
 *
 *   cs.evalScript('functionName(arg)', callback);
 *
 * All arguments and return values travel as strings (JSON-encode before
 * passing, JSON-parse after receiving).
 *
 * ─── Public entry points ────────────────────────────────────────────────────
 *
 *   bridge_render(docJsonStr)
 *       Receives a BridgeDocument (JSON string) produced by Figma and renders
 *       it into the active Illustrator document (or creates one if none is
 *       open).  Returns: JSON string { ok, count, error? }
 *
 *   bridge_readSelection()
 *       Reads the current Illustrator selection and serialises it as a
 *       BridgeDocument so the panel can push it to Figma.
 *       Returns: JSON string { ok, document?, error? }
 *
 * ─── Coordinate system ──────────────────────────────────────────────────────
 * Bridge IR uses Figma-style coordinates:
 *   • Origin at top-left of the document.
 *   • Y increases downward (screen convention).
 *   • Anchor handles stored as ABSOLUTE positions in the same space as the
 *     anchor point (NOT as deltas from it).  This matches Illustrator's own
 *     pathPoint.leftDirection / rightDirection convention exactly — so we can
 *     assign them directly after negating Y.
 *
 * Illustrator's ExtendScript uses Y-up coordinates (origin at artboard
 * top-left in modern docs, artRect[1] = 0, artRect[3] = -height).
 * Conversion:
 *   aiX = figmaX
 *   aiY = -figmaY           (negate Y to flip the axis)
 *
 * For pathItems.rectangle(top, left, width, height):
 *   top  = -figmaY          (y coordinate of the TOP edge in AI Y-up space)
 *   left = figmaX
 */

#target illustrator

// ── JSON polyfill (Illustrator 24+ ships JSON; guard for older hosts) ─────────

if (typeof JSON === 'undefined') {
  // Minimal JSON.parse using eval (safe here — input is always our own data).
  // JSON.stringify is used only for return values.
  JSON = {
    parse: function (s) { return eval('(' + s + ')'); },
    stringify: function (v) {
      var t = typeof v;
      if (v === null || v === undefined) return 'null';
      if (t === 'boolean' || t === 'number') return String(v);
      if (t === 'string') {
        return '"' + v
          .replace(/\\/g, '\\\\')
          .replace(/"/g,  '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t') + '"';
      }
      if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(JSON.stringify(v[i]));
        return '[' + a.join(',') + ']';
      }
      if (t === 'object') {
        var p = [];
        for (var k in v) {
          if (v.hasOwnProperty(k)) p.push(JSON.stringify(k) + ':' + JSON.stringify(v[k]));
        }
        return '{' + p.join(',') + '}';
      }
      return 'undefined';
    }
  };
}

// ── Utility: shallow-copy extra properties onto base object ─────────────────

function extend(base, extra) {
  for (var k in extra) {
    if (extra.hasOwnProperty(k)) base[k] = extra[k];
  }
  return base;
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY POINTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Render a BridgeDocument in Illustrator.
 * @param {string} docJsonStr  JSON-stringified BridgeDocument
 * @returns {string} JSON  { ok: boolean, count: number, error?: string }
 */
function bridge_render(docJsonStr) {
  try {
    var doc = JSON.parse(docJsonStr);
    var result = renderBridgeDocument(doc);
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ ok: false, count: 0, error: String(e) });
  }
}

/**
 * Read the active Illustrator selection and return it as a BridgeDocument.
 * @returns {string} JSON  { ok: boolean, document?: BridgeDocument, error?: string }
 */
function bridge_readSelection() {
  try {
    var bridgeDoc = selectionToDocument();
    return JSON.stringify({ ok: true, document: bridgeDoc });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e) });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// INBOUND: Figma → Illustrator rendering
// ═════════════════════════════════════════════════════════════════════════════

function renderBridgeDocument(bridgeDoc) {
  var aiDoc;
  if (app.documents.length === 0) {
    var w = 800, h = 600;
    if (bridgeDoc.documentBounds && bridgeDoc.documentBounds.size) {
      w = bridgeDoc.documentBounds.size.width  || w;
      h = bridgeDoc.documentBounds.size.height || h;
    }
    aiDoc = app.documents.add(DocumentColorSpace.RGB, w, h);
  } else {
    aiDoc = app.activeDocument;
  }

  // Cache artboard top-left origin for coordinate conversion.
  // artboardRect = [left, top, right, bottom] in AI Y-up units.
  // In a default modern Illustrator doc: [0, 0, width, -height].
  var artRect = aiDoc.artboards[0].artboardRect;
  var artOriginX = artRect[0]; // left edge of artboard (usually 0)
  var artOriginY = artRect[1]; // top  edge of artboard (usually 0)

  var count      = 0;
  var containers = bridgeDoc.containers || [];
  for (var i = 0; i < containers.length; i++) {
    count += renderContainer(aiDoc, containers[i], artOriginX, artOriginY);
  }

  app.redraw();
  return { ok: true, count: count };
}

function renderContainer(aiDoc, container, artX, artY) {
  var layer = findOrCreateLayer(aiDoc, container.name || 'Bridge');
  var origin = container.documentPosition || { x: 0, y: 0 };
  var count  = 0;
  var children = container.children || [];

  for (var i = 0; i < children.length; i++) {
    var node = children[i];
    if (node.visible === false) continue;
    try {
      renderNode(layer, node, origin, artX, artY);
      count++;
    } catch (e) {
      // skip bad node, continue with the rest
    }
  }
  return count;
}

function findOrCreateLayer(aiDoc, name) {
  var layers = aiDoc.layers;
  for (var i = 0; i < layers.length; i++) {
    try { if (layers[i].name === name) return layers[i]; } catch (e) {}
  }
  var layer = layers.add();
  layer.name = name;
  return layer;
}

// ── Node dispatch ────────────────────────────────────────────────────────────

function renderNode(layer, node, containerOrigin, artX, artY) {
  var absX = (containerOrigin.x || 0) + ((node.position && node.position.x) || 0);
  var absY = (containerOrigin.y || 0) + ((node.position && node.position.y) || 0);
  var w    = (node.size && node.size.width)  || 0;
  var h    = (node.size && node.size.height) || 0;

  // Convert from Figma space to Illustrator space.
  // figmaX → aiLeft:  aiLeft = artX + figmaX   (artX is usually 0)
  // figmaY → aiTop:   aiTop  = artY - figmaY    (artY is usually 0, so aiTop = -figmaY)
  var aiLeft = artX + absX;
  var aiTop  = artY - absY;

  switch (node.type) {
    case 'text':     renderTextNode(layer, node, aiLeft, aiTop, w, h); break;
    case 'vector':   renderVectorNode(layer, node, absX, absY, aiLeft, aiTop, w, h, artX, artY); break;
    case 'image':    renderImageNode(layer, node, aiLeft, aiTop, w, h); break;
    case 'group':    renderGroupNode(layer, node, { x: absX, y: absY }, artX, artY); break;
    case 'instance': renderGroupNode(layer, node, { x: absX, y: absY }, artX, artY); break;
    // default: ignore unknown types
  }
}

// ── Text rendering ───────────────────────────────────────────────────────────

function renderTextNode(layer, node, aiLeft, aiTop, w, h) {
  var tf;

  if (w > 0 && h > 0) {
    // Area text: create a bounding-box path, then attach text to it.
    // pathItems.rectangle(top, left, width, height)
    var bndPath = layer.pathItems.rectangle(aiTop, aiLeft, w, h);
    bndPath.filled  = false;
    bndPath.stroked = false;
    tf = layer.textFrames.areaText(bndPath);
  } else {
    // Point text
    tf = layer.textFrames.add();
    tf.position = [aiLeft, aiTop];
  }

  // Text content (Bridge IR stores the raw string in .characters)
  tf.contents = node.characters || node.name || '';

  // Apply paragraph / run styles
  applyTextStyles(tf, node);

  if (typeof node.opacity === 'number') tf.opacity = node.opacity * 100;
  return tf;
}

function applyTextStyles(tf, node) {
  var paras = node.paragraphs || [];
  if (!paras.length) return;

  for (var p = 0; p < paras.length; p++) {
    var para = paras[p];
    var runs = para.runs || [];

    // Character-level styling
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      try {
        var chars = tf.textRange.characters;
        for (var ci = run.start; ci < run.end && ci < chars.length; ci++) {
          var ca = chars[ci].characterAttributes;

          if (run.fontSize)      ca.size     = run.fontSize;
          if (run.letterSpacing) ca.tracking = run.letterSpacing;

          // Font lookup: try PostScript name first, then family name
          var fontName = run.postScriptName || run.fontFamily;
          if (fontName) {
            try { ca.textFont = app.textFonts.getByName(fontName); } catch (fe) {}
          }

          // Fill colour from run
          if (run.fills && run.fills.length) {
            var fc = paintToRgbColor(run.fills[0]);
            if (fc) ca.fillColor = fc;
          }
        }
      } catch (e) { /* style error — skip */ }
    }

    // Paragraph-level alignment
    try {
      var paraObj = tf.paragraphs[p];
      if (paraObj) {
        var j = para.alignH;
        if      (j === 'left')    paraObj.paragraphAttributes.justification = Justification.LEFT;
        else if (j === 'center')  paraObj.paragraphAttributes.justification = Justification.CENTER;
        else if (j === 'right')   paraObj.paragraphAttributes.justification = Justification.RIGHT;
        else if (j === 'justify') paraObj.paragraphAttributes.justification = Justification.FULLJUSTIFY;
      }
    } catch (e) {}
  }
}

// ── Vector rendering ─────────────────────────────────────────────────────────

function renderVectorNode(layer, node, absX, absY, aiLeft, aiTop, w, h, artX, artY) {
  var subpaths = node.subpaths || [];
  var item;

  if (!subpaths.length) {
    // No path data — fall back to a rectangle from the bounding box
    item = layer.pathItems.rectangle(aiTop, aiLeft, w, h);
  } else if (subpaths.length === 1) {
    item = layer.pathItems.add();
    buildPathFromSubpath(item, subpaths[0], absX, absY, artX, artY);
  } else {
    // Multiple subpaths → CompoundPathItem (handles holes / even-odd fills)
    var cp = layer.compoundPathItems.add();
    for (var s = 0; s < subpaths.length; s++) {
      var sub = cp.pathItems.add();
      buildPathFromSubpath(sub, subpaths[s], absX, absY, artX, artY);
    }
    try { cp.evenodd = (node.fillRule === 'evenodd'); } catch (e) {}
    item = cp;
  }

  applyFills(item, node.fills);
  applyStrokes(item, node.strokes);
  if (typeof node.opacity === 'number') item.opacity = node.opacity * 100;
  return item;
}

/**
 * Populate an empty PathItem from a Bridge IR Subpath.
 *
 * Anchor handles in the IR are ABSOLUTE positions in Figma space
 * (same coordinate space as anchor.point, not delta offsets).
 * They map directly to Illustrator's leftDirection / rightDirection
 * after the Y-axis flip.
 *
 * The node's absolute Figma position (absX, absY) is the offset of the
 * node's local origin within the document.  Subpath anchors are in the
 * node's local coordinate space (0,0 = node top-left), so we add the
 * node offset before converting to AI space.
 */
function buildPathFromSubpath(pathItem, subpath, absX, absY, artX, artY) {
  var anchors = subpath.anchors || [];

  // Clear the default path point that Illustrator adds to new PathItems
  pathItem.setEntirePath([]);

  for (var i = 0; i < anchors.length; i++) {
    var a  = anchors[i];
    var pp = pathItem.pathPoints.add();

    // Figma absolute = nodeOffset + localPoint
    // AI X =  artX + figmaAbsX
    // AI Y =  artY - figmaAbsY  (negate Y to flip axis)
    pp.anchor         = [ artX + absX + a.point.x,    artY - (absY + a.point.y)    ];
    pp.leftDirection  = [ artX + absX + a.handleIn.x,  artY - (absY + a.handleIn.y)  ];
    pp.rightDirection = [ artX + absX + a.handleOut.x, artY - (absY + a.handleOut.y) ];
    pp.pointType      = (a.type === 'smooth') ? PointType.SMOOTH : PointType.CORNER;
  }

  pathItem.closed = !!subpath.closed;
}

// ── Image rendering ──────────────────────────────────────────────────────────

function renderImageNode(layer, node, aiLeft, aiTop, w, h) {
  // Images require downloading bytes from the companion and writing a temp
  // file, which is complex.  For now, render a labelled grey rectangle as a
  // placeholder.  The `note` property stores the asset hash so the
  // placeholder can be replaced by a future update pass.
  var rect  = layer.pathItems.rectangle(aiTop, aiLeft, w, h);
  var gray  = new GrayColor();
  gray.gray = 80; // 80 % grey
  rect.fillColor = gray;
  rect.stroked   = false;
  rect.note      = 'bridge:image:' + ((node.image && node.image.hash) || 'unknown');
  if (typeof node.opacity === 'number') rect.opacity = node.opacity * 100;
  return rect;
}

// ── Group / Instance rendering ───────────────────────────────────────────────

function renderGroupNode(layer, node, origin, artX, artY) {
  var children = node.children || [];
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child.visible === false) continue;
    try { renderNode(layer, child, origin, artX, artY); } catch (e) {}
  }
}

// ── Fill / stroke helpers ────────────────────────────────────────────────────

function paintToRgbColor(paint) {
  if (!paint || paint.type !== 'solid' || !paint.color) return null;
  var c   = paint.color;
  var rgb = new RGBColor();
  rgb.red   = Math.round((c.r || 0) * 255);
  rgb.green = Math.round((c.g || 0) * 255);
  rgb.blue  = Math.round((c.b || 0) * 255);
  return rgb;
}

function applyFills(item, fills) {
  if (!fills || !fills.length) { item.filled = false; return; }
  var paint = fills[0];
  if (!paint.visible) { item.filled = false; return; }
  var color = paintToRgbColor(paint);
  if (color) {
    item.fillColor = color;
    item.filled    = true;
    var alpha = (typeof paint.opacity === 'number') ? paint.opacity : 1;
    item.opacity   = alpha * 100;
  } else {
    item.filled = false;
  }
}

function applyStrokes(item, strokes) {
  if (!strokes || !strokes.length) { item.stroked = false; return; }
  var stroke = strokes[0];
  if (!stroke.paint) { item.stroked = false; return; }
  var color = paintToRgbColor(stroke.paint);
  if (color) {
    item.strokeColor = color;
    item.stroked     = true;
    item.strokeWidth = stroke.weight || 1;
  } else {
    item.stroked = false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// OUTBOUND: Illustrator → Figma (selection reading)
// ═════════════════════════════════════════════════════════════════════════════

function selectionToDocument() {
  if (app.documents.length === 0)
    throw new Error('No document open in Illustrator.');

  var aiDoc     = app.activeDocument;
  var selection = aiDoc.selection;

  if (!selection || !selection.length)
    throw new Error('Nothing selected in Illustrator.');

  // Cache artboard geometry for coordinate conversion
  var artRect = aiDoc.artboards[0].artboardRect;
  var artX    = artRect[0]; // left  (usually 0)
  var artY    = artRect[1]; // top   (usually 0 in modern docs)

  var nodes = [];
  for (var i = 0; i < selection.length; i++) {
    var node = itemToNode(selection[i], artX, artY);
    if (node) nodes.push(node);
  }

  var now = new Date();
  return {
    schemaVersion: '0.6.0',
    sourceApp: 'illustrator',
    documentBounds: {
      position: { x: 0, y: 0 },
      size: { width: aiDoc.width, height: aiDoc.height }
    },
    containers: [{
      id:               'selection-' + now.getTime(),
      kind:             'pasteboard',
      name:             'Selection',
      documentPosition: { x: 0, y: 0 },
      size:             { width: aiDoc.width, height: aiDoc.height },
      background:       null,
      clipsContent:     false,
      children:         nodes,
      sourceMeta:       { sourceType: 'illustrator-selection' }
    }],
    library:    { components: {}, colorStyles: {}, textStyles: {} },
    assets:     { images: {} },
    generatedAt: now.toISOString()
  };
}

// ── Item → IR node dispatch ──────────────────────────────────────────────────

function itemToNode(item, artX, artY) {
  try {
    switch (item.typename) {
      case 'TextFrame':        return textFrameToNode(item, artX, artY);
      case 'PathItem':         return pathItemToNode(item, artX, artY);
      case 'CompoundPathItem': return compoundPathToNode(item, artX, artY);
      case 'GroupItem':        return groupItemToNode(item, artX, artY);
    }
  } catch (e) {}
  return null;
}

// ── Bounding-box helper ──────────────────────────────────────────────────────

/**
 * Returns the item's bounds in Figma space (origin TL, Y-down).
 * geometricBounds = [left, top, right, bottom] in AI Y-up units.
 * Conversion: figmaX = aiX - artX,  figmaY = artY - aiY (negate)
 */
function getItemFigmaBounds(item, artX, artY) {
  var b = item.geometricBounds; // [left, top, right, bottom]
  return {
    x: b[0] - artX,
    y: artY - b[1],            // artY - aiTop  (flip Y)
    width:  Math.abs(b[2] - b[0]),
    height: Math.abs(b[1] - b[3])
  };
}

function nodeBaseFromItem(item, artX, artY) {
  var bounds = getItemFigmaBounds(item, artX, artY);
  return {
    id:       item.uuid || (item.typename + '-' + Math.floor(Math.random() * 1e9)),
    name:     item.name || item.typename,
    visible:  !item.hidden,
    locked:   item.locked,
    opacity:  (typeof item.opacity === 'number') ? (item.opacity / 100) : 1,
    position: { x: bounds.x, y: bounds.y },
    size:     { width: bounds.width, height: bounds.height },
    rotation: 0,
    effects:  []
  };
}

// ── Text frame → IR ──────────────────────────────────────────────────────────

function textFrameToNode(item, artX, artY) {
  var base   = nodeBaseFromItem(item, artX, artY);
  var chars  = item.contents || '';
  var fontSize = 12;
  var fontName = 'Helvetica';
  var fontFamily = 'Helvetica';
  var fillPaint  = null;

  try {
    var ca = item.textRange.characterAttributes;
    fontSize = ca.size || 12;
    var tf = ca.textFont;
    if (tf) { fontName = tf.name; fontFamily = tf.family || tf.name; }
    var fc = ca.fillColor;
    if (fc && fc.typename === 'RGBColor') {
      fillPaint = {
        type: 'solid', opacity: 1, visible: true,
        color: { r: fc.red / 255, g: fc.green / 255, b: fc.blue / 255, a: 1 }
      };
    }
  } catch (e) {}

  var run = {
    start: 0, end: chars.length,
    fontFamily:    fontFamily,
    postScriptName: fontName,
    fontWeight:    400,
    fontStyle:     'normal',
    fontSize:      fontSize,
    letterSpacing: 0,
    fills:         fillPaint ? [fillPaint] : []
  };

  return extend(base, {
    type:       'text',
    characters: chars,
    paragraphs: [{
      start: 0, end: chars.length,
      alignH:     'left',
      lineHeight: 1.2,
      runs:       [run]
    }],
    alignV:     'top',
    autoResize: 'none',
    fills:      [],
    strokes:    []
  });
}

// ── Path item → IR ───────────────────────────────────────────────────────────

function pathItemToNode(item, artX, artY) {
  var base = nodeBaseFromItem(item, artX, artY);
  return extend(base, {
    type:     'vector',
    subpaths: buildSubpathsFromItem(item, artX, artY),
    fills:    aiItemToFills(item),
    strokes:  aiItemToStrokes(item),
    fillRule: item.evenodd ? 'evenodd' : 'nonzero'
  });
}

function compoundPathToNode(item, artX, artY) {
  var base     = nodeBaseFromItem(item, artX, artY);
  var subpaths = [];
  for (var i = 0; i < item.pathItems.length; i++) {
    var subs = buildSubpathsFromItem(item.pathItems[i], artX, artY);
    for (var j = 0; j < subs.length; j++) subpaths.push(subs[j]);
  }
  return extend(base, {
    type:     'vector',
    subpaths: subpaths,
    fills:    aiItemToFills(item),
    strokes:  aiItemToStrokes(item),
    fillRule: item.evenodd ? 'evenodd' : 'nonzero'
  });
}

/**
 * Convert Illustrator path points to Bridge Subpath.
 * Handles are ABSOLUTE in the same space as the anchor — Illustrator
 * stores them the same way, so we just flip Y.
 */
function buildSubpathsFromItem(pathItem, artX, artY) {
  var anchors = [];
  var pts     = pathItem.pathPoints;
  for (var i = 0; i < pts.length; i++) {
    var pp = pts[i];
    // AI Y-up → Figma Y-down:  figmaY = artY - aiY
    anchors.push({
      point:    { x: pp.anchor[0] - artX,        y: artY - pp.anchor[1] },
      handleIn: { x: pp.leftDirection[0] - artX,  y: artY - pp.leftDirection[1] },
      handleOut:{ x: pp.rightDirection[0] - artX, y: artY - pp.rightDirection[1] },
      type:     (pp.pointType === PointType.SMOOTH) ? 'smooth' : 'corner'
    });
  }
  return [{ closed: pathItem.closed, anchors: anchors }];
}

// ── Group item → IR ──────────────────────────────────────────────────────────

function groupItemToNode(item, artX, artY) {
  var base   = nodeBaseFromItem(item, artX, artY);
  var origin = { x: base.position.x, y: base.position.y };
  var children = [];
  for (var i = 0; i < item.pageItems.length; i++) {
    var child = itemToNode(item.pageItems[i], artX, artY);
    if (child) {
      // Make children's positions relative to the group's top-left
      child.position = {
        x: child.position.x - origin.x,
        y: child.position.y - origin.y
      };
      children.push(child);
    }
  }
  return extend(base, {
    type:     'group',
    children: children,
    fills:    [],
    strokes:  [],
    effects:  []
  });
}

// ── AI colour → Bridge paint ─────────────────────────────────────────────────

function aiItemToFills(item) {
  if (!item.filled) return [];
  var c = item.fillColor;
  if (!c) return [];
  var rgb = null;
  if (c.typename === 'RGBColor') {
    rgb = { r: c.red / 255, g: c.green / 255, b: c.blue / 255, a: 1 };
  } else if (c.typename === 'GrayColor') {
    var v = (100 - c.gray) / 100;
    rgb = { r: v, g: v, b: v, a: 1 };
  }
  if (!rgb) return [];
  return [{ type: 'solid', opacity: (item.opacity || 100) / 100, visible: true, color: rgb }];
}

function aiItemToStrokes(item) {
  if (!item.stroked) return [];
  var c = item.strokeColor;
  if (!c || c.typename !== 'RGBColor') return [];
  return [{
    paint:  { type: 'solid', opacity: 1, visible: true,
              color: { r: c.red / 255, g: c.green / 255, b: c.blue / 255, a: 1 } },
    weight: item.strokeWidth || 1,
    align:  'center',
    cap:    'none',
    join:   'miter'
  }];
}
