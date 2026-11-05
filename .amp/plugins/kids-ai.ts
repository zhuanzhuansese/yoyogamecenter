// AI for 佑佑的游戏屋: a tiny local HTTP service the game house server forwards /api/health and
// /api/chat to, so the games talk through Amp's AI instead of a browser-side API key.
//
//   GET  /health -> { amp: true, model }
//   POST /chat { system, prompt } -> the JSON object the model answered with
import http from 'node:http'
import type { PluginAPI } from '@ampcode/plugin'

export const description = '佑佑的游戏屋 AI：在 orb 的 127.0.0.1:8790 提供 /health 和 /chat，游戏里的对话和语音纠错通过 amp.ai.generate 回答。'

const PORT = 8790
const MODEL = 'openai/gpt-6.1-terra' // fast enough for a 5-year-old waiting on a reply, good at Chinese

function readJSON(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		let body = ''
		req.on('data', (chunk) => {
			body += chunk
			if (body.length > 100_000) reject(new Error('too large'))
		})
		req.on('end', () => {
			try {
				resolve(JSON.parse(body))
			} catch (e) {
				reject(e)
			}
		})
	})
}

// Models sometimes wrap the JSON in ``` fences or add a word around it.
function parseObject(text: string): Record<string, unknown> | null {
	const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
	try {
		return JSON.parse(t)
	} catch {
		const m = t.match(/\{[\s\S]*\}/)
		try {
			return m ? JSON.parse(m[0]) : null
		} catch {
			return null
		}
	}
}

export default function (amp: PluginAPI) {
	const threadID = process.env.AMP_THREAD_ID as `T-${string}` | undefined
	const send = (res: http.ServerResponse, status: number, data: unknown) => {
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
		res.end(JSON.stringify(data))
	}

	const server = http.createServer(async (req, res) => {
		try {
			if (req.url === '/health') return send(res, 200, { amp: true, model: MODEL })
			if (req.url === '/chat' && req.method === 'POST') {
				const { system, prompt } = await readJSON(req)
				if (typeof prompt !== 'string' || !prompt) return send(res, 400, { error: 'prompt required' })
				const started = Date.now()
				const text = await amp.ai.generate({ threadID, model: MODEL, system: typeof system === 'string' ? system : undefined, prompt, maxTokens: 400 })
				const obj = parseObject(text)
				amp.logger.log(`chat ${Date.now() - started}ms ${obj ? 'ok' : 'unparsed'}`)
				return obj ? send(res, 200, obj) : send(res, 502, { error: 'model did not answer with JSON', text })
			}
			send(res, 404, { error: 'not found' })
		} catch (e) {
			amp.logger.log(`chat failed: ${e instanceof Error ? e.message : e}`)
			send(res, 500, { error: 'AI request failed' })
		}
	})
	server.on('error', (e) => amp.logger.log(`kids-ai server error: ${e.message}`))
	server.listen(PORT, '127.0.0.1')
	amp.onDispose(() => new Promise<void>((resolve) => server.close(() => resolve())))
}
