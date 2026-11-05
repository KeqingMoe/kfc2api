import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Response, ResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses';
import MODELS_RAW from '../data/models.json';

type ModelList = { object: string; data: { id: string }[] };
type Env = { ASSETS: { fetch(request: Request): Promise<any> } };

const TEXT = '疯狂星期四，V我50';
const POSTER = 'poster.webp';
const MODELS: ModelList = MODELS_RAW;
const DEFAULT_MODEL = MODELS.data[0]!.id;
const id = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const fail = (status: number, message: string) =>
  json({ error: { message, type: 'invalid_request_error', code: status } }, status);

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        ...CORS,
      },
    },
  );

const reply = (request: Request) => `${TEXT}\n\n![${TEXT}](${new URL(request.url).origin}/${POSTER})`;
const tokens = (x: unknown) => Math.max(1, Math.round(String(x).length / 1.5));

async function parse(request: Request) {
  try {
    return (await request.json()) as Record<string, any>;
  } catch {
    return undefined;
  }
}

async function chat(request: Request, text: string) {
  const body = await parse(request);
  if (body === undefined) return fail(400, 'invalid JSON body');
  if (!Array.isArray(body.messages)) return fail(400, 'messages is required');

  const cid = id('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? DEFAULT_MODEL;
  const prompt_tokens = tokens(JSON.stringify(body.messages));
  const completion_tokens = tokens(text);
  const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };

  if (!body.stream) {
    const res: ChatCompletion = {
      id: cid,
      object: 'chat.completion',
      created,
      model,
      choices: [
        { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: text, refusal: null } },
      ],
      usage,
    };
    return json(res);
  }

  const chunk = (delta: ChatCompletionChunk.Choice.Delta, finish: 'stop' | null): ChatCompletionChunk => ({
    id: cid,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });

  const frames = [
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content: text }, null),
    chunk({}, 'stop'),
    ...(body.stream_options?.include_usage ? [{ ...chunk({}, null), choices: [], usage }] : []),
  ];
  return sse([...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n']);
}

async function responses(request: Request, text: string) {
  const body = await parse(request);
  if (body === undefined) return fail(400, 'invalid JSON body');
  const input_tokens = tokens(JSON.stringify(body.input));
  const output_tokens = tokens(text);
  const usage: ResponseUsage = {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const item: ResponseOutputItem = {
    id: id('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response: Response = {
    id: id('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: (body.model ?? DEFAULT_MODEL) as Response['model'],
    output: [item],
    usage,
    output_text: text,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'none',
    tools: [],
    top_p: null,
    access_programs: null,
  };

  if (!body.stream) return json(response);

  const part = item.content[0]!;
  const at = { item_id: item.id, output_index: 0, content_index: 0 };
  const frames = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', ...at, part },
    { type: 'response.output_text.delta', ...at, delta: text },
    { type: 'response.output_text.done', ...at, text },
    { type: 'response.content_part.done', ...at, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return sse(frames.map((f, i) => `event: ${f.type}\ndata: ${JSON.stringify({ ...f, sequence_number: i })}\n\n`));
}

export default {
  async fetch(request: Request, env: Env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (method === 'GET' && pathname === '/v1/models') return json(MODELS);
    if (method === 'GET' && pathname.startsWith('/v1/models/')) {
      const mid = decodeURIComponent(pathname.slice('/v1/models/'.length));
      const hit = MODELS.data.find((m) => m.id === mid);
      return hit ? json(hit) : fail(404, `model ${mid} not found`);
    }
    if (pathname === '/v1/chat/completions' || pathname === '/v1/responses') {
      if (method !== 'POST') return fail(405, 'method not allowed');
      const text = reply(request);
      return pathname === '/v1/responses' ? responses(request, text) : chat(request, text);
    }
    if (pathname === '/healthz') return json({ ok: true });
    if (pathname.startsWith('/v1/')) return fail(404, `unknown endpoint ${pathname}`);

    const asset = await env.ASSETS.fetch(request);
    return asset.ok ? asset : fail(404, `no such route ${pathname}`);
  },
};
