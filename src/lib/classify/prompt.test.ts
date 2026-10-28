import { describe, expect, it } from "vitest";
import { classificationPromptHash, classificationSystemPrompt, classificationUserContent } from "./prompt";
import { classificationJsonSchema } from "./schema";
import type { ClassificationInput, ClassificationVocabulary, ThumbnailImage } from "./types";
import { CLASSIFICATION_VOCABULARY } from "./vocabulary";

const headings: [keyof ClassificationVocabulary, string][] = [
  ["families", "Families:"],
  ["templates", "Templates:"],
  ["rewardLoops", "Reward loops:"],
];

// The lines between a heading and the next blank line.
function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  return prompt.slice(start + heading.length + 2).split("\n\n")[0];
}

function game(values: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    universeId: 10765298801,
    name: "+1 Stone Skipping",
    description: "Skip stones across the lake.",
    genre: "Simulation",
    thumbnailUrl: "https://tr.rbxcdn.com/thumbnail.png",
    robloxCreatedAt: "2026-10-01T00:00:00.000Z",
    peakCcu: 160_000,
    stratum: "plus-one",
    ...values,
  };
}

function text(input: ClassificationInput, image: ThumbnailImage | null = null): string {
  const block = classificationUserContent(input, image).at(-1);
  expect(block?.type).toBe("text");
  return block?.type === "text" ? block.text : "";
}

describe("classificationSystemPrompt", () => {
  const prompt = classificationSystemPrompt();

  it.each(headings)("names every %s value in backticks, under its heading", (list, heading) => {
    const lines = section(prompt, heading);
    for (const entry of CLASSIFICATION_VOCABULARY[list]) expect(lines).toContain(`- \`${entry.value}\`: `);
  });

  it("renders an entry with its meaning and its quoted examples", () => {
    const entry = { value: "obby", meaning: "An obstacle course.", examples: ["Tower of Hell", "Obby But You're a Bike"] };
    const vocabulary = { families: [entry], templates: [], rewardLoops: [] };
    expect(section(classificationSystemPrompt(vocabulary), "Families:")).toBe(
      '- `obby`: An obstacle course. Examples: "Tower of Hell", "Obby But You\'re a Bike".',
    );
  });

  // Batch requests share the system prompt as a cached prefix, which only hits when it is byte-identical.
  it("is identical across calls", () => {
    expect(classificationSystemPrompt()).toBe(prompt);
  });
});

describe("classificationUserContent", () => {
  const image: ThumbnailImage = { mediaType: "image/jpeg", data: "/9j/4AAQ" };

  it("puts the thumbnail before the text", () => {
    expect(classificationUserContent(game(), image)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
      {
        type: "text",
        text: "Title: +1 Stone Skipping\nRoblox genre: Simulation\nDescription: Skip stones across the lake.",
      },
    ]);
  });

  it("says when there is no thumbnail", () => {
    expect(classificationUserContent(game(), null)).toEqual([
      {
        type: "text",
        text: "Thumbnail: none\nTitle: +1 Stone Skipping\nRoblox genre: Simulation\nDescription: Skip stones across the lake.",
      },
    ]);
  });

  it("cuts a long description at the configured length", () => {
    const description = "a".repeat(1_000) + "b".repeat(500);
    expect(text(game({ description }), image).split("\n").at(-1)).toBe(
      `Description (first 1000 characters): ${"a".repeat(1_000)}…`,
    );
  });

  // A UTF-16 cut can split an emoji into a lone surrogate, which the API rejects as invalid JSON.
  it("does not split an emoji at the cut", () => {
    const description = "a".repeat(999) + "🎃" + "b".repeat(10);
    expect(text(game({ description }), image).split("\n").at(-1)).toBe(
      `Description (first 1000 characters): ${"a".repeat(999)}🎃…`,
    );
  });

  it("reads an empty description as empty", () => {
    expect(text(game({ description: "  \n " }), image).split("\n").at(-1)).toBe("Description: (empty)");
  });

  it("reads a missing genre as none", () => {
    expect(text(game({ genre: null }), image)).toContain("\nRoblox genre: none\n");
  });
});

describe("classificationPromptHash", () => {
  it("is a hex SHA-256 of the system prompt and the output schema", () => {
    expect(classificationPromptHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(classificationPromptHash()).toBe(classificationPromptHash(classificationSystemPrompt(), classificationJsonSchema));
  });

  it("changes with the system prompt or the output schema", () => {
    const hash = classificationPromptHash();
    expect(classificationPromptHash(`${classificationSystemPrompt()} `)).not.toBe(hash);
    expect(classificationPromptHash(classificationSystemPrompt(), { ...classificationJsonSchema, title: "x" })).not.toBe(hash);
  });
});
