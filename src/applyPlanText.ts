// The change plan (src/applyPlan.ts) in words, for a terminal: `provision
// --plan`, and the header of `print-uci-commands`. The UI shows the same plan
// (ui/src/provision/Review.tsx).
import { ApplyPlan, needWords, sourceTags } from "./applyPlan";

const indent = (n: number, text: string) => `${" ".repeat(n)}${text}`;

/** The plan as text: its verdict and what to acknowledge, then (`items`) each change with its effects and (`lines`) its uci lines. */
export const planText = (plan: ApplyPlan, { items = true, lines = true }: { items?: boolean; lines?: boolean } = {}) =>
  [
    plan.summary.verdict,
    ...(plan.summary.blocked ? [plan.summary.blocked] : []),
    ...plan.unread.map((u) => `Not read: ${u.device}: ${u.error}`),
    ...(plan.needs.length ? ["", "To know first:", ...plan.needs.map((need) => indent(2, `- ${needWords(need)}`))] : []),
    ...(items
      ? plan.items.flatMap((item) => [
          "",
          `[${sourceTags[item.source]}] ${item.title}${item.change ? `: ${item.change}` : ""}`,
          ...(item.why ? [indent(2, item.why)] : []),
          ...item.effect.notices.map((notice) => indent(2, `• ${notice}`)),
          ...(lines
            ? item.lines.flatMap((d) => [
                indent(2, d.device),
                ...d.groups.flatMap((g) => [indent(4, `${g.title} · ${g.lines.length}`), ...g.lines.map((l) => indent(6, `${l.sign} ${l.text}`))]),
              ])
            : []),
        ])
      : []),
  ].join("\n");
