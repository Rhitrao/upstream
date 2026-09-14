import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { filtersFrom, handleAsk, SYSTEM, type CreateMessage } from '../src/ask';
import { ASK_SCRIPT, LIST_SCRIPT } from '../src/page';

const ORIGIN = 'https://rohitrao.in';
const KEY = 'test-ingest-key';

/** The box turned on, with a key, for the tests that exercise it. The shipped state is off. */
const on = { ...env, ASK_ENABLED: '1', ANTHROPIC_API_KEY: 'test-not-a-key' } as Env;

async function post(body: unknown) {
	return SELF.fetch(`${ORIGIN}/upstream/api/ingest`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-Ingest-Key': KEY },
		body: JSON.stringify(body),
	});
}

function ask(question: string, ip = '203.0.113.7') {
	return new Request(`${ORIGIN}/upstream/api/ask`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
		body: JSON.stringify({ question }),
	});
}

function message(content: Anthropic.ContentBlock[], usage: { input: number; output: number }, stop: Anthropic.Message['stop_reason']): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-4-5',
		content,
		stop_reason: stop,
		stop_sequence: null,
		usage: { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
	} as unknown as Anthropic.Message;
}

/** A model that asks for one view and then answers, recording what it was sent. */
function scripted(toolInput: Record<string, unknown>, text: string) {
	const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
	const create: CreateMessage = async (params) => {
		sent.push(JSON.parse(JSON.stringify(params)));
		if (sent.length === 1) {
			return message([{ type: 'tool_use', id: 'toolu_1', name: 'find_companies', input: toolInput } as Anthropic.ContentBlock], { input: 1000, output: 50 }, 'tool_use');
		}
		return message([{ type: 'text', text, citations: null } as Anthropic.ContentBlock], { input: 2000, output: 100 }, 'end_turn');
	};
	return { create, sent };
}

async function clear() {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM signals'),
		env.DB.prepare('DELETE FROM companies'),
		env.DB.prepare('DELETE FROM runs'),
		env.DB.prepare('DELETE FROM gaps'),
		env.DB.prepare('DELETE FROM ask_log'),
		env.DB.prepare('DELETE FROM ask_settings'),
	]);
}

async function seed() {
	// Six companies in AI in Healthcare on the words "AI / NLP" was the real case.
	await post({
		source: 'dpiit-startup-india',
		companies: ['zelbyx', 'cafiyn'].map((id) => ({
			id,
			name: id.toUpperCase(),
			sector_id: '3',
			subsector_id: '3.2',
			classify_basis: 'register-label',
			description: 'DPIIT-recognised startup. Industry: AI. Sector: NLP. Stage: Prototype.',
			state: 'Karnataka',
		})),
	});
	await post({
		source: 'sine-iitb',
		companies: [{ id: 'kadamb', name: 'Kadamb', sector_id: '3', subsector_id: '3.2', description: 'Assay kits read by a phone camera.' }],
	});
}

beforeEach(clear);

describe('the question box, shipped off', () => {
	it('is a 404 and is not drawn until someone turns it on', async () => {
		const res = await SELF.fetch(`${ORIGIN}/upstream/api/ask`, { method: 'POST', body: '{"question":"hi"}' });
		expect(res.status).toBe(404);
		expect(await (await SELF.fetch(`${ORIGIN}/upstream`)).text()).not.toContain('id="ask"');
	});

	it('ships scripts that parse', () => {
		expect(() => new Function(ASK_SCRIPT)).not.toThrow();
		expect(() => new Function(LIST_SCRIPT)).not.toThrow();
	});
});

describe('answering from the records', () => {
	it('answers through one filtered query, with the evidence basis written by the server', async () => {
		await seed();
		const model = scripted({ subsector: '3.2' }, 'Three records are in AI in Healthcare; two were placed from a register label only.');
		const result = await handleAsk(ask('Which companies do AI in healthcare?'), on, model.create);

		expect(result.status).toBe('answered');
		if (result.status !== 'answered') return;
		expect(result.evidence.count).toBe(3);
		// The guess travels with the answer, whatever the model chose to say.
		expect(result.evidence.summary).toContain('2 of 3 were placed in a sub-sector from a DPIIT register dropdown label alone, which is a guess');
		expect(result.evidence.view_url).toBe('/upstream?sector=3&subsector=3.2&tier=all&age=all&sort=quietest');

		// Two calls, the second unable to call a tool, and the question only ever in a user turn.
		expect(model.sent).toHaveLength(2);
		expect(model.sent[1].tool_choice).toEqual({ type: 'none' });
		expect(model.sent[0].system).toBe(SYSTEM);
		expect(JSON.stringify(model.sent[1].messages)).toContain('register label only');
		expect(model.sent[1].max_tokens).toBeLessThanOrEqual(220);

		const row = await env.DB.prepare('SELECT status, question, input_tokens, output_tokens, cost_usd FROM ask_log').first<any>();
		expect(row).toMatchObject({ status: 'answered', question: 'Which companies do AI in healthcare?', input_tokens: 3000, output_tokens: 150 });
		// $1 and $5 per million: 3,000 in and 150 out.
		expect(row.cost_usd).toBeCloseTo(0.00375, 8);
	});

	it('drops any argument the page does not have a list for', () => {
		const f = filtersFrom({ subsector: '3.2', tier: 'C', traces: 'lots', search: 'x'.repeat(200), sql: 'DROP TABLE companies' });
		expect(f).toMatchObject({ sector: '3', subsector: '3.2', tiers: null, traces: null, dated: null });
		expect(f.search).toHaveLength(60);
		expect(Object.keys(f)).not.toContain('sql');
	});
});

describe('spending', () => {
	it('rests on examples at five questions an hour from one visitor, and calls nothing', async () => {
		await seed();
		const now = new Date();
		for (let i = 0; i < 5; i++) {
			const model = scripted({ subsector: '3.2' }, 'ok');
			expect((await handleAsk(ask(`q${i}`), on, model.create, now)).status).toBe('answered');
		}
		let called = false;
		const result = await handleAsk(ask('one more'), on, async () => ((called = true), Promise.reject(new Error('unreachable'))), now);
		expect(called).toBe(false);
		expect(result).toMatchObject({ status: 'resting', reason: 'rate' });
		if (result.status !== 'resting') return;
		expect(result.examples).toHaveLength(4);
		expect(result.examples[0].answer).toBe('3 records are placed in 3.2 AI in Healthcare; 2 of them from a register label alone.');

		// Another visitor is not held to the first one's hour.
		expect((await handleAsk(ask('mine', '198.51.100.2'), on, scripted({}, 'ok').create, now)).status).toBe('answered');
	});

	it('reserves the most a question can cost before calling, and rests at the daily cap', async () => {
		await seed();
		await env.DB.prepare("INSERT INTO ask_settings (key, value) VALUES ('daily_cap_usd', ?1)").bind('0.01').run();
		// $0.01: the first question's $0.009 reservation fits; after it settles at $0.00375,
		// a second reservation would take the day to $0.01275.
		expect((await handleAsk(ask('first'), on, scripted({ subsector: '3.2' }, 'ok').create)).status).toBe('answered');

		let called = false;
		const result = await handleAsk(ask('second', '198.51.100.9'), on, async () => ((called = true), Promise.reject(new Error('unreachable'))));
		expect(called).toBe(false);
		expect(result).toMatchObject({ status: 'resting', reason: 'cap' });
		const rows = await env.DB.prepare('SELECT status, cost_usd FROM ask_log ORDER BY id').all<any>();
		expect(rows.results.map((r) => r.status)).toEqual(['answered', 'resting-cap']);
		expect(rows.results[1].cost_usd).toBe(0);
	});

	it('rests rather than erroring when the model fails, and counts what was already spent', async () => {
		await seed();
		let calls = 0;
		const create: CreateMessage = async () => {
			calls += 1;
			if (calls === 1) return message([{ type: 'tool_use', id: 't', name: 'find_companies', input: {} } as Anthropic.ContentBlock], { input: 1000, output: 40 }, 'tool_use');
			throw new Error('overloaded');
		};
		const result = await handleAsk(ask('anything'), on, create);
		expect(result).toMatchObject({ status: 'resting', reason: 'error' });
		const row = await env.DB.prepare('SELECT status, cost_usd FROM ask_log').first<any>();
		expect(row.status).toBe('error');
		expect(row.cost_usd).toBeCloseTo(0.0012, 8);
	});

	it('rests with no key, and in rest mode, logging the question and calling nothing', async () => {
		await seed();
		const noKey = { ...env, ASK_ENABLED: '1' } as Env;
		expect(await handleAsk(ask('no key'), noKey)).toMatchObject({ status: 'resting', reason: 'off' });
		const resting = { ...env, ASK_ENABLED: 'rest' } as Env;
		expect(await handleAsk(ask('resting'), resting)).toMatchObject({ status: 'resting', reason: 'off' });
		const rows = await env.DB.prepare('SELECT question, status FROM ask_log ORDER BY id').all<any>();
		expect(rows.results).toEqual([
			{ question: 'no key', status: 'resting-off' },
			{ question: 'resting', status: 'resting-off' },
		]);
	});

	it('refuses an empty or overlong question without logging it as spend', async () => {
		expect(await handleAsk(ask('   '), on, scripted({}, 'x').create)).toMatchObject({ status: 'invalid' });
		expect(await handleAsk(ask('x'.repeat(301)), on, scripted({}, 'x').create)).toMatchObject({ status: 'invalid' });
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM ask_log').first<any>()).n).toBe(0);
	});
});
