const INJECTION = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /you\s+are\s+now\b/i,
  /system\s+prompt/i,
  /<\s*\/?\s*system\s*>/i,
  /<\|im_start\|>/i,
  /do\s+not\s+(say|admit)\s+(you\s+are|that\s+you\s+are)\s+a\s+bot/i,
  /reveal\s+(your|the)\s+(prompt|instructions)/i,
];

export type GuardResult = {
  data: string;
  flagged: boolean;
  reasons: string[];
};

/** Chat text is data. It is escaped and wrapped so it cannot close the delimiter or become instructions. */
export function guardChatText(event: { platform: string; user: string; text: string }): GuardResult {
  const reasons: string[] = [];
  for (const pattern of INJECTION) {
    if (pattern.test(event.text)) reasons.push(pattern.source);
  }
  const escaped = event.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const data = `<untrusted_chat platform="${event.platform}" user="${escapeAttr(event.user)}">\n${escaped}\n</untrusted_chat>`;
  return { data, flagged: reasons.length > 0, reasons };
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
