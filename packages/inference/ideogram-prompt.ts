import { InferenceError } from "./types.ts";

export const IDEOGRAM_PROMPT_LIMIT = 16_000;
export const IDEOGRAM_ELEMENT_LIMIT = 128;
export type IdeogramElement = {
  type: "obj" | "text";
  bbox?: [number, number, number, number];
  text?: string;
  desc: string;
  color_palette?: string[];
};
export interface IdeogramCaption {
  high_level_description?: string;
  style_description?: {
    aesthetics: string;
    lighting: string;
    photo?: string;
    medium: string;
    art_style?: string;
    color_palette?: string[];
  };
  compositional_deconstruction: { background: string; elements: IdeogramElement[] };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InferenceError("INVALID_INPUT", `Invalid Ideogram caption: ${message}`);
}

function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "expected an object.");
  const record = value as Record<string, unknown>;
  check(Object.keys(record).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(record, key)), "unknown or missing fields.");
  return record;
}

function string(value: unknown): string {
  check(typeof value === "string" && value.length <= IDEOGRAM_PROMPT_LIMIT && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), "description and text fields must be bounded strings without control characters.");
  return value;
}

function palette(value: unknown, maximum: number): string[] {
  check(Array.isArray(value) && value.length <= maximum && value.every(color => typeof color === "string" && /^#[0-9A-F]{6}$/.test(color)), `color palettes require at most ${maximum} uppercase #RRGGBB colors.`);
  return [...value];
}

function bbox(value: unknown): [number, number, number, number] {
  check(Array.isArray(value) && value.length === 4 && value.every(coordinate => Number.isInteger(coordinate) && coordinate >= 0 && coordinate <= 1000), "bbox must contain four integers from 0 to 1000.");
  const [top, left, bottom, right] = value;
  check(top < bottom && left < right, "bbox must be ordered [y_min,x_min,y_max,x_max] with positive area.");
  return [top, left, bottom, right];
}

/** JSON.parse validates grammar; this scan additionally rejects ambiguous duplicate keys. */
function parseJson(text: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new InferenceError("INVALID_INPUT", "Invalid Ideogram caption: enter a valid JSON object."); }
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === "{" || value === "[") {
      stack.push(value === "{" ? new Set() : null);
      check(stack.length <= 6, "JSON nesting is too deep.");
    } else if (value === "}" || value === "]") stack.pop();
    else if (/^\s*:/.test(text.slice(token.index + value.length))) {
      const keys = stack.at(-1);
      const key = JSON.parse(value) as string;
      check(keys && !keys.has(key), "duplicate fields are not allowed.");
      keys.add(key);
    }
  }
  return parsed;
}

/**
 * Normalize the publisher's caption schema without modifying user string values.
 * https://github.com/ideogram-oss/ideogram4/blob/main/src/ideogram4/caption_verifier.py
 * Studio additionally bounds prompt length, nesting and element count.
 * Returns null for ordinary prose; JSON-looking invalid input is never wrapped as prose.
 */
export function parseIdeogramPrompt(prompt: string): IdeogramCaption | null {
  check(typeof prompt === "string" && prompt.trim().length > 0 && prompt.length <= IDEOGRAM_PROMPT_LIMIT, "use 1–16,000 characters.");
  if (!/^\s*(?:\{|\[|```)/.test(prompt)) return null;
  const root = object(parseJson(prompt), ["high_level_description", "style_description", "compositional_deconstruction"], ["compositional_deconstruction"]);
  const result = {} as IdeogramCaption;
  if (Object.hasOwn(root, "high_level_description")) result.high_level_description = string(root.high_level_description);
  if (Object.hasOwn(root, "style_description")) {
    const style = object(root.style_description, ["aesthetics", "lighting", "photo", "medium", "art_style", "color_palette"], ["aesthetics", "lighting", "medium"]);
    const photo = Object.hasOwn(style, "photo"), art = Object.hasOwn(style, "art_style");
    check(photo !== art, "style requires exactly one of photo or art_style.");
    const medium = string(style.medium);
    check(photo === (medium === "photograph"), "photograph medium requires photo style; other media require art_style.");
    result.style_description = {
      aesthetics: string(style.aesthetics), lighting: string(style.lighting),
      ...(photo ? { photo: string(style.photo) } : {}), medium,
      ...(art ? { art_style: string(style.art_style) } : {}),
      ...(Object.hasOwn(style, "color_palette") ? { color_palette: palette(style.color_palette, 16) } : {}),
    };
  }
  const composition = object(root.compositional_deconstruction, ["background", "elements"], ["background", "elements"]);
  check(Array.isArray(composition.elements) && composition.elements.length <= IDEOGRAM_ELEMENT_LIMIT, `use at most ${IDEOGRAM_ELEMENT_LIMIT} elements.`);
  result.compositional_deconstruction = {
    background: string(composition.background),
    elements: composition.elements.map(value => {
      const element = object(value, ["type", "bbox", "text", "desc", "color_palette"], ["type", "desc"]);
      check(element.type === "obj" || element.type === "text", "element type must be obj or text.");
      check(Object.hasOwn(element, "text") === (element.type === "text"), "only text elements require a text field.");
      return {
        type: element.type,
        ...(Object.hasOwn(element, "bbox") ? { bbox: bbox(element.bbox) } : {}),
        ...(element.type === "text" ? { text: string(element.text) } : {}),
        desc: string(element.desc),
        ...(Object.hasOwn(element, "color_palette") ? { color_palette: palette(element.color_palette, 5) } : {}),
      };
    }),
  };
  check(JSON.stringify(result).length <= IDEOGRAM_PROMPT_LIMIT, "normalized caption exceeds 16,000 characters.");
  return result;
}

/** Native captions pass directly to the encoder; prose retains the minimal fallback. */
export function compileIdeogramPrompt(prompt: string): string {
  return JSON.stringify(parseIdeogramPrompt(prompt) ?? {
    high_level_description: prompt,
    compositional_deconstruction: { background: "", elements: [] },
  });
}
