import type { ChatOptions, ProjectContext, Provider } from "../providers/types.js";

/**
 * Anthropic Contextual Retrieval — Phase-11 indexing-time augmentation.
 *
 * Per Anthropic's published CR pattern (anthropic.com/news/contextual-retrieval),
 * prepending ~50–100 tokens of LLM-generated context to each chunk
 * before BM25 indexing lifts retrieval recall by 35–67% on indirect-term
 * queries — those where the chunk doesn't literally contain the search
 * term but the surrounding page does ("the third quarter" matches a
 * chunk that reads "Q3 revenue grew 12%" only because the surrounding
 * page establishes the date frame).
 *
 * This helper is the call-site for that augmentation. Given a chat
 * provider, the source page, and a chunk's body, it returns the context
 * paragraph the indexer persists into `chunk_contexts`. The source page
 * is sent as a prompt-cache prefix so repeated calls against the same
 * page (one per chunk) re-use the cached input tokens at ~10× discount.
 *
 * Failure-mode contract: this helper never throws. Provider errors,
 * timeouts, malformed responses → empty string return. The caller
 * checks for non-empty before persisting; an empty context just means
 * the chunk stays uncontextualised and gets retried on the next
 * worker tick. Crashing the worker on a transient provider error
 * would block every other chunk in the backlog.
 *
 * See docs/04-ai-and-agents.md §Retrieval pipeline → Phase-4 stages.
 */

/** Hard cap on the chat round-trip. CR is a background task — a slow
 *  Haiku response shouldn't tie up worker capacity that other ticks
 *  could be using to drain the backlog. 5 s comfortably covers a
 *  typical Haiku latency (1-2 s) plus prompt-cache hydration on a
 *  fresh page. */
const TIMEOUT_MS = 5_000;

/** Default model. Haiku tier is the sweet spot for CR: it produces
 *  serviceable summaries at ~1/15th the cost of Opus. Callers may
 *  override via `opts.model` for benchmarking. */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Hard-cap on the source-page prefix. A 100k-token novel as the
 * prompt-cache key is wasteful — CR only needs enough context that
 * the chunk's role in the page is clear. The trim is on a character
 * budget rather than tokens because we can't tokenise locally.
 */
const MAX_SOURCE_CHARS = 40_000;

/**
 * The instruction half of the system prompt. Kept identical to
 * Anthropic's published CR template so the cached prefix shape is
 * stable across model revisions.
 */
const CR_INSTRUCTIONS = `
You are summarising a chunk of a longer document so the summary can be
prepended to the chunk's BM25 index entry. Your output is concatenated
verbatim with the chunk text — no preamble, no headers, no quoting, no
bullets. Plain prose only.

Output 50–100 words covering, in order:
  1. The chunk's role in the surrounding document (e.g. "introduces the
     comparison framework", "lists the third option's failure modes").
  2. Subjects/topics the chunk discusses but identifies only by pronoun
     or shorthand whose referent lives elsewhere on the page.
  3. Time/place/actor anchors established earlier on the page that the
     chunk implicitly relies on.

Do not quote the chunk. Do not repeat the chunk's literal sentences.
Write as a self-contained paragraph that adds *context* the chunk lacks
on its own.
`.trim();

export interface GenerateChunkContextInput {
  /** Source page markdown — full body, used as the prompt-cache prefix. */
  sourcePage: string;
  /** Chunk body — appears as the user message. */
  chunkText: string;
  /** Override the default Haiku-tier model. */
  model?: string;
  /** Override the default 5 s timeout (ms). */
  timeoutMs?: number;
}

/**
 * Run the CR prompt against a chat provider and return the resulting
 * context string. Empty string on any failure; never throws.
 */
export async function generateChunkContext(
  provider: Provider,
  ctx: ProjectContext,
  input: GenerateChunkContextInput,
): Promise<string> {
  const model = input.model ?? DEFAULT_MODEL;
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;

  const trimmedSource =
    input.sourcePage.length > MAX_SOURCE_CHARS
      ? `${input.sourcePage.slice(0, MAX_SOURCE_CHARS)}\n\n[…page truncated for context-prefix budget]`
      : input.sourcePage;

  const opts: ChatOptions = {
    model,
    // Anthropic's CR prompt structure: instructions + page in the
    // system block (cacheable across all chunks of a page); the chunk
    // itself is the variable user input. `cacheSystemPrompt` only
    // takes effect on providers that advertise prompt caching, so on
    // Ollama this is a no-op rather than an error.
    systemPrompt: `${CR_INSTRUCTIONS}\n\n--- Source document begins ---\n${trimmedSource}\n--- Source document ends ---`,
    messages: [
      {
        role: "user",
        content: `Here is the chunk to contextualise. Output only the context paragraph.\n\n<chunk>\n${input.chunkText}\n</chunk>`,
      },
    ],
    maxTokens: 256,
    temperature: 0,
    cacheSystemPrompt: provider.supportsPromptCache,
  };

  try {
    return await withTimeout(consumeChat(provider, opts, ctx), timeoutMs);
  } catch {
    return "";
  }
}

async function consumeChat(
  provider: Provider,
  opts: ChatOptions,
  ctx: ProjectContext,
): Promise<string> {
  let text = "";
  for await (const event of provider.chat(opts, ctx)) {
    if (event.type === "text") text += event.text;
    else if (event.type === "error") return "";
    else if (event.type === "done") break;
  }
  return text.trim();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`generateChunkContext timed out after ${ms}ms`)), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
