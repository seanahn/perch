'use strict';
// Codex on Amazon Bedrock. Codex 0.159 has a Bedrock provider of its own, in two forms: `amazon-bedrock`, the Bedrock
// Mantle endpoint (https://bedrock-mantle.<region>.api.aws/openai/v1), and `amazon-bedrock-runtime`, the Bedrock runtime's
// OpenAI-compatible endpoint (https://bedrock-runtime.<region>.amazonaws.com/openai/v1). Both sign with the AWS
// credentials Claude Code on Bedrock uses (a profile, AWS_* variables, or AWS_BEARER_TOKEN_BEDROCK). Perch tells Codex
// which, and where, as --config overrides per process; nothing is written to ~/.codex/config.toml. No VS Code dependency.

const PROVIDERS = { mantle: 'amazon-bedrock', runtime: 'amazon-bedrock-runtime' };

// The runtime endpoint is the default: it is in every Bedrock region, it takes the bedrock:* actions a machine on Claude-on-
// Bedrock already has, and with the connector apps off (bedrockConfig) it is the leaner of the two (measured 2026-10-06,
// one-line prompt, GPT-6 Luna: 7.9 K input tokens a request against Mantle's 9.2 K). Mantle wants its own IAM action
// (bedrock-mantle:CreateInference) and is not in every region (us-west-2 answered 404 for every model); us-east-1 has it.
const MANTLE_REGION = 'us-east-1';

/**
 * How Codex is to reach Bedrock: the endpoint, the region, and the AWS profile. From perch's settings when set; the region
 * and profile otherwise from the environment and from the env block of Claude Code's settings, where a machine set up for
 * Claude on Bedrock already has them (AWS_REGION, AWS_PROFILE).
 * @param {{ cfg?: (key: string) => any, env?: object, claudeEnv?: object }} o
 * @returns {{ endpoint: 'runtime'|'mantle', provider: string, region: string, profile: string }}
 */
function bedrockSettings({ cfg = () => undefined, env = {}, claudeEnv = {} } = {}) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const endpoint = str(cfg('codex.bedrock.endpoint')) === 'mantle' ? 'mantle' : 'runtime';
  const inherited = str(env.AWS_REGION) || str(claudeEnv.AWS_REGION) || str(env.AWS_DEFAULT_REGION);
  const region = str(cfg('codex.bedrock.region')) || (endpoint === 'mantle' ? MANTLE_REGION : inherited || MANTLE_REGION);
  const profile = str(cfg('codex.bedrock.profile')) || str(env.AWS_PROFILE) || str(claudeEnv.AWS_PROFILE);
  return { endpoint, provider: PROVIDERS[endpoint], region, profile };
}

/**
 * The `--config` overrides the Codex SDK passes to each process, for these settings. The ChatGPT connector apps
 * (`features.apps`: Gmail, Calendar, ChatGPT spaces and the rest) are turned off: they are features of a ChatGPT account
 * and cannot work on Bedrock, and for a model Codex's catalog does not know by its cross-region id (`us.openai.…`, the
 * runtime endpoint's form) Codex sends every one of their schemas in full with each request, about 190 KB (measured
 * 2026-10-06: 236 KB a request with them, 44 KB without; Mantle with its recognised id, 51 KB).
 */
function bedrockConfig(s) {
  const aws = { region: s.region };
  if (s.profile) aws.profile = s.profile;
  return { model_provider: s.provider, model_providers: { [s.provider]: { aws } }, features: { apps: false } };
}

/**
 * The Bedrock id of a Codex model: `openai.<slug>` on Mantle; `us.openai.<slug>` on the runtime endpoint, where on-demand
 * throughput wants a cross-region inference profile (`openai.gpt-6-luna` alone is refused there). A name already in
 * Bedrock's form is sent as it is, so a user can give one of their own.
 */
function bedrockModel(slug, endpoint) {
  const s = typeof slug === 'string' ? slug.trim() : '';
  if (!s) return undefined;
  if (/^([a-z-]+\.)?openai\./.test(s)) return s;
  return (endpoint === 'runtime' ? 'us.' : '') + 'openai.' + s;
}

module.exports = { PROVIDERS, MANTLE_REGION, bedrockSettings, bedrockConfig, bedrockModel };
