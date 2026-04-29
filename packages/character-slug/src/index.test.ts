import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugifyCharacterName } from "./index.ts";

describe("slugifyCharacterName", () => {
  it("lowercases and hyphenates spaces", () => {
    assert.equal(slugifyCharacterName("Sir Cuddles"), "sir-cuddles")
  })
  it("removes apostrophes", () => {
    assert.equal(slugifyCharacterName("Bobby Table's"), "bobby-tables")
  })
});
