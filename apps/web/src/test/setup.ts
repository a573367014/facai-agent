import "@testing-library/jest-dom/vitest";

if (typeof document !== "undefined" && !document.elementFromPoint) {
  document.elementFromPoint = () => document.body;
}

if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.getClientRects) {
  HTMLElement.prototype.getClientRects = function getClientRects() {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
}

if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({})
  });
}
