// Normalized scene geometry and text fitting are shared by the monitor and MP4 renderer.
export function defaultComposition(layout = 'center') {
  const media={x:0,y:0,width:1,height:layout==='split'?.5:1};
  if (layout==='lower-third') return {media,title:{x:.08,y:.65,width:.84,height:.10},body:{x:.08,y:.76,width:.84,height:.16}};
  if (layout==='split') return {media,title:{x:.08,y:.56,width:.84,height:.12},body:{x:.08,y:.70,width:.84,height:.22}};
  return {media,title:{x:.08,y:.32,width:.84,height:.16},body:{x:.08,y:.50,width:.84,height:.26}};
}

export function editRectangle(box, patch) {
  const next={...box};
  for (const key of ['x','y','width','height']) if (Number.isFinite(patch[key])) next[key]=patch[key];
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  next.x=clamp(next.x,0,1-.02); next.y=clamp(next.y,0,1-.02);
  next.width=clamp(next.width,.02,1); next.height=clamp(next.height,.02,1);
  if ('width' in patch) next.width=Math.min(next.width,1-next.x);
  else next.x=Math.min(next.x,1-next.width);
  if ('height' in patch) next.height=Math.min(next.height,1-next.y);
  else next.y=Math.min(next.y,1-next.height);
  const rounded=Object.fromEntries(Object.entries(next).map(([key,value])=>[key,Math.round(value*1e6)/1e6]));
  const safeSize=(position,size)=>{
    if (position+size<=1) return size;
    const adjusted=Math.floor((1-position)*1e6)/1e6;
    return position+adjusted<=1 ? adjusted : Math.max(.02,adjusted-1e-6);
  };
  rounded.width=safeSize(rounded.x,rounded.width);
  rounded.height=safeSize(rounded.y,rounded.height);
  return rounded;
}

export function applyCompositionDrag(scene, drag, dx, dy, onChange) {
  if (!scene || scene.id !== drag.sceneId || !['media','title','body'].includes(drag.key)) return null;
  scene.composition ||= defaultComposition(scene.layout);
  const patch = {};
  if (!drag.handle) { patch.x=drag.start.x+dx; patch.y=drag.start.y+dy; }
  else {
    if (drag.handle.includes('e')) patch.width=drag.start.width+dx;
    if (drag.handle.includes('s')) patch.height=drag.start.height+dy;
    if (drag.handle.includes('w')) { patch.x=drag.start.x+dx; patch.width=drag.start.width-dx; }
    if (drag.handle.includes('n')) { patch.y=drag.start.y+dy; patch.height=drag.start.height-dy; }
  }
  const next=editRectangle(drag.start,patch);
  const changed=['x','y','width','height'].some(key=>next[key]!==scene.composition[drag.key][key]);
  drag.moved ||= changed;
  scene.composition[drag.key]=next;
  if (changed) onChange?.();
  return scene.composition[drag.key];
}

export function finalizeCompositionDrag(drag, onDirty) {
  if (!drag?.moved) return false;
  onDirty?.();
  return true;
}

export function nudgeCompositionLayer(scene, layer, patch, onUpdate) {
  if (!scene || !['media','title','body'].includes(layer)) return null;
  scene.composition ||= defaultComposition(scene.layout);
  scene.composition[layer]=editRectangle(scene.composition[layer],patch);
  onUpdate?.(layer);
  return scene.composition[layer];
}

const compositionInputKeys = new Set(['x','y','width','height']);
const displayPercent = value => String(Number((value*100).toFixed(1)));

export function updateCompositionInput(scene, layer, key, value, fields=[], activeField=null) {
  if (!scene || !['media','title','body'].includes(layer) || !compositionInputKeys.has(key) || value === '' || !Number.isFinite(Number(value))) return false;
  scene.composition ||= defaultComposition(scene.layout);
  scene.composition[layer]=editRectangle(scene.composition[layer],{[key]:Number(value)/100});
  for (const field of fields) {
    if (field === activeField) continue;
    const fieldKey=field.dataset.compositionField;
    if (compositionInputKeys.has(fieldKey)) field.value=displayPercent(scene.composition[layer][fieldKey]);
  }
  return true;
}

export function syncCompositionInputs(scene, layer, fields=[]) {
  if (!scene || !['media','title','body'].includes(layer)) return;
  scene.composition ||= defaultComposition(scene.layout);
  for (const field of fields) {
    const key=field.dataset.compositionField;
    if (compositionInputKeys.has(key)) field.value=displayPercent(scene.composition[layer][key]);
  }
}

export function previewFontSize(fit, canvasWidth) {
  const size=fit.fontSize/canvasWidth*100;
  // Conversion must not enlarge a fitted glyph; retain tiny positive sizes below this precision.
  const rounded=Math.floor(size*1e12)/1e12;
  return `${rounded>0?Math.min(size,rounded):size}cqw`;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function fitText(value,box,canvasWidth,canvasHeight,layer='body') {
  // Keep graphemes intact, but allow a cell to contain multiple spacing glyphs.
  // Preserve user copy; ASS serialization belongs to the export boundary.
  const cleaned=String(value || '').replace(/\r\n?/g,'\n');
  const width=box.width*canvasWidth,height=box.height*canvasHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError('Invalid text box');
  const paragraphs=cleaned.split('\n').map(line=>Array.from(graphemes.segment(line), item=>item.segment));
  let cellAdvance=1;
  for (const paragraph of paragraphs) for (const cluster of paragraph) {
    // Compatibility normalization is for budgeting only; the literal cluster is preserved.
    // Only known zero-advance controls are free; Cf also includes visible Arabic signs.
    // Account for spacing Jamo, emoji and wide fallback glyphs.
    let advance=0;
    for (const point of cluster.normalize('NFKC')) {
      if (/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFE00-\uFE0F\uFEFF\u{E0100}-\u{E01EF}]/u.test(point)) continue;
      const codePoint=point.codePointAt(0);
      // Tamil/Sinhala fallback signs can exceed two em; round their advances upward.
      // Per-mille and peseta signs exceed one em; U+FDFD may expand to a fallback phrase.
      // Combining marks can render as visible fallback glyphs with their own ink bounds.
      advance+=/[\u0BF5\u0BF8]/u.test(point)?3:/[\p{Mn}\p{Me}\p{Extended_Pictographic}\p{Cf}\u2030\u2031\u20A7\u0DF4]/u.test(point)?2:codePoint===0xFDFD?8:codePoint===0x2E3A?2:codePoint===0x2E3B?3:1;
    }
    cellAdvance=Math.max(cellAdvance,advance);
  }
  const cellSize=width/cellAdvance;
  const minimum=Math.min(1,cellSize,height/1.2);
  const maximum=Math.max(minimum,Math.floor(Math.min(Number.MAX_SAFE_INTEGER,cellSize,height*.34,canvasWidth*(layer==='title'?.057:.044))));
  const wrap=size=>paragraphs.flatMap(chars=>{
    const rows=[],columns=Math.max(1,Math.floor(width/(size*cellAdvance)));
    for (let i=0;i<chars.length;i+=columns) rows.push(chars.slice(i,i+columns).join(''));
    return rows.length?rows:[''];
  });
  let fontSize=minimum,lines=wrap(minimum);
  // Integer binary search bounds work by canvas size, rather than reducing one pixel at a time.
  let low=1,high=Math.floor(maximum);
  while (low<=high) {
    const candidate=low+Math.floor((high-low)/2),wrapped=wrap(candidate);
    if (wrapped.length*(candidate*1.2)<=height) { fontSize=candidate;lines=wrapped;low=candidate+1; }
    else high=candidate-1;
  }
  if (lines.length*(fontSize*1.2)>height) {
    // Keep every wrapped row when integers cannot fit; leave room for rounding.
    fontSize=Math.min(fontSize,height/lines.length/1.2)*(1-1e-12);
    lines=wrap(fontSize);
  }
  const lineHeight=fontSize*1.2;
  return {text:lines.join('\n'),fontSize,lineHeight};
}
