// Talks to the deployed clippy agent (or a canned stand-in with --mock).
//
// Client:   @azure/ai-projects (AIProjectClient), whose getOpenAIClient() returns an
//           OpenAI SDK client for the project's Responses API.
// Endpoint: CLIPPY_ENDPOINT, else the project endpoint that `azd deploy` writes into
//           the azd environment of the project one folder up.
// Auth:     DefaultAzureCredential from @azure/identity (picks up your azd or az login).
//
// Either way the answer is an offer:
//   { offer: boolean, message: "It looks like you're ...", prompt: string, animation: string }

const { execFile } = require('node:child_process');
const path = require('node:path');
const { AIProjectClient } = require('@azure/ai-projects');
const { DefaultAzureCredential } = require('@azure/identity');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ANIMATIONS = ['idle', 'wave', 'think', 'alert', 'celebrate', 'sad'];
const OPENING = "It looks like you're";
const NO_OFFER = { offer: false, message: '', prompt: '', animation: 'idle' };

function run(cmd, args, cwd = PROJECT_ROOT) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// ---------- endpoint ----------

// A prompt agent has no URL of its own. Requests go to the Foundry project's
// Responses API and name the agent in the body (see askAgent). CLIPPY_ENDPOINT may
// be the project endpoint or its .../openai/v1/responses URL.
let targetPromise;

function resolveTarget() {
  targetPromise ??= (async () => {
    const values = {};
    if (!process.env.CLIPPY_ENDPOINT) {
      const out = await run('azd', ['env', 'get-values']);
      for (const line of out.split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
        if (m && m[2]) values[m[1]] = m[2]; // azd writes many of these as empty strings
      }
    }
    const raw =
      process.env.CLIPPY_ENDPOINT ??
      values.AGENT_CLIPPY_PROJECT_ENDPOINT ??
      values.FOUNDRY_PROJECT_ENDPOINT ??
      values.AZURE_AI_PROJECT_ENDPOINT ??
      values.AGENT_CLIPPY_ENDPOINT;
    if (!raw) {
      throw new Error('No project endpoint in the azd environment. Run `azd up` first, or use `npm run mock`.');
    }
    const endpoint = raw.replace(/\/openai\/v1\/responses\/?$/, '').replace(/\/$/, '');
    const name = process.env.CLIPPY_AGENT_NAME ?? values.AGENT_CLIPPY_NAME ?? 'clippy';
    console.log(`[agent] ${name} at ${endpoint}`);
    return { endpoint, name };
  })();
  targetPromise.catch(() => (targetPromise = undefined));
  return targetPromise;
}

// ---------- client ----------

// One OpenAI client for the project. The credential caches and refreshes tokens,
// and the client retries throttling and transient failures with backoff
// (honoring Retry-After) before it throws.
let clientPromise;

function getClient() {
  clientPromise ??= resolveTarget().then(({ endpoint, name }) => {
    const project = new AIProjectClient(endpoint, new DefaultAzureCredential());
    return { openai: project.getOpenAIClient({ timeout: 45_000 }), name };
  });
  clientPromise.catch(() => (clientPromise = undefined));
  return clientPromise;
}

// ---------- reply parsing ----------

const oneLine = (s, max) =>
  (typeof s === 'string' ? s : '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// The agent's strict JSON schema (text.format in its definition) makes the reply
// one JSON object. The schema can't enforce the opening words, so anything that
// is not a well-formed offer is treated as "no offer" rather than shown.
function parseOffer(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return NO_OFFER;
  }
  const message = oneLine(obj.message, 200);
  const prompt = oneLine(obj.prompt, 800);
  const wellFormed = message.toLowerCase().startsWith(OPENING.toLowerCase()) && prompt.length > 0;
  if (!obj.offer || !wellFormed) return NO_OFFER;
  return { offer: true, message, prompt, animation: ANIMATIONS.includes(obj.animation) ? obj.animation : 'wave' };
}

// ---------- real agent ----------

async function askAgent({ text, jpegBase64 }) {
  const { openai, name } = await getClient();
  const content = [{ type: 'input_text', text }];
  if (jpegBase64) content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}`, detail: 'auto' });

  // A prompt agent is addressed by name in the request body. Errors are the
  // OpenAI SDK's APIError subclasses (RateLimitError and friends).
  const response = await openai.responses.create(
    { input: [{ type: 'message', role: 'user', content }] },
    { body: { agent_reference: { type: 'agent_reference', name } } },
  );
  return parseOffer(response.output_text);
}

// ---------- mock agent ----------

const MOCK_OFFERS = [
  {
    message: "It looks like you're building a demo the night before. Would you like help with that?",
    prompt:
      "I'm putting together a short demo of a Microsoft Foundry prompt agent deployed with azd. Help me plan the steps and call out anything likely to go wrong on camera.",
    animation: 'wave',
  },
  {
    message: "It looks like you're editing azure.yaml by trial and error. Want me to check it?",
    prompt:
      "I'm editing the azure.yaml for an azd project with a Foundry prompt agent. Review the file in this folder and explain anything that looks wrong or missing.",
    animation: 'think',
  },
  {
    message: "It looks like you're staring at an error and hoping. Should I help figure out why?",
    prompt:
      "I just hit an error in my terminal while working on an azd project. Help me diagnose it: ask me for the exact error text, then explain the likely cause.",
    animation: 'alert',
  },
];
let mockIndex = 0;

async function askMock() {
  await new Promise((r) => setTimeout(r, 400));
  return { offer: true, ...MOCK_OFFERS[mockIndex++ % MOCK_OFFERS.length] };
}

module.exports = { askAgent, askMock, parseOffer };
