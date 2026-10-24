import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageDirective, withLanguage, localizedPrompt, languageSource } from "../src/agent/language.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseGeneralSettingsBody } from "../src/server/settings-body.ts";

describe("output language", () => {
	it("defaults to French and resolves explicit choices", () => {
		assert.equal(FACTORY_SETTINGS.general.language, "fr");
		assert.equal(resolveSettings(null).general.language, "fr");
		const rec = sanitizeUserSettings({ version: 1, general: { language: "en" } })!;
		assert.equal(resolveSettings(rec).general.language, "en");
	});

	it("French survives settings validation and is appended for every teaching role", () => {
		const stored = sanitizeUserSettings({ version: 1, general: { language: "fr" } })!;
		assert.equal(resolveSettings(stored).general.language, "fr");
		assert.deepEqual(parseGeneralSettingsBody({ language: "fr" }), { ok: true, settings: { language: "fr" } });
		for (const kind of ["prober", "teacher", "practice"] as const) {
			assert.ok(composeInstructions(kind, {}, "fr").endsWith(languageDirective("fr")));
		}
		assert.match(languageDirective("fr"), /LaTeX/);
	});

	it("sub-agents read a language change on their next run", () => {
		const read = languageSource.current;
		try {
			languageSource.current = () => "fr";
			assert.match(localizedPrompt("base"), /Rédige en français/);
			languageSource.current = () => "en";
			assert.equal(localizedPrompt("base"), "base");
		} finally { languageSource.current = read; }
	});

	it("sanitizer drops an unknown language", () => {
		const rec = sanitizeUserSettings({ version: 1, general: { language: "xx" } })!;
		assert.equal(rec.general?.language, undefined);
	});

	it("PUT parser rejects an unknown language", () => {
		assert.equal(parseGeneralSettingsBody({ language: "xx" }).ok, false);
		assert.deepEqual(parseGeneralSettingsBody({ language: "pt-BR" }), { ok: true, settings: { language: "pt-BR" } });
	});

	it("directive: pt-BR appends, en is a no-op", () => {
		assert.equal(languageDirective("en"), "");
		assert.equal(withLanguage("x", "en"), "x");
		assert.ok(withLanguage("x", "pt-BR").includes("Brazilian Portuguese"));
	});

	it("composition ends with the directive only when asked", () => {
		const plain = composeInstructions("teacher");
		assert.equal(composeInstructions("teacher", {}, "en"), plain);
		assert.ok(composeInstructions("teacher", {}, "pt-BR").endsWith(languageDirective("pt-BR")));
	});
});
