import type { ObsClient } from "../../obs-core/src/client.ts";
import { parseChatEvent, type ChatEvent } from "./events.ts";
import { guardChatText } from "./guard.ts";
import { KillSwitch } from "./killswitch.ts";
import { type LlmProvider, type Persona, systemPrompt } from "./llm.ts";
import { DEFAULT_ACTION_LIMITS, DEFAULT_REPLY_LIMITS, RateLimiter } from "./ratelimit.ts";
import { DEFAULT_RULES, matchRule, type ActionRule, type ObsAction } from "./rules.ts";

export const BOT_DISCLOSURE = "I'm a bot.";

export type OutboundChat = {
  platform: ChatEvent["platform"];
  text: string;
  bot: true;
  disclosure: typeof BOT_DISCLOSURE;
};

export type BotOutcome = {
  stopped: boolean;
  flagged: boolean;
  action?: ObsAction;
  actionSent: boolean;
  rateLimited: boolean;
  outbound?: OutboundChat;
};

export type BotOptions = {
  persona: Persona;
  provider: LlmProvider;
  rules?: readonly ActionRule[];
  client?: ObsClient;
  replyLimits?: RateLimiter;
  actionLimits?: RateLimiter;
  killFile?: string;
  now?: () => number;
};

export class ChatBot {
  readonly killSwitch = new KillSwitch();
  private readonly abort = new AbortController();
  private readonly options: BotOptions;
  private readonly rules: readonly ActionRule[];
  private readonly replyLimits: RateLimiter;
  private readonly actionLimits: RateLimiter;
  private readonly now: () => number;

  constructor(options: BotOptions) {
    this.options = options;
    this.rules = options.rules ?? DEFAULT_RULES;
    this.replyLimits = options.replyLimits ?? new RateLimiter(DEFAULT_REPLY_LIMITS);
    this.actionLimits = options.actionLimits ?? new RateLimiter(DEFAULT_ACTION_LIMITS);
    this.now = options.now ?? Date.now;
    if (options.killFile) this.killSwitch.watchFile(options.killFile);
  }

  kill(): void {
    this.killSwitch.kill(this.now());
    this.abort.abort();
  }

  close(): void {
    this.killSwitch.close();
  }

  async handle(input: unknown): Promise<BotOutcome> {
    if (this.killSwitch.killed || this.abort.signal.aborted) return this.stopped();
    const event = parseChatEvent(input);
    const guard = guardChatText(event);
    let action: ObsAction | undefined;
    let actionSent = false;
    if (event.privileged === true && !guard.flagged) {
      const rule = matchRule(event.text, this.rules);
      if (rule && this.actionLimits.tryTake(event.platform, this.now())) {
        action = rule.action;
        if (this.killSwitch.killed) return this.stopped(guard.flagged);
        if (this.options.client) {
          await this.options.client.request(rule.action.requestType, rule.action.requestData);
          actionSent = true;
        }
      }
    }
    if (this.killSwitch.killed) return this.stopped(guard.flagged);
    if (!this.replyLimits.tryTake(event.platform, this.now())) {
      return { stopped: false, flagged: guard.flagged, action, actionSent, rateLimited: true };
    }
    let reply: string;
    try {
      const completed = await this.options.provider.complete({
        persona: this.options.persona,
        event,
        untrustedData: guard.data,
        flagged: guard.flagged,
      }, this.abort.signal);
      reply = completed.text;
    } catch (error) {
      if (this.killSwitch.killed || this.abort.signal.aborted) return this.stopped(guard.flagged);
      throw error;
    }
    if (this.killSwitch.killed) return this.stopped(guard.flagged);
    return {
      stopped: false,
      flagged: guard.flagged,
      action,
      actionSent,
      rateLimited: false,
      outbound: disclose(event.platform, reply),
    };
  }

  private stopped(flagged = false): BotOutcome {
    return { stopped: true, flagged, actionSent: false, rateLimited: false };
  }
}

export function disclose(platform: ChatEvent["platform"], text: string): OutboundChat {
  const body = text.trim();
  const withMark = body.startsWith("[bot]") ? body : `[bot] ${body}`;
  const disclosed = withMark.includes(BOT_DISCLOSURE) ? withMark : `${withMark} ${BOT_DISCLOSURE}`;
  return { platform, text: disclosed, bot: true, disclosure: BOT_DISCLOSURE };
}

export function personaPrompt(persona: Persona): string {
  return systemPrompt(persona);
}
