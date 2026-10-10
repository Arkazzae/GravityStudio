import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIdeogramPrompt, IDEOGRAM_ELEMENT_LIMIT, IDEOGRAM_PROMPT_LIMIT, parseIdeogramPrompt } from "../../packages/inference/ideogram-prompt.ts";
import { InferenceError } from "../../packages/inference/types.ts";

function caption() {
  return {
    high_level_description: "A café poster with a cup and a headline.",
    style_description: { aesthetics: "restrained", lighting: "", medium: "graphic_design", art_style: "flat illustration", color_palette: ["#FFFFFF", "#112233"] },
    compositional_deconstruction: {
      background: "White paper",
      elements: [
        { type: "obj", bbox: [200, 100, 900, 700], desc: "A blue cup", color_palette: ["#112233"] },
        { type: "text", bbox: [0, 100, 200, 900], text: 'Żółć 🌒\n東京 "Café"', desc: "Headline above the cup" },
      ],
    },
  };
}

function rejected(value: unknown): void {
  assert.throws(() => parseIdeogramPrompt(typeof value === "string" ? value : JSON.stringify(value)), { code: "INVALID_INPUT" });
}

test("native captions normalize schema key order without wrapping or changing literal text", () => {
  const original = caption();
  const reversed = {
    compositional_deconstruction: {
      elements: original.compositional_deconstruction.elements.map(element => Object.fromEntries(Object.entries(element).reverse())),
      background: original.compositional_deconstruction.background,
    },
    style_description: Object.fromEntries(Object.entries(original.style_description).reverse()),
    high_level_description: original.high_level_description,
  };
  const result = parseIdeogramPrompt(JSON.stringify(reversed))!;
  assert.deepEqual(result, original);
  assert.deepEqual(Object.keys(result), ["high_level_description", "style_description", "compositional_deconstruction"]);
  assert.deepEqual(Object.keys(result.style_description!), ["aesthetics", "lighting", "medium", "art_style", "color_palette"]);
  assert.deepEqual(Object.keys(result.compositional_deconstruction), ["background", "elements"]);
  assert.deepEqual(Object.keys(result.compositional_deconstruction.elements[0]), ["type", "bbox", "desc", "color_palette"]);
  assert.deepEqual(Object.keys(result.compositional_deconstruction.elements[1]), ["type", "bbox", "text", "desc"]);
  const compiled = compileIdeogramPrompt(JSON.stringify(reversed, null, 2));
  assert.equal(compiled, JSON.stringify(original));
  assert(compiled.includes("Żółć 🌒"));
  assert(!compiled.includes("\\u017b"));
  assert.equal(compileIdeogramPrompt(compiled), compiled);
});

test("photo style has its distinct order and optional high-level and style fields stay optional", () => {
  const source = { compositional_deconstruction: { elements: [], background: "" }, style_description: { medium: "photograph", photo: "35mm", lighting: "daylight", aesthetics: "natural" } };
  const result = parseIdeogramPrompt(JSON.stringify(source))!;
  assert.deepEqual(Object.keys(result.style_description!), ["aesthetics", "lighting", "photo", "medium"]);
  assert.equal(Object.hasOwn(result, "high_level_description"), false);
  assert.equal(compileIdeogramPrompt('{"compositional_deconstruction":{"elements":[],"background":""}}'), '{"compositional_deconstruction":{"background":"","elements":[]}}');
});

test("ordinary prompts preserve the existing minimal caption, including quotes and whitespace", () => {
  const prompt = '\nA poster saying "Café" next to <image1>.\n';
  assert.equal(parseIdeogramPrompt(prompt), null);
  assert.deepEqual(JSON.parse(compileIdeogramPrompt(prompt)), { high_level_description: prompt, compositional_deconstruction: { background: "", elements: [] } });
  assert.equal(parseIdeogramPrompt("A symbol {inside braces} on a sign"), null);
});

test("JSON-looking invalid captions cannot silently become plain descriptions", () => {
  for (const value of ["{", "[]", "[{\"high_level_description\":\"A cup\"}]", "```json\n{}\n```", {}, { high_level_description: "A cup" },
    { compositional_deconstruction: null }, { compositional_deconstruction: { background: "" } },
    { compositional_deconstruction: { background: 1, elements: [] } }, { compositional_deconstruction: { background: "", elements: {} } },
    { ...caption(), aspect_ratio: "1:1" }, { ...caption(), high_level_description: [] },
  ]) rejected(value);
  rejected('{"compositional_deconstruction":{"background":"","elements":[]},"__proto__":{"polluted":true}}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("duplicate fields are rejected at every depth, including escaped field names", () => {
  for (const value of [
    '{"high_level_description":"first","high_level_description":"second","compositional_deconstruction":{"background":"","elements":[]}}',
    '{"compositional_deconstruction":{"background":"first","back\\u0067round":"second","elements":[]}}',
    '{"compositional_deconstruction":{"background":"","elements":[{"type":"obj","desc":"first","desc":"second"}]}}',
  ]) rejected(value);
  const source = caption();
  source.compositional_deconstruction.background = 'The words "desc": and braces { [ ] } are literal description text.';
  assert.equal(parseIdeogramPrompt(JSON.stringify(source))!.compositional_deconstruction.background, source.compositional_deconstruction.background);
});

test("style and element discriminators reject unknown, missing and incorrectly typed fields", () => {
  const base = caption();
  for (const style of [null, {}, { ...base.style_description, photo: "wide angle" }, { aesthetics: "", lighting: "", medium: "illustration" },
    { ...base.style_description, aesthetics: 4 }, { ...base.style_description, medium: "photograph" },
    { aesthetics: "", lighting: "", photo: "", medium: "illustration" }, { ...base.style_description, lens: "35mm" },
  ]) rejected({ ...base, style_description: style });
  for (const element of [null, {}, { type: "object", desc: "A cup" }, { type: "obj" }, { type: "text", desc: "Title" },
    { type: "obj", desc: "A cup", text: "CUP" }, { type: "text", text: 1, desc: "Title" },
    { type: "obj", desc: [] }, { type: "obj", desc: "A cup", position: "center" },
  ]) rejected({ ...base, compositional_deconstruction: { background: "", elements: [element] } });
  rejected({ ...base, compositional_deconstruction: { ...base.compositional_deconstruction, unknown: true } });
});

test("bounding boxes require positive area and ordered integer coordinates in the native 0–1000 range", () => {
  for (const box of [null, [], [0, 0, 1], [0, 0, 1000, 1000, 1000], [-1, 0, 100, 100], [0, 0, 1001, 100],
    [0, 0, 1.5, 100], [0, false, 100, 100], [200, 0, 100, 100], [0, 200, 100, 100], [0, 0, 0, 100], [0, 0, 100, 0],
  ]) rejected({ compositional_deconstruction: { background: "", elements: [{ type: "obj", bbox: box, desc: "A cup" }] } });
  assert.deepEqual(parseIdeogramPrompt('{"compositional_deconstruction":{"background":"","elements":[{"type":"obj","bbox":[0,0,1000,1000],"desc":"A cup"}]}}')!.compositional_deconstruction.elements[0].bbox, [0, 0, 1000, 1000]);
});

test("palette validation uses uppercase full hex colors and the separate style and element limits", () => {
  for (const palette of [null, "#FFFFFF", ["#fff"], ["#abcdef"], ["#GGFFFF"], ["FFFFFF"], [123], Array(17).fill("#FFFFFF")]) {
    const source = caption();
    rejected({ ...source, style_description: { ...source.style_description, color_palette: palette } });
  }
  rejected({ compositional_deconstruction: { background: "", elements: [{ type: "obj", desc: "A cup", color_palette: Array(6).fill("#FFFFFF") }] } });
  const source = caption();
  source.style_description.color_palette = Array(16).fill("#FFFFFF");
  source.compositional_deconstruction.elements[0].color_palette = Array(5).fill("#000000");
  assert.doesNotThrow(() => parseIdeogramPrompt(JSON.stringify(source)));
});

test("bounded parsing rejects oversized or deeply nested input without exposing its contents", () => {
  for (const prompt of ["", " \n", "a".repeat(IDEOGRAM_PROMPT_LIMIT + 1), '{"x":' + "[".repeat(100) + "0" + "]".repeat(100) + "}"]) rejected(prompt);
  rejected({ compositional_deconstruction: { background: "", elements: Array.from({ length: IDEOGRAM_ELEMENT_LIMIT + 1 }, () => ({ type: "obj", desc: "A cup" })) } });
  const source = caption();
  source.compositional_deconstruction.background = "PRIVATE_CONTENT\u0000";
  assert.throws(() => parseIdeogramPrompt(JSON.stringify(source)), error => {
    assert(error instanceof InferenceError);
    assert(!error.message.includes("PRIVATE_CONTENT"));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(parseIdeogramPrompt("a".repeat(IDEOGRAM_PROMPT_LIMIT)), null);
});
