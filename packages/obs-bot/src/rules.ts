export type ObsAction = {
  requestType: string;
  requestData?: Record<string, unknown>;
};

export type ActionRule = {
  id: string;
  pattern: RegExp;
  action: ObsAction;
};

/** Commands are matched only at the start of the message. The model cannot add rules. */
export const DEFAULT_RULES: ActionRule[] = [
  { id: "scene-starting", pattern: /^!starting\b/i, action: { requestType: "SetCurrentProgramScene", requestData: { sceneName: "Starting" } } },
  { id: "scene-live", pattern: /^!live\b/i, action: { requestType: "SetCurrentProgramScene", requestData: { sceneName: "Live" } } },
  { id: "scene-brb", pattern: /^!brb\b/i, action: { requestType: "SetCurrentProgramScene", requestData: { sceneName: "BRB" } } },
  { id: "scene-ending", pattern: /^!ending\b/i, action: { requestType: "SetCurrentProgramScene", requestData: { sceneName: "Ending" } } },
];

export function matchRule(text: string, rules: readonly ActionRule[] = DEFAULT_RULES): ActionRule | undefined {
  const line = text.trim();
  return rules.find((rule) => rule.pattern.test(line));
}
