import { describe, it, expect } from "vitest";
import { SUBSECTORS, summary } from "../src/taxonomy";

describe("RDI taxonomy", () => {
	it("flattens to 44 sunrise sub-sectors across 5 sectors, 46 total", () => {
		console.log(summary());
		expect(summary()).toBe("44 sunrise sub-sectors across 5 sectors, 46 total");
	});

	it("has unique sub-sector ids", () => {
		const ids = SUBSECTORS.map((e) => e.subsector_id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
