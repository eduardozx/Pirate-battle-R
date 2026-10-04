/**
 * Starling `TextureAtlas` (XML) descriptor parser.
 *
 * The challenge ships the ship/effect art as a Starling atlas:
 *   <TextureAtlas imagePath="...">
 *     <SubTexture name="ship_6.png" x="408" y="0" width="66" height="113"/>
 *   </TextureAtlas>
 *
 * Parsed with a regular expression rather than `DOMParser`. That is a deliberate
 * trade: `DOMParser` exists only in a browser, which would force this module to be
 * untestable in Node and unusable from a build script. The format is a flat list
 * of self-closing elements with numeric attributes, so a strict scan is both
 * sufficient and more predictable than an XML parser here.
 */

export interface AtlasFrame {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const SUB_TEXTURE = /<SubTexture\b([^>]*)\/?>/g;
const ATTRIBUTE = /(\w+)\s*=\s*"([^"]*)"/g;

const readAttributes = (source: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) attributes.set(name, value);
  }
  return attributes;
};

export function parseStarlingAtlasXml(xml: string): Map<string, AtlasFrame> {
  const frames = new Map<string, AtlasFrame>();

  for (const match of xml.matchAll(SUB_TEXTURE)) {
    const attributes = readAttributes(match[1] ?? '');

    const name = attributes.get('name');
    if (name === undefined) continue;

    const x = Number(attributes.get('x'));
    const y = Number(attributes.get('y'));
    const width = Number(attributes.get('width'));
    const height = Number(attributes.get('height'));

    // Skip malformed entries rather than failing the whole atlas: one bad frame
    // should not prevent the other hundred from loading.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (width <= 0 || height <= 0) continue;

    frames.set(name, { name, x, y, width, height });
  }

  if (frames.size === 0) {
    throw new Error('Atlas XML contained no usable <SubTexture> entries');
  }

  return frames;
}
