// UI zoom bridge: 界面字号 scales the whole body via CSS zoom, which puts
// mouse event coordinates (viewport px) and element layout coordinates into
// DIFFERENT spaces. Anything that positions an element from clientX/Y must
// convert through these helpers.

// Current body zoom factor (1 = no scaling).
export function uiZoom(): number {
  const z = Number(document.body.style.zoom || 1);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// Mouse clientX/Y are viewport pixels; elements inside the zoomed body are
// positioned in layout pixels. Convert before using them for positioning.
export function clientToLayout(v: number): number {
  return v / uiZoom();
}

// The zoomed body's viewport extent in layout pixels (for viewport clamping).
export function viewportW(): number {
  return window.innerWidth / uiZoom();
}

export function viewportH(): number {
  return window.innerHeight / uiZoom();
}
